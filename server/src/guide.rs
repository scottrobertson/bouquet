//! The in-app guide: a playlist's channels with their programmes, built from
//! the same resolved channel list the M3U and EPG use.

use std::collections::{BTreeSet, HashMap, HashSet};

use anyhow::Result;
use rusqlite::{Connection, params_from_iter};
use serde::Serialize;
use ts_rs::TS;

use crate::db::{ID_CHUNK, id_array, placeholders};
use crate::models::Playlist;
use crate::output::resolve::resolve_playlist_channels;

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GuideProgramme {
    // Milliseconds, so the grid's maths can use them directly.
    pub start_ms: i64,
    pub stop_ms: i64,
    pub title: Option<String>,
    pub sub_title: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GuideChannel {
    pub display_name: String,
    pub logo: String,
    pub tvg_id: String,
    pub catchup_days: i64,
    pub stream_url: String,
    // The timeshift URL template, empty when the channel has no catchup. The
    // guide fills it in per programme to replay a past show.
    pub catchup_source: String,
    pub programmes: Vec<GuideProgramme>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct GuideCategory {
    pub name: String,
    pub channels: Vec<GuideChannel>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GuideSource {
    pub id: i64,
    pub name: String,
    pub epg_stale: bool,
    // Milliseconds.
    pub last_synced_at: Option<i64>,
}

pub struct Guide {
    pub playlist: Playlist,
    pub categories: Vec<GuideCategory>,
    // The sources behind the playlist's channels, for the "needs a sync" nudge.
    pub sources: Vec<GuideSource>,
}

/// Make a channel's programmes one clean lane. EPG data sometimes has
/// overlapping or duplicate entries, which the grid would draw on top of each
/// other. Each programme's end is trimmed to where the next starts, and ones
/// squeezed to nothing are dropped. Start times stay as they are, since that's
/// what people read off a guide.
pub fn resolve_overlaps(mut programmes: Vec<GuideProgramme>) -> Vec<GuideProgramme> {
    // Earliest first; for equal starts the longer one comes first and survives.
    programmes.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then(b.stop_ms.cmp(&a.stop_ms)));
    let mut kept: Vec<GuideProgramme> = Vec::new();
    let mut max_stop = i64::MIN;
    for p in programmes {
        // Ends inside one already kept: a duplicate or nested entry.
        if p.stop_ms <= max_stop {
            continue;
        }
        max_stop = p.stop_ms;
        kept.push(p);
    }
    for i in 0..kept.len().saturating_sub(1) {
        let next_start = kept[i + 1].start_ms;
        if next_start < kept[i].stop_ms {
            kept[i].stop_ms = next_start;
        }
    }
    kept
}

/// A playlist's guide over [from_ts, to_ts) in unix seconds: channels in
/// output order, grouped by category, each with the programmes overlapping
/// the window.
pub fn playlist_guide(conn: &Connection, playlist_id: i64, from_ts: i64, to_ts: i64) -> Result<Option<Guide>> {
    let Some(playlist) = Playlist::by_id(conn, playlist_id)? else { return Ok(None) };
    let channels = resolve_playlist_channels(conn, &playlist)?;

    let mut source_order: Vec<i64> = Vec::new();
    let mut ids_by_source: HashMap<i64, (Vec<String>, HashSet<String>)> = HashMap::new();
    for c in channels.iter().filter(|c| !c.tvg_id.is_empty()) {
        let entry = ids_by_source.entry(c.epg_source_id).or_insert_with(|| {
            source_order.push(c.epg_source_id);
            Default::default()
        });
        if entry.1.insert(c.tvg_id.clone()) {
            entry.0.push(c.tvg_id.clone());
        }
    }

    // Keyed by (EPG source, channel id), so a channel maps to its own source's guide.
    let mut by_channel: HashMap<(i64, String), Vec<GuideProgramme>> = HashMap::new();
    for source_id in source_order {
        for chunk in ids_by_source[&source_id].0.chunks(ID_CHUNK) {
            let mut args: Vec<rusqlite::types::Value> = vec![source_id.into()];
            args.extend(chunk.iter().map(|s| s.clone().into()));
            args.push(to_ts.into());
            args.push(from_ts.into());
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT channel_id, start_ts, stop_ts, title, sub_title, description, category FROM epg_programmes \
                 WHERE source_id = ? AND channel_id IN ({}) AND start_ts < ? AND stop_ts > ? ORDER BY channel_id, start_ts",
                placeholders(chunk.len())
            ))?;
            let rows = stmt.query_map(params_from_iter(args), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    GuideProgramme {
                        start_ms: r.get::<_, i64>(1)? * 1000,
                        stop_ms: r.get::<_, i64>(2)? * 1000,
                        title: r.get(3)?,
                        sub_title: r.get(4)?,
                        description: r.get(5)?,
                        category: r.get(6)?,
                    },
                ))
            })?;
            for row in rows {
                let (channel_id, p) = row?;
                by_channel.entry((source_id, channel_id)).or_default().push(p);
            }
        }
    }

    // Channels are already in output order, so categories keep first-seen order.
    let mut categories: Vec<GuideCategory> = Vec::new();
    for c in &channels {
        let programmes = if c.tvg_id.is_empty() {
            vec![]
        } else {
            resolve_overlaps(by_channel.remove(&(c.epg_source_id, c.tvg_id.clone())).unwrap_or_default())
        };
        let channel = GuideChannel {
            display_name: c.display_name.clone(),
            logo: c.logo.clone(),
            tvg_id: c.tvg_id.clone(),
            catchup_days: c.catchup_days,
            stream_url: c.stream_url.clone(),
            catchup_source: c.catchup_source.clone(),
            programmes,
        };
        match categories.iter_mut().find(|cat| cat.name == c.group_title) {
            Some(cat) => cat.channels.push(channel),
            None => categories.push(GuideCategory { name: c.group_title.clone(), channels: vec![channel] }),
        }
    }

    let source_ids: BTreeSet<i64> = channels.iter().map(|c| c.epg_source_id).collect();
    let mut stmt = conn.prepare("SELECT id, name, epg_stale, last_synced_at FROM sources WHERE id IN rarray(?) ORDER BY id")?;
    let sources = stmt
        .query_map([id_array(source_ids)], |r| {
            Ok(GuideSource {
                id: r.get(0)?,
                name: r.get(1)?,
                epg_stale: r.get(2)?,
                last_synced_at: r.get::<_, Option<i64>>(3)?.map(|s| s * 1000),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(Guide { playlist, categories, sources }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prog(start: i64, stop: i64, title: &str) -> GuideProgramme {
        GuideProgramme { start_ms: start, stop_ms: stop, title: Some(title.into()), sub_title: None, description: None, category: None }
    }

    #[test]
    fn overlaps() {
        assert_eq!(resolve_overlaps(vec![prog(0, 100, "x"), prog(100, 200, "x")]), [prog(0, 100, "x"), prog(100, 200, "x")]);
        assert_eq!(resolve_overlaps(vec![prog(0, 150, "x"), prog(100, 200, "x")]), [prog(0, 100, "x"), prog(100, 200, "x")]);
        let dupes = resolve_overlaps(vec![prog(0, 100, "a"), prog(0, 100, "b")]);
        assert_eq!(dupes.len(), 1);
        assert_eq!((dupes[0].start_ms, dupes[0].stop_ms), (0, 100));
        assert_eq!(resolve_overlaps(vec![prog(0, 100, "short"), prog(0, 200, "long")]), [prog(0, 200, "long")]);
        assert_eq!(resolve_overlaps(vec![prog(0, 300, "long"), prog(50, 100, "inner")]), [prog(0, 300, "long")]);
        assert_eq!(resolve_overlaps(vec![prog(200, 300, "x"), prog(0, 100, "x")]), [prog(0, 100, "x"), prog(200, 300, "x")]);
    }
}
