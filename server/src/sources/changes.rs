use std::collections::{BTreeSet, HashMap, HashSet};

use anyhow::Result;
use rusqlite::{Connection, params, params_from_iter};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::db::{ID_CHUNK, placeholders};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, rename = "ChangePlaylistRef")]
pub struct PlaylistRef {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct BeforeChannel {
    pub name: String,
    pub category_name: Option<String>,
    pub available: bool,
}

#[derive(Debug, Clone)]
pub struct SeenChannel {
    pub stream_id: String,
    pub name: String,
    pub category_name: Option<String>,
}

struct NewChange {
    kind: &'static str,
    name: String,
    category_name: Option<String>,
    stream_id: Option<String>,
    playlists: Option<Vec<PlaylistRef>>,
}

/// Which playlists each change touches, snapshotted now so the history still
/// reads right after a playlist is renamed or deleted. A channel touches any
/// playlist that added it, or whose auto-sync group mirrors its category.
fn attach_playlists(conn: &Connection, source_id: i64, changes: &mut [NewChange]) -> Result<()> {
    let stream_ids: Vec<&String> = changes.iter().filter_map(|c| c.stream_id.as_ref()).collect();
    let mut sc_by_stream: HashMap<String, i64> = HashMap::new();
    for chunk in stream_ids.chunks(ID_CHUNK) {
        let mut args: Vec<rusqlite::types::Value> = vec![source_id.into()];
        args.extend(chunk.iter().map(|s| (*s).clone().into()));
        let mut stmt = conn.prepare(&format!(
            "SELECT id, stream_id FROM source_channels WHERE source_id = ? AND stream_id IN ({})",
            placeholders(chunk.len())
        ))?;
        for r in stmt.query_map(params_from_iter(args), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (id, stream) = r?;
            sc_by_stream.insert(stream, id);
        }
    }

    let mut manual: HashMap<i64, Vec<PlaylistRef>> = HashMap::new();
    let sc_ids: Vec<i64> = sc_by_stream.values().copied().collect();
    for chunk in sc_ids.chunks(ID_CHUNK) {
        let mut stmt = conn.prepare(&format!(
            "SELECT pc.source_channel_id, p.id, p.name FROM playlist_channels pc \
             JOIN playlists p ON p.id = pc.playlist_id WHERE pc.source_channel_id IN ({})",
            placeholders(chunk.len())
        ))?;
        for r in stmt.query_map(params_from_iter(chunk), |r| Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?)))? {
            let (sc, id, name) = r?;
            manual.entry(sc).or_default().push(PlaylistRef { id, name });
        }
    }

    let mut auto: HashMap<String, Vec<PlaylistRef>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT pc.auto_category_name, p.id, p.name FROM playlist_categories pc \
         JOIN playlists p ON p.id = pc.playlist_id WHERE pc.auto_source_id = ?",
    )?;
    for r in stmt.query_map([source_id], |r| Ok((r.get::<_, Option<String>>(0)?, r.get(1)?, r.get(2)?)))? {
        let (cat, id, name) = r?;
        if let Some(cat) = cat.filter(|c| !c.is_empty()) {
            auto.entry(cat).or_default().push(PlaylistRef { id, name });
        }
    }

    for c in changes.iter_mut() {
        // Keyed by id, in first-seen order, so a playlist is listed once.
        let mut found: Vec<PlaylistRef> = Vec::new();
        let add = |p: &PlaylistRef, found: &mut Vec<PlaylistRef>| match found.iter_mut().find(|f| f.id == p.id) {
            Some(existing) => existing.name = p.name.clone(),
            None => found.push(p.clone()),
        };
        if let Some(sc) = c.stream_id.as_ref().and_then(|s| sc_by_stream.get(s)) {
            for p in manual.get(sc).into_iter().flatten() {
                add(p, &mut found);
            }
        }
        // Channel changes carry their category in category_name; category
        // changes are named after the category itself.
        let cat = c.category_name.clone().or_else(|| if c.stream_id.is_some() { None } else { Some(c.name.clone()) });
        if let Some(cat) = cat.filter(|c| !c.is_empty()) {
            for p in auto.get(&cat).into_iter().flatten() {
                add(p, &mut found);
            }
        }
        c.playlists = if found.is_empty() { None } else { Some(found) };
    }
    Ok(())
}

/// Diff a sync and record what the provider added or removed. `before` is the
/// catalog from before the sync; `seen` is what the provider returned. Returns
/// None on a source's first sync, which is a baseline rather than a change.
pub fn record_sync_changes(
    conn: &Connection,
    source_id: i64,
    before: &[(String, BeforeChannel)],
    seen: &[SeenChannel],
    synced_at: i64,
) -> Result<Option<(usize, usize)>> {
    if before.is_empty() {
        return Ok(None);
    }
    let before_map: HashMap<&str, &BeforeChannel> = before.iter().map(|(k, v)| (k.as_str(), v)).collect();
    let seen_ids: HashSet<&str> = seen.iter().map(|s| s.stream_id.as_str()).collect();
    let mut changes = Vec::new();

    for s in seen {
        let kind = match before_map.get(s.stream_id.as_str()) {
            None => "channel_added",
            Some(prev) if !prev.available => "channel_returned",
            _ => continue,
        };
        changes.push(NewChange {
            kind,
            name: s.name.clone(),
            category_name: s.category_name.clone(),
            stream_id: Some(s.stream_id.clone()),
            playlists: None,
        });
    }
    for (stream_id, prev) in before {
        if prev.available && !seen_ids.contains(stream_id.as_str()) {
            changes.push(NewChange {
                kind: "channel_removed",
                name: prev.name.clone(),
                category_name: prev.category_name.clone(),
                stream_id: Some(stream_id.clone()),
                playlists: None,
            });
        }
    }

    // A category is "added" if no channel had it before, even an unavailable
    // one, and "removed" if it had available channels before and none now.
    let mut before_all = HashSet::new();
    let mut before_available: Vec<String> = Vec::new();
    for (_, prev) in before {
        let Some(cat) = prev.category_name.as_ref().filter(|c| !c.is_empty()) else { continue };
        before_all.insert(cat.clone());
        if prev.available && !before_available.contains(cat) {
            before_available.push(cat.clone());
        }
    }
    let mut now_available: Vec<String> = Vec::new();
    let mut now_set = BTreeSet::new();
    for s in seen {
        if let Some(cat) = s.category_name.as_ref().filter(|c| !c.is_empty())
            && now_set.insert(cat.clone())
        {
            now_available.push(cat.clone());
        }
    }
    for name in &now_available {
        if !before_all.contains(name) {
            changes.push(NewChange { kind: "category_added", name: name.clone(), category_name: None, stream_id: None, playlists: None });
        }
    }
    for name in &before_available {
        if !now_set.contains(name) {
            changes.push(NewChange { kind: "category_removed", name: name.clone(), category_name: None, stream_id: None, playlists: None });
        }
    }

    if changes.is_empty() {
        return Ok(Some((0, 0)));
    }
    attach_playlists(conn, source_id, &mut changes)?;

    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO source_changes (source_id, synced_at, kind, name, category_name, stream_id, playlists) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )?;
        for c in &changes {
            let playlists = c.playlists.as_ref().map(serde_json::to_string).transpose()?;
            stmt.execute(params![source_id, synced_at, c.kind, c.name, c.category_name, c.stream_id, playlists])?;
        }
    }
    tx.commit()?;

    let added = changes.iter().filter(|c| c.kind != "channel_removed" && c.kind != "category_removed").count();
    Ok(Some((added, changes.len() - added)))
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncSummary {
    pub synced_at: i64,
    pub added: i64,
    pub removed: i64,
}

/// One row per sync that recorded changes, newest first.
pub fn list_syncs(conn: &Connection, source_id: i64) -> Result<Vec<SyncSummary>> {
    let mut stmt = conn.prepare(
        "SELECT synced_at, \
           sum(CASE WHEN kind IN ('channel_added','category_added','channel_returned') THEN 1 ELSE 0 END), \
           sum(CASE WHEN kind IN ('channel_removed','category_removed') THEN 1 ELSE 0 END) \
         FROM source_changes WHERE source_id = ? GROUP BY synced_at ORDER BY synced_at DESC",
    )?;
    let rows = stmt.query_map([source_id], |r| Ok(SyncSummary { synced_at: r.get(0)?, added: r.get(1)?, removed: r.get(2)? }))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceChange {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub category_name: Option<String>,
    pub stream_id: Option<String>,
    pub playlists: Option<Vec<PlaylistRef>>,
}

pub fn changes_for_sync(conn: &Connection, source_id: i64, synced_at: i64) -> Result<Vec<SourceChange>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, name, category_name, stream_id, playlists FROM source_changes \
         WHERE source_id = ? AND synced_at = ? ORDER BY id",
    )?;
    let rows = stmt.query_map(params![source_id, synced_at], |r| {
        let playlists: Option<String> = r.get(5)?;
        Ok(SourceChange {
            id: r.get(0)?,
            kind: r.get(1)?,
            name: r.get(2)?,
            category_name: r.get(3)?,
            stream_id: r.get(4)?,
            playlists: playlists.and_then(|p| serde_json::from_str(&p).ok()),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;

    fn before(entries: &[(&str, &str, Option<&str>, bool)]) -> Vec<(String, BeforeChannel)> {
        entries
            .iter()
            .map(|(id, name, cat, available)| {
                (id.to_string(), BeforeChannel { name: name.to_string(), category_name: cat.map(String::from), available: *available })
            })
            .collect()
    }

    fn seen(entries: &[(&str, &str, Option<&str>)]) -> Vec<SeenChannel> {
        entries
            .iter()
            .map(|(id, name, cat)| SeenChannel { stream_id: id.to_string(), name: name.to_string(), category_name: cat.map(String::from) })
            .collect()
    }

    #[test]
    fn first_sync_records_nothing() {
        let db = test_support::db();
        let conn = db.lock();
        let s = test_support::source(&conn, "Main");
        assert_eq!(record_sync_changes(&conn, s, &[], &seen(&[("1", "A", Some("News"))]), 100).unwrap(), None);
    }

    #[test]
    fn records_added_removed_returned_and_categories() {
        let db = test_support::db();
        let conn = db.lock();
        let s = test_support::source(&conn, "Main");
        let gone = test_support::source_channel(&conn, s, "2", "Gone", "Old");
        let p = test_support::playlist(&conn, "Living Room", "tok");
        let cat = test_support::category(&conn, p, "UK", 0);
        conn.execute(
            "INSERT INTO playlist_channels (playlist_id, category_id, source_channel_id) VALUES (?, ?, ?)",
            params![p, cat, gone],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO playlist_categories (playlist_id, name, auto_source_id, auto_category_name) VALUES (?, 'Auto', ?, 'Sport')",
            params![p, s],
        )
        .unwrap();

        let b = before(&[("1", "Kept", Some("News"), true), ("2", "Gone", Some("Old"), true), ("3", "Back", Some("News"), false)]);
        let now = seen(&[("1", "Kept", Some("News")), ("3", "Back", Some("News")), ("4", "New", Some("Sport"))]);
        assert_eq!(record_sync_changes(&conn, s, &b, &now, 100).unwrap(), Some((3, 2)));

        let changes = changes_for_sync(&conn, s, 100).unwrap();
        let kinds: Vec<(&str, &str)> = changes.iter().map(|c| (c.kind.as_str(), c.name.as_str())).collect();
        assert_eq!(kinds, [
            ("channel_returned", "Back"),
            ("channel_added", "New"),
            ("channel_removed", "Gone"),
            ("category_added", "Sport"),
            ("category_removed", "Old"),
        ]);
        let refs = |name: &str| changes.iter().find(|c| c.name == name).unwrap().playlists.clone();
        let living = Some(vec![PlaylistRef { id: p, name: "Living Room".into() }]);
        assert_eq!(refs("Gone"), living);
        assert_eq!(refs("New"), living);
        assert_eq!(refs("Sport"), living);
        assert_eq!(refs("Back"), None);

        let syncs = list_syncs(&conn, s).unwrap();
        assert_eq!((syncs[0].synced_at, syncs[0].added, syncs[0].removed), (100, 3, 2));
    }
}
