use std::collections::{HashMap, HashSet};

use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;

use crate::alt_name::{alt_name, channel_name};
use crate::epg_logo::{EpgLogoRef, EpgLogos};
use crate::models::Playlist;
use crate::xtream::{Creds, build_stream_url, build_timeshift_source};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedChannel {
    pub display_name: String,
    pub logo: String,
    pub group_title: String,
    pub tvg_id: String,
    // Which source's guide data this channel's programmes come from.
    pub epg_source_id: i64,
    pub stream_url: String,
    // Days of catchup, 0 when none. catchup_source is the timeshift URL template
    // the in-app guide uses to play past programmes. The M3U doesn't emit it;
    // players build their own URL from catchup="xc".
    pub catchup_days: i64,
    pub catchup_source: String,
}

pub fn get_playlist_output(conn: &Connection, token: &str) -> Result<Option<(Playlist, Vec<ResolvedChannel>)>> {
    let Some(playlist) = Playlist::by_token(conn, token)? else { return Ok(None) };
    let channels = resolve_playlist_channels(conn, &playlist)?;
    Ok(Some((playlist, channels)))
}

struct StreamInfo {
    stream_id: String,
    tv_archive_duration: i64,
    output_format: String,
    creds: Creds,
}

impl StreamInfo {
    fn urls(&self) -> (String, String) {
        let stream = build_stream_url(&self.creds, &self.stream_id, &self.output_format);
        let catchup = if self.tv_archive_duration > 0 {
            build_timeshift_source(&self.creds, &self.stream_id, &self.output_format)
        } else {
            String::new()
        };
        (stream, catchup)
    }
}

struct NormalRow {
    id: i64,
    category_id: i64,
    primary_channel_id: Option<i64>,
    alt_position: i64,
    custom_name: Option<String>,
    logo_ref: EpgLogoRef,
    custom_logo: Option<String>,
    channel_name: String,
    channel_logo: Option<String>,
    provider_name: String,
    stream: StreamInfo,
}

/// What every channel in the playlist (disabled ones too) lends its
/// alternates: name, guide and logo.
struct PrimaryInfo {
    enabled: bool,
    name: String,
    tvg_id: String,
    epg_source_id: i64,
    logo: String,
}

fn or_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

// A manual logo wins, then the icon of a custom EPG pick, then the source
// channel's own logo.
fn logo_for(custom: &Option<String>, logos: &EpgLogos, r: &EpgLogoRef, channel_logo: &Option<String>) -> String {
    if let Some(c) = or_empty(custom) {
        return c.to_string();
    }
    let borrowed = logos.get(r);
    if !borrowed.is_empty() {
        return borrowed;
    }
    or_empty(channel_logo).unwrap_or("").to_string()
}

fn epg_of(r: &EpgLogoRef) -> (String, i64) {
    (
        r.epg_channel_id.clone().or_else(|| r.source_default_epg_id.clone()).unwrap_or_default(),
        r.epg_source_id.unwrap_or(r.channel_source_id),
    )
}

/// A playlist's channels in output order with names, logos, guide ids and
/// stream URLs worked out. Alternates take their primary's name, guide and
/// logo. The M3U, the EPG and the in-app guide all use this, so they agree.
pub fn resolve_playlist_channels(conn: &Connection, playlist: &Playlist) -> Result<Vec<ResolvedChannel>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, auto_source_id, auto_category_name FROM playlist_categories \
         WHERE playlist_id = ? ORDER BY position, id",
    )?;
    let cats: Vec<(i64, String, Option<i64>, Option<String>)> = stmt
        .query_map([playlist.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let mut stmt = conn.prepare(
        "SELECT pc.id, pc.category_id, pc.primary_channel_id, pc.alt_position, pc.custom_name, pc.custom_logo, \
                pc.epg_source_id, pc.epg_channel_id, sc.name, sc.logo, sc.epg_channel_id, sc.stream_id, \
                sc.source_id, sc.tv_archive_duration, s.name, s.server_url, s.stream_base_url, s.username, \
                s.password, s.output_format \
         FROM playlist_channels pc \
         JOIN source_channels sc ON pc.source_channel_id = sc.id \
         JOIN sources s ON sc.source_id = s.id \
         LEFT JOIN source_categories cat ON cat.source_id = sc.source_id AND cat.name = sc.category_name \
         WHERE pc.playlist_id = ? AND pc.enabled = 1 AND s.enabled = 1 AND sc.available = 1 \
           AND (cat.id IS NULL OR cat.enabled = 1) \
         ORDER BY pc.position, pc.id",
    )?;
    let normal_rows: Vec<NormalRow> = stmt
        .query_map([playlist.id], |r| {
            let stream_base_url: Option<String> = r.get(16)?;
            let server_url: String = r.get(15)?;
            Ok(NormalRow {
                id: r.get(0)?,
                category_id: r.get(1)?,
                primary_channel_id: r.get(2)?,
                alt_position: r.get(3)?,
                custom_name: r.get(4)?,
                custom_logo: r.get(5)?,
                logo_ref: EpgLogoRef {
                    epg_source_id: r.get(6)?,
                    epg_channel_id: r.get(7)?,
                    source_default_epg_id: r.get(10)?,
                    channel_source_id: r.get(12)?,
                },
                channel_name: r.get(8)?,
                channel_logo: r.get(9)?,
                provider_name: r.get(14)?,
                stream: StreamInfo {
                    stream_id: r.get(11)?,
                    tv_archive_duration: r.get(13)?,
                    output_format: r.get(19)?,
                    creds: Creds {
                        server_url: stream_base_url.unwrap_or(server_url),
                        username: r.get(17)?,
                        password: r.get(18)?,
                    },
                },
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut stmt = conn.prepare(
        "SELECT pc.id, pc.enabled, pc.custom_name, pc.custom_logo, pc.epg_source_id, pc.epg_channel_id, \
                sc.name, sc.logo, sc.epg_channel_id, sc.source_id \
         FROM playlist_channels pc JOIN source_channels sc ON pc.source_channel_id = sc.id \
         WHERE pc.playlist_id = ?",
    )?;
    struct AllRow {
        id: i64,
        enabled: bool,
        custom_name: Option<String>,
        custom_logo: Option<String>,
        channel_name: String,
        channel_logo: Option<String>,
        logo_ref: EpgLogoRef,
    }
    let all_rows: Vec<AllRow> = stmt
        .query_map([playlist.id], |r| {
            Ok(AllRow {
                id: r.get(0)?,
                enabled: r.get(1)?,
                custom_name: r.get(2)?,
                custom_logo: r.get(3)?,
                channel_name: r.get(6)?,
                channel_logo: r.get(7)?,
                logo_ref: EpgLogoRef {
                    epg_source_id: r.get(4)?,
                    epg_channel_id: r.get(5)?,
                    source_default_epg_id: r.get(8)?,
                    channel_source_id: r.get(9)?,
                },
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let logos = EpgLogos::load(conn, &all_rows.iter().map(|r| r.logo_ref.clone()).collect::<Vec<_>>())?;

    let mut primaries: HashMap<i64, PrimaryInfo> = HashMap::new();
    for r in &all_rows {
        let (tvg_id, epg_source_id) = epg_of(&r.logo_ref);
        primaries.insert(
            r.id,
            PrimaryInfo {
                enabled: r.enabled,
                // Left free of the channel name template, so an alternate named
                // after its primary doesn't also carry the primary's provider tag.
                name: or_empty(&r.custom_name).unwrap_or(&r.channel_name).to_string(),
                tvg_id,
                epg_source_id,
                logo: logo_for(&r.custom_logo, &logos, &r.logo_ref, &r.channel_logo),
            },
        );
    }

    // A disabled primary takes its whole group out of output, so a backup never
    // emits on its own under a name and guide whose primary is gone.
    let mut by_cat: HashMap<i64, Vec<&NormalRow>> = HashMap::new();
    for r in &normal_rows {
        if let Some(p) = r.primary_channel_id
            && primaries.get(&p).is_some_and(|p| !p.enabled)
        {
            continue;
        }
        by_cat.entry(r.category_id).or_default().push(r);
    }

    // Each primary is followed straight away by its alternates. Alternates whose
    // primary is filtered out of output stay where they fall.
    fn sequence<'a>(rows: &[&'a NormalRow]) -> Vec<&'a NormalRow> {
        let mut alts: HashMap<i64, Vec<&NormalRow>> = HashMap::new();
        for r in rows {
            if let Some(p) = r.primary_channel_id {
                alts.entry(p).or_default().push(r);
            }
        }
        for list in alts.values_mut() {
            list.sort_by_key(|r| r.alt_position);
        }
        let present: HashSet<i64> = rows.iter().map(|r| r.id).collect();
        let mut out = Vec::new();
        for r in rows {
            if let Some(p) = r.primary_channel_id {
                if !present.contains(&p) {
                    out.push(*r);
                }
                continue;
            }
            out.push(*r);
            out.extend(alts.get(&r.id).into_iter().flatten().copied());
        }
        out
    }

    let mut channels = Vec::new();
    for (cat_id, cat_name, auto_source_id, auto_category_name) in &cats {
        if let (Some(source_id), Some(category_name)) = (auto_source_id, auto_category_name) {
            let mut stmt = conn.prepare_cached(
                "SELECT sc.name, sc.logo, sc.epg_channel_id, sc.stream_id, sc.source_id, sc.tv_archive_duration, \
                        s.name, s.server_url, s.stream_base_url, s.username, s.password, s.output_format \
                 FROM source_channels sc JOIN sources s ON s.id = sc.source_id \
                 WHERE sc.source_id = ? AND s.enabled = 1 AND sc.category_name = ? AND sc.available = 1 \
                 ORDER BY sc.position, sc.id",
            )?;
            let rows = stmt.query_map(rusqlite::params![source_id, category_name], |r| {
                let stream_base_url: Option<String> = r.get(8)?;
                let server_url: String = r.get(7)?;
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(6)?,
                    StreamInfo {
                        stream_id: r.get(3)?,
                        tv_archive_duration: r.get(5)?,
                        output_format: r.get(11)?,
                        creds: Creds {
                            server_url: stream_base_url.unwrap_or(server_url),
                            username: r.get(9)?,
                            password: r.get(10)?,
                        },
                    },
                ))
            })?;
            for row in rows {
                let (name, logo, epg_id, channel_source_id, provider, stream) = row?;
                let (stream_url, catchup_source) = stream.urls();
                channels.push(ResolvedChannel {
                    display_name: channel_name(&playlist.channel_name_template, &name, &provider),
                    logo: or_empty(&logo).unwrap_or("").to_string(),
                    group_title: cat_name.clone(),
                    tvg_id: epg_id.unwrap_or_default(),
                    epg_source_id: channel_source_id,
                    stream_url,
                    catchup_days: stream.tv_archive_duration,
                    catchup_source,
                });
            }
            continue;
        }

        let rows = by_cat.get(cat_id).map(|v| v.as_slice()).unwrap_or(&[]);
        for r in sequence(rows) {
            let primary = r.primary_channel_id.and_then(|p| primaries.get(&p));

            // Alternates are always named, guided and logoed from their primary,
            // so they can never drift from it.
            let display_name = match r.primary_channel_id {
                Some(_) => alt_name(
                    &playlist.alt_name_template,
                    primary.map(|p| p.name.as_str()).unwrap_or(&r.channel_name),
                    r.alt_position + 1,
                    &r.provider_name,
                ),
                None => channel_name(
                    &playlist.channel_name_template,
                    or_empty(&r.custom_name).unwrap_or(&r.channel_name),
                    &r.provider_name,
                ),
            };
            let (tvg_id, epg_source_id) = match primary {
                Some(p) => (p.tvg_id.clone(), p.epg_source_id),
                None => epg_of(&r.logo_ref),
            };
            let logo = match primary {
                Some(p) => p.logo.clone(),
                None => logo_for(&r.custom_logo, &logos, &r.logo_ref, &r.channel_logo),
            };
            let (stream_url, catchup_source) = r.stream.urls();
            channels.push(ResolvedChannel {
                display_name,
                logo,
                group_title: cat_name.clone(),
                tvg_id,
                epg_source_id,
                stream_url,
                catchup_days: r.stream.tv_archive_duration,
                catchup_source,
            });
        }
    }
    Ok(channels)
}
