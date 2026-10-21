//! What the playlist editor reads: the playlist's own channels, the source
//! browser, and the EPG picker.

use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params_from_iter};
use serde::Serialize;
use ts_rs::TS;

use crate::alt_name::alt_name;
use crate::epg_logo::{EpgLogoRef, EpgLogos};
use crate::routes::api::{iso_opt, kinds};
use crate::smart_sort::{SmartSortConfig, SmartSortStream, factors_for, needs_smart_sort, smart_sort_order, steady};
use crate::xtream::{Creds, build_stream_url};

// The source browser is virtualised, so this only bounds the payload, not
// what gets drawn. High enough to cover a whole provider in one fetch.
pub const BROWSER_LIMIT: i64 = 5000;

fn stream_url(server_url: String, stream_base_url: Option<String>, username: String, password: String, stream_id: &str, format: &str) -> String {
    build_stream_url(&Creds { server_url: stream_base_url.unwrap_or(server_url), username, password }, stream_id, format)
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditorCategoryAuto {
    pub source_id: i64,
    pub source_name: String,
    pub category_name: String,
    pub enabled: bool,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct EditorCategory {
    pub id: i64,
    pub name: String,
    pub auto: Option<EditorCategoryAuto>,
}

/// A playlist's categories in display order. Auto-sync groups carry the
/// source category they mirror.
pub fn categories(conn: &Connection, playlist_id: i64) -> Result<Vec<(EditorCategory, Option<(i64, String)>)>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.auto_source_id, c.auto_category_name, s.name, s.enabled FROM playlist_categories c \
         LEFT JOIN sources s ON s.id = c.auto_source_id WHERE c.playlist_id = ? ORDER BY c.position, c.id",
    )?;
    let rows = stmt.query_map([playlist_id], |r| {
        let auto_source: Option<i64> = r.get(2)?;
        let auto_name: Option<String> = r.get(3)?;
        let auto = auto_source.map(|source_id| -> rusqlite::Result<EditorCategoryAuto> {
            Ok(EditorCategoryAuto {
                source_id,
                source_name: r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "Unknown source".into()),
                category_name: auto_name.clone().unwrap_or_default(),
                enabled: r.get::<_, Option<bool>>(5)?.unwrap_or(true),
            })
        });
        let mirror = match (auto_source, auto_name.clone()) {
            (Some(s), Some(n)) => Some((s, n)),
            _ => None,
        };
        Ok((EditorCategory { id: r.get(0)?, name: r.get(1)?, auto: auto.transpose()? }, mirror))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AutoChannelView {
    pub source_channel_id: i64,
    pub name: String,
    pub logo: Option<String>,
    pub provider_name: String,
    pub stream_url: String,
}

/// The live channels of each auto-sync group, keyed by playlist category id:
/// the available channels in the mirrored source category, in provider order.
pub fn auto_channels(conn: &Connection, mirrors: &[(i64, (i64, String))]) -> Result<HashMap<String, Vec<AutoChannelView>>> {
    let mut out = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT sc.id, sc.name, sc.logo, s.name, sc.stream_id, s.server_url, s.stream_base_url, s.username, s.password, \
           s.output_format FROM source_channels sc JOIN sources s ON s.id = sc.source_id \
         WHERE sc.source_id = ? AND sc.category_name = ? AND sc.available = 1 ORDER BY sc.position, sc.id",
    )?;
    for (category_id, (source_id, name)) in mirrors {
        let rows = stmt.query_map(rusqlite::params![source_id, name], |r| {
            let stream_id: String = r.get(4)?;
            let format: String = r.get(9)?;
            Ok(AutoChannelView {
                source_channel_id: r.get(0)?,
                name: r.get(1)?,
                logo: r.get(2)?,
                provider_name: r.get(3)?,
                stream_url: stream_url(r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, &stream_id, &format),
            })
        })?;
        out.insert(category_id.to_string(), rows.collect::<rusqlite::Result<_>>()?);
    }
    Ok(out)
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditorChannel {
    pub id: i64,
    pub category_id: i64,
    pub source_channel_id: i64,
    pub custom_name: Option<String>,
    pub custom_logo: Option<String>,
    pub position: i64,
    pub primary_channel_id: Option<i64>,
    pub alt_position: i64,
    pub enabled: bool,
    pub auto_disabled_at: Option<String>,
    pub epg_source_id: Option<i64>,
    pub epg_channel_id: Option<String>,
    pub source_name: String,
    pub source_logo: Option<String>,
    pub source_available: bool,
    pub source_category_name: Option<String>,
    pub channel_source_id: i64,
    pub source_epg_channel_id: Option<String>,
    pub stream_id: String,
    pub source_provider_name: String,
    pub source_enabled: bool,
    #[ts(as = "Option<kinds::ChannelProbeStatus>")]
    pub probe_status: Option<String>,
    pub probe_error: Option<String>,
    pub probe_width: Option<i64>,
    pub probe_height: Option<i64>,
    pub probe_fps: Option<f64>,
    pub probe_video_codec: Option<String>,
    pub probe_audio_codec: Option<String>,
    pub probe_bitrate: Option<i64>,
    pub probe_passes: i64,
    pub probe_attempts: i64,
    pub consecutive_probe_failures: i64,
    // Passed enough recent probes that smart sort doesn't treat it as flaky.
    pub probe_steady: bool,
    pub source_category_enabled: bool,
    // The logo a custom EPG pick lends, so the editor shows what output will.
    pub epg_logo: Option<String>,
    pub stream_url: String,
    // For an alternate, the name it gets from its primary. For a primary, just
    // the source name.
    pub auto_name: String,
}

/// The playlist's channels joined to their source channel, in category then
/// channel order.
pub fn playlist_channels(conn: &Connection, playlist_id: i64, alt_template: &str) -> Result<Vec<EditorChannel>> {
    let mut stmt = conn.prepare(
        "SELECT pc.id, pc.category_id, pc.source_channel_id, pc.custom_name, pc.custom_logo, pc.position, \
           pc.primary_channel_id, pc.alt_position, pc.enabled, pc.auto_disabled_at, pc.epg_source_id, pc.epg_channel_id, \
           sc.name, sc.logo, sc.available, sc.category_name, sc.source_id, sc.epg_channel_id, sc.stream_id, \
           s.name, s.enabled, s.server_url, s.stream_base_url, s.username, s.password, s.output_format, \
           sc.probe_status, sc.probe_error, sc.probe_width, sc.probe_height, sc.probe_fps, sc.probe_video_codec, \
           sc.probe_audio_codec, sc.probe_bitrate, cat.enabled, sc.probe_passes, sc.probe_attempts, \
           sc.consecutive_probe_failures \
         FROM playlist_channels pc \
         JOIN source_channels sc ON pc.source_channel_id = sc.id \
         JOIN sources s ON sc.source_id = s.id \
         LEFT JOIN source_categories cat ON cat.source_id = sc.source_id AND cat.name = sc.category_name \
         JOIN playlist_categories c ON pc.category_id = c.id \
         WHERE pc.playlist_id = ? ORDER BY c.position, c.id, pc.position, pc.id",
    )?;
    let mut rows: Vec<EditorChannel> = stmt
        .query_map([playlist_id], |r| {
            let stream_id: String = r.get(18)?;
            let format: String = r.get(25)?;
            Ok(EditorChannel {
                id: r.get(0)?,
                category_id: r.get(1)?,
                source_channel_id: r.get(2)?,
                custom_name: r.get(3)?,
                custom_logo: r.get(4)?,
                position: r.get(5)?,
                primary_channel_id: r.get(6)?,
                alt_position: r.get(7)?,
                enabled: r.get(8)?,
                auto_disabled_at: iso_opt(r.get(9)?),
                epg_source_id: r.get(10)?,
                epg_channel_id: r.get(11)?,
                source_name: r.get(12)?,
                source_logo: r.get(13)?,
                source_available: r.get(14)?,
                source_category_name: r.get(15)?,
                channel_source_id: r.get(16)?,
                source_epg_channel_id: r.get(17)?,
                source_provider_name: r.get(19)?,
                source_enabled: r.get(20)?,
                stream_url: stream_url(r.get(21)?, r.get(22)?, r.get(23)?, r.get(24)?, &stream_id, &format),
                stream_id,
                probe_status: r.get(26)?,
                probe_error: r.get(27)?,
                probe_width: r.get(28)?,
                probe_height: r.get(29)?,
                probe_fps: r.get(30)?,
                probe_video_codec: r.get(31)?,
                probe_audio_codec: r.get(32)?,
                probe_bitrate: r.get(33)?,
                probe_passes: r.get(35)?,
                probe_attempts: r.get(36)?,
                consecutive_probe_failures: r.get(37)?,
                probe_steady: false,
                // No category row (uncategorised, or never seeded) counts as on.
                source_category_enabled: r.get::<_, Option<bool>>(34)?.unwrap_or(true),
                epg_logo: None,
                auto_name: String::new(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let refs: Vec<EpgLogoRef> = rows.iter().map(logo_ref).collect();
    let logos = EpgLogos::load(conn, &refs)?;
    let name_of: HashMap<i64, String> = rows
        .iter()
        .map(|r| (r.id, r.custom_name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| r.source_name.clone())))
        .collect();
    for (r, logo_ref) in rows.iter_mut().zip(&refs) {
        let logo = logos.get(logo_ref);
        r.epg_logo = (!logo.is_empty()).then_some(logo);
        r.probe_steady = steady(&editor_stream(r));
        r.auto_name = match r.primary_channel_id {
            Some(p) => alt_name(alt_template, name_of.get(&p).unwrap_or(&r.source_name), r.alt_position + 1, &r.source_provider_name),
            None => r.source_name.clone(),
        };
    }
    Ok(rows)
}

fn editor_stream(c: &EditorChannel) -> SmartSortStream {
    SmartSortStream {
        available: c.source_available,
        source_enabled: c.source_enabled,
        auto_disabled: c.auto_disabled_at.is_some(),
        probe_status: c.probe_status.clone(),
        probe_width: c.probe_width,
        probe_height: c.probe_height,
        probe_fps: c.probe_fps,
        probe_video_codec: c.probe_video_codec.clone(),
        probe_audio_codec: c.probe_audio_codec.clone(),
        probe_bitrate: c.probe_bitrate,
        probe_passes: c.probe_passes,
        probe_attempts: c.probe_attempts,
        consecutive_probe_failures: c.consecutive_probe_failures,
    }
}

/// The primaries whose group smart sort would put in a different order, so the
/// editor can flag them without anyone opening the preview.
pub fn groups_needing_sort(rows: &[EditorChannel], config: &SmartSortConfig) -> Vec<i64> {
    let mut alts: HashMap<i64, Vec<&EditorChannel>> = HashMap::new();
    for r in rows {
        if let Some(p) = r.primary_channel_id {
            alts.entry(p).or_default().push(r);
        }
    }
    let mut flagged = Vec::new();
    for primary in rows.iter().filter(|r| r.primary_channel_id.is_none()) {
        let Some(group) = alts.get_mut(&primary.id) else { continue };
        group.sort_by_key(|r| (r.alt_position, r.id));
        let members: Vec<&EditorChannel> = std::iter::once(primary).chain(group.iter().copied()).collect();
        // A stream waiting on a probe counts as never probed until its result
        // lands, so the group would look out of order for the whole run.
        if members.iter().any(|m| matches!(m.probe_status.as_deref(), Some("queued") | Some("probing"))) {
            continue;
        }
        let streams: Vec<SmartSortStream> = members.iter().map(|m| editor_stream(m)).collect();
        if needs_smart_sort(&streams, config) {
            flagged.push(primary.id);
        }
    }
    flagged
}

fn logo_ref(r: &EditorChannel) -> EpgLogoRef {
    EpgLogoRef {
        channel_source_id: r.channel_source_id,
        source_default_epg_id: r.source_epg_channel_id.clone(),
        epg_source_id: r.epg_source_id,
        epg_channel_id: r.epg_channel_id.clone(),
    }
}

/// Is a probe queued or running on any source behind this playlist? The
/// editor shows it as probing until it's done.
pub fn has_probing_source(conn: &Connection, playlist_id: i64) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM jobs j WHERE j.kind = 'probe' AND j.status IN ('queued', 'running') AND j.source_id IN ( \
               SELECT sc.source_id FROM playlist_channels pc JOIN source_channels sc ON pc.source_channel_id = sc.id \
               WHERE pc.playlist_id = ?) LIMIT 1",
            [playlist_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PreviewStream {
    pub id: i64,
    pub primary_channel_id: Option<i64>,
    pub source_name: String,
    pub provider_name: String,
    pub category_name: Option<String>,
    pub available: bool,
    pub source_enabled: bool,
    pub auto_disabled_at: Option<String>,
    #[ts(as = "Option<kinds::ChannelProbeStatus>")]
    pub probe_status: Option<String>,
    pub probe_width: Option<i64>,
    pub probe_height: Option<i64>,
    pub probe_fps: Option<f64>,
    pub probe_video_codec: Option<String>,
    pub probe_audio_codec: Option<String>,
    pub probe_bitrate: Option<i64>,
    pub currently_primary: bool,
    pub current_position: i64,
    pub factors: crate::smart_sort::SmartSortFactors,
}

/// An alternate group ranked best-first with the reasons, so the preview can
/// show what smart sort would do before it's applied.
pub fn smart_sort_preview(conn: &Connection, playlist_id: i64, primary_id: i64, config: &crate::smart_sort::SmartSortConfig) -> Result<Vec<PreviewStream>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT pc.id, pc.primary_channel_id, sc.name, s.name, sc.category_name, {} \
         FROM playlist_channels pc JOIN source_channels sc ON pc.source_channel_id = sc.id \
         JOIN sources s ON sc.source_id = s.id \
         WHERE pc.playlist_id = ?1 AND (pc.id = ?2 OR pc.primary_channel_id = ?2) \
         ORDER BY pc.primary_channel_id IS NULL DESC, pc.alt_position, pc.id",
        crate::playlist::mutations::SMART_SORT_COLUMNS
    ))?;
    let rows: Vec<(i64, Option<i64>, String, String, Option<String>, Option<i64>, SmartSortStream)> = stmt
        .query_map(rusqlite::params![playlist_id, primary_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(7)?, crate::playlist::mutations::smart_sort_stream(r, 5)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let streams: Vec<SmartSortStream> = rows.iter().map(|r| r.6.clone()).collect();
    Ok(smart_sort_order(&streams, config)
        .into_iter()
        .map(|i| {
            let (id, primary, source_name, provider_name, category_name, auto_disabled_at, s) = rows[i].clone();
            PreviewStream {
                id,
                primary_channel_id: primary,
                source_name,
                provider_name,
                category_name,
                available: s.available,
                source_enabled: s.source_enabled,
                auto_disabled_at: iso_opt(auto_disabled_at),
                factors: factors_for(&s),
                probe_status: s.probe_status,
                probe_width: s.probe_width,
                probe_height: s.probe_height,
                probe_fps: s.probe_fps,
                probe_video_codec: s.probe_video_codec,
                probe_audio_codec: s.probe_audio_codec,
                probe_bitrate: s.probe_bitrate,
                currently_primary: primary.is_none(),
                current_position: i as i64,
            }
        })
        .collect())
}

/// Category names across every source that aren't switched off, in provider
/// order, for the browser's category picker.
pub fn browser_categories(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT sc.category_name FROM source_channels sc WHERE {CATEGORY_ON} GROUP BY sc.category_name ORDER BY min(sc.id)"
    ))?;
    let rows = stmt.query_map([], |r| r.get::<_, Option<String>>(0))?;
    Ok(rows.filter_map(|r| r.ok().flatten().filter(|c| !c.is_empty())).collect())
}

// A channel's own source category isn't switched off. Correlated, so it works
// across every source at once.
const CATEGORY_ON: &str = "NOT EXISTS (SELECT 1 FROM source_categories c WHERE c.source_id = sc.source_id \
    AND c.name = sc.category_name AND c.enabled = 0)";

#[derive(Debug, Default, Clone)]
pub struct BrowserFilter {
    pub source_id: Option<i64>,
    pub categories: Vec<String>,
    pub q: Option<String>,
    pub exclude_playlist_id: Option<i64>,
}

/// The browser and "add all matching" share this filter, so adding matches
/// exactly what the browser shows.
fn browser_where(f: &BrowserFilter) -> (String, Vec<rusqlite::types::Value>) {
    let mut sql = vec![CATEGORY_ON.to_string()];
    let mut args: Vec<rusqlite::types::Value> = vec![];
    if let Some(s) = f.source_id {
        sql.push("sc.source_id = ?".into());
        args.push(s.into());
    }
    if !f.categories.is_empty() {
        sql.push(format!("sc.category_name IN ({})", crate::db::placeholders(f.categories.len())));
        args.extend(f.categories.iter().map(|c| c.clone().into()));
    }
    if let Some(q) = f.q.as_ref().filter(|q| !q.is_empty()) {
        sql.push("sc.name LIKE ?".into());
        args.push(format!("%{q}%").into());
    }
    if let Some(p) = f.exclude_playlist_id {
        sql.push("sc.id NOT IN (SELECT source_channel_id FROM playlist_channels WHERE playlist_id = ?)".into());
        args.push(p.into());
        // Channels an auto-sync group here already mirrors are covered too.
        sql.push(
            "NOT EXISTS (SELECT 1 FROM playlist_categories pcat WHERE pcat.playlist_id = ? \
             AND pcat.auto_source_id = sc.source_id AND pcat.auto_category_name = sc.category_name)"
                .into(),
        );
        args.push(p.into());
    }
    (sql.join(" AND "), args)
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BrowserChannel {
    pub id: i64,
    pub name: String,
    pub logo: Option<String>,
    pub category_name: Option<String>,
    pub available: bool,
    pub source_id: i64,
    pub source_name: String,
    pub source_enabled: bool,
    pub epg_channel_id: Option<String>,
    pub stream_url: String,
}

fn count(conn: &Connection, f: &BrowserFilter) -> Result<i64> {
    let (where_sql, args) = browser_where(f);
    Ok(conn.query_row(&format!("SELECT count(*) FROM source_channels sc WHERE {where_sql}"), params_from_iter(args), |r| r.get(0))?)
}

/// Browser results across every source, filtered, minus what the playlist
/// already has, capped. Also counts the matches hidden because the playlist
/// already covers them, so a search for a channel already added doesn't just
/// say "no channels match".
pub fn browser_channels(conn: &Connection, f: &BrowserFilter) -> Result<(Vec<BrowserChannel>, i64, i64)> {
    let total = count(conn, f)?;
    let already_added = match f.exclude_playlist_id {
        Some(_) => count(conn, &BrowserFilter { exclude_playlist_id: None, ..f.clone() })? - total,
        None => 0,
    };
    let (where_sql, args) = browser_where(f);
    // Channels from a switched-off source can't reach output, so they sit at the
    // bottom and are the first cut by the limit.
    let mut stmt = conn.prepare(&format!(
        "SELECT sc.id, sc.name, sc.logo, sc.category_name, sc.available, sc.source_id, s.name, s.enabled, sc.epg_channel_id, \
           sc.stream_id, s.server_url, s.stream_base_url, s.username, s.password, s.output_format \
         FROM source_channels sc JOIN sources s ON s.id = sc.source_id WHERE {where_sql} \
         ORDER BY s.enabled DESC, s.name, sc.position, sc.id LIMIT {BROWSER_LIMIT}"
    ))?;
    let rows = stmt
        .query_map(params_from_iter(args), |r| {
            let stream_id: String = r.get(9)?;
            let format: String = r.get(14)?;
            Ok(BrowserChannel {
                id: r.get(0)?,
                name: r.get(1)?,
                logo: r.get(2)?,
                category_name: r.get(3)?,
                available: r.get(4)?,
                source_id: r.get(5)?,
                source_name: r.get(6)?,
                source_enabled: r.get(7)?,
                epg_channel_id: r.get(8)?,
                stream_url: stream_url(r.get(10)?, r.get(11)?, r.get(12)?, r.get(13)?, &stream_id, &format),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok((rows, total, already_added))
}

/// Every source channel matching a filter, uncapped, in display order. For
/// adding a whole group or every match at once.
pub fn matching_source_channel_ids(conn: &Connection, f: &BrowserFilter) -> Result<Vec<i64>> {
    let (where_sql, args) = browser_where(f);
    let mut stmt = conn.prepare(&format!(
        "SELECT sc.id FROM source_channels sc WHERE {where_sql} ORDER BY sc.source_id, sc.position, sc.id"
    ))?;
    Ok(stmt.query_map(params_from_iter(args), |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EpgChannel {
    pub id: i64,
    pub source_id: i64,
    pub channel_id: String,
    pub display_name: Option<String>,
    pub icon: Option<String>,
    pub source_name: String,
}

/// Every EPG channel across every source, for the picker.
pub fn epg_channels(conn: &Connection) -> Result<Vec<EpgChannel>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.source_id, e.channel_id, e.display_name, e.icon, s.name FROM source_epg_channels e \
         JOIN sources s ON e.source_id = s.id ORDER BY s.name, e.display_name",
    )?;
    Ok(stmt
        .query_map([], |r| {
            Ok(EpgChannel { id: r.get(0)?, source_id: r.get(1)?, channel_id: r.get(2)?, display_name: r.get(3)?, icon: r.get(4)?, source_name: r.get(5)? })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playlist::mutations::{add_channels, make_alternates};
    use crate::test_support;

    #[test]
    fn browser_counts_what_the_playlist_already_has() {
        let db = test_support::db();
        let conn = db.lock();
        let s = test_support::source(&conn, "Main");
        let a = test_support::source_channel(&conn, s, "a", "BBC One", "UK");
        test_support::source_channel(&conn, s, "b", "BBC Two", "UK");
        test_support::source_channel(&conn, s, "c", "CNN", "US");
        let p = test_support::playlist(&conn, "PL", "tok");
        let cat = test_support::category(&conn, p, "UK", 0);
        add_channels(&conn, p, cat, &[a], None).unwrap();

        let f = BrowserFilter { q: Some("BBC".into()), exclude_playlist_id: Some(p), ..Default::default() };
        let (rows, total, already) = browser_channels(&conn, &f).unwrap();
        assert_eq!(rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["BBC Two"]);
        assert_eq!((total, already), (1, 1));

        // An auto-sync group covers its whole source category.
        conn.execute(
            "INSERT INTO playlist_categories (playlist_id, name, auto_source_id, auto_category_name) VALUES (?, 'Auto', ?, 'US')",
            rusqlite::params![p, s],
        )
        .unwrap();
        let all = BrowserFilter { exclude_playlist_id: Some(p), ..Default::default() };
        let (rows, _, already) = browser_channels(&conn, &all).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(already, 2);
        assert_eq!(matching_source_channel_ids(&conn, &all).unwrap().len(), 1);

        // A switched-off category disappears from the browser and the picker.
        conn.execute("INSERT INTO source_categories (source_id, name, enabled) VALUES (?, 'UK', 0)", [s]).unwrap();
        assert_eq!(browser_categories(&conn).unwrap(), ["US"]);
    }

    #[test]
    fn editor_channels_name_alternates_from_their_primary() {
        let db = test_support::db();
        let conn = db.lock();
        let s = test_support::source(&conn, "Main");
        let a = test_support::source_channel(&conn, s, "a", "BBC One", "UK");
        let b = test_support::source_channel(&conn, s, "b", "BBC One Backup", "UK");
        let p = test_support::playlist(&conn, "PL", "tok");
        let cat = test_support::category(&conn, p, "UK", 0);
        add_channels(&conn, p, cat, &[a, b], None).unwrap();
        let rows = playlist_channels(&conn, p, "{name} (Alt {n})").unwrap();
        make_alternates(&conn, p, rows[0].id, &[rows[1].id]).unwrap();
        let rows = playlist_channels(&conn, p, "{name} (Alt {n})").unwrap();
        assert_eq!(rows[0].auto_name, "BBC One");
        assert_eq!(rows[1].auto_name, "BBC One (Alt 1)");
        assert!(rows[0].source_category_enabled);
        assert_eq!(rows[0].stream_url, "http://s/live/u/p/a.ts");

        let preview = smart_sort_preview(&conn, p, rows[0].id, &Default::default()).unwrap();
        assert_eq!(preview.len(), 2);
        assert!(preview[0].currently_primary);
        assert_eq!(preview[1].current_position, 1);
    }

    #[test]
    fn flags_groups_smart_sort_would_reorder() {
        let db = test_support::db();
        let conn = db.lock();
        let s = test_support::source(&conn, "Main");
        let set = |id: i64, status: &str, height: i64| {
            conn.execute(
                "UPDATE source_channels SET probe_status = ?, probe_height = ?, probe_fps = 50, probe_bitrate = 6000 WHERE id = ?",
                rusqlite::params![status, height, id],
            )
            .unwrap();
        };
        let a = test_support::source_channel(&conn, s, "a", "BBC One", "UK");
        let b = test_support::source_channel(&conn, s, "b", "BBC One HD", "UK");
        let c = test_support::source_channel(&conn, s, "c", "ITV", "UK");
        set(a, "ok", 720);
        set(b, "ok", 1080);
        set(c, "ok", 1080);
        let p = test_support::playlist(&conn, "PL", "tok");
        let cat = test_support::category(&conn, p, "UK", 0);
        add_channels(&conn, p, cat, &[a, b, c], None).unwrap();
        let rows = playlist_channels(&conn, p, "{name}").unwrap();
        make_alternates(&conn, p, rows[0].id, &[rows[1].id]).unwrap();
        let config = SmartSortConfig::default();

        let rows = playlist_channels(&conn, p, "{name}").unwrap();
        assert_eq!(groups_needing_sort(&rows, &config), [rows[0].id]);
        assert!(rows.iter().all(|r| r.probe_steady));

        // A probe still running on any stream holds the flag back until it lands.
        set(b, "queued", 1080);
        let rows = playlist_channels(&conn, p, "{name}").unwrap();
        assert!(groups_needing_sort(&rows, &config).is_empty());

        set(b, "ok", 576);
        let rows = playlist_channels(&conn, p, "{name}").unwrap();
        assert!(groups_needing_sort(&rows, &config).is_empty());
    }
}
