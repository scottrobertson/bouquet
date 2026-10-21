//! Every edit the playlist editor can make. Each one checks that the ids it's
//! given belong to the playlist before touching them.

use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

use crate::db::id_array;
use crate::output::cache::invalidate;
use crate::pool::now;
use crate::smart_sort::{SmartSortConfig, SmartSortStream, smart_sort_order};

fn category_in_playlist(conn: &Connection, playlist_id: i64, category_id: i64) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM playlist_categories WHERE id = ? AND playlist_id = ?",
            params![category_id, playlist_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// An auto-sync category mirrors a source category and has no editable
/// channels, so channel edits must leave it alone.
fn category_is_auto(conn: &Connection, category_id: i64) -> Result<bool> {
    let auto: Option<Option<i64>> = conn
        .query_row("SELECT auto_source_id FROM playlist_categories WHERE id = ?", [category_id], |r| r.get(0))
        .optional()?;
    Ok(auto.flatten().is_some())
}

fn channel_in_playlist(conn: &Connection, playlist_id: i64, channel_id: i64) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM playlist_channels WHERE id = ? AND playlist_id = ?",
            params![channel_id, playlist_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The given ids that belong to the playlist, in the order given.
fn owned_channels(conn: &Connection, playlist_id: i64, ids: &[i64]) -> Result<Vec<i64>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare("SELECT id FROM playlist_channels WHERE id IN rarray(?) AND playlist_id = ?")?;
    let owned: HashSet<i64> = stmt
        .query_map(params![id_array(ids.iter().copied()), playlist_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut seen = HashSet::new();
    Ok(ids.iter().copied().filter(|id| owned.contains(id) && seen.insert(*id)).collect())
}

pub fn next_category_position(conn: &Connection, playlist_id: i64) -> Result<i64> {
    let max: Option<i64> =
        conn.query_row("SELECT max(position) FROM playlist_categories WHERE playlist_id = ?", [playlist_id], |r| r.get(0))?;
    Ok(max.unwrap_or(-1) + 1)
}

pub fn next_channel_position(conn: &Connection, category_id: i64) -> Result<i64> {
    let max: Option<i64> =
        conn.query_row("SELECT max(position) FROM playlist_channels WHERE category_id = ?", [category_id], |r| r.get(0))?;
    Ok(max.unwrap_or(-1) + 1)
}

fn ids_query(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(sql)?;
    Ok(stmt.query_map(p, |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

/// Renumber a primary's alternates 0..n in their current order.
fn renumber_alternates(conn: &Connection, primary_id: i64) -> Result<()> {
    let alts = ids_query(
        conn,
        "SELECT id FROM playlist_channels WHERE primary_channel_id = ? ORDER BY alt_position, id",
        [primary_id],
    )?;
    for (i, id) in alts.iter().enumerate() {
        conn.execute("UPDATE playlist_channels SET alt_position = ? WHERE id = ?", params![i as i64, id])?;
    }
    Ok(())
}

/// Move every alternate in the playlist into its primary's category, so a
/// primary that moves takes its alternates with it.
fn keep_alternates_with_primary(conn: &Connection, playlist_id: i64) -> Result<()> {
    let mut stmt = conn.prepare("SELECT id, category_id, primary_channel_id FROM playlist_channels WHERE playlist_id = ?")?;
    let rows: Vec<(i64, i64, Option<i64>)> =
        stmt.query_map([playlist_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    let category_of: HashMap<i64, i64> = rows.iter().map(|r| (r.0, r.1)).collect();
    for (id, category_id, primary) in &rows {
        let Some(primary) = primary else { continue };
        if let Some(&target) = category_of.get(primary)
            && target != *category_id
        {
            conn.execute("UPDATE playlist_channels SET category_id = ? WHERE id = ?", params![target, id])?;
        }
    }
    Ok(())
}

/// Delete channels. A deleted primary with a surviving alternate hands over to
/// that alternate, which takes the primary's place in the list.
fn perform_remove(conn: &Connection, ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let delete: HashSet<i64> = ids.iter().copied().collect();
    let tx = conn.unchecked_transaction()?;
    let mut stmt = tx.prepare("SELECT id, primary_channel_id, position FROM playlist_channels WHERE id IN rarray(?)")?;
    let rows: Vec<(i64, Option<i64>, i64)> = stmt
        .query_map([id_array(ids.iter().copied())], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);

    for (id, _, position) in &rows {
        let alts: Vec<i64> = ids_query(
            &tx,
            "SELECT id FROM playlist_channels WHERE primary_channel_id = ? ORDER BY alt_position, id",
            [id],
        )?
        .into_iter()
        .filter(|a| !delete.contains(a))
        .collect();
        let Some((&new_primary, rest)) = alts.split_first() else { continue };
        // The promoted alternate goes back to its own name, since it had none as
        // an alternate, and takes the deleted primary's position.
        tx.execute(
            "UPDATE playlist_channels SET primary_channel_id = NULL, alt_position = 0, position = ?, custom_name = NULL WHERE id = ?",
            params![position, new_primary],
        )?;
        for (i, a) in rest.iter().enumerate() {
            tx.execute(
                "UPDATE playlist_channels SET primary_channel_id = ?, alt_position = ? WHERE id = ?",
                params![new_primary, i as i64, a],
            )?;
        }
    }

    // Clear links among the rows going, so deleting a primary together with its
    // alternates never trips the foreign key.
    tx.execute("UPDATE playlist_channels SET primary_channel_id = NULL WHERE id IN rarray(?)", [id_array(ids.iter().copied())])?;
    tx.execute("DELETE FROM playlist_channels WHERE id IN rarray(?)", [id_array(ids.iter().copied())])?;

    let affected: HashSet<i64> = rows.iter().filter_map(|r| r.1).filter(|p| !delete.contains(p)).collect();
    for primary in affected {
        renumber_alternates(&tx, primary)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn create_category(conn: &Connection, playlist_id: i64, name: &str) -> Result<Option<i64>> {
    let name = crate::js::trim(name);
    if name.is_empty() {
        return Ok(None);
    }
    conn.execute(
        "INSERT INTO playlist_categories (playlist_id, name, position) VALUES (?, ?, ?)",
        params![playlist_id, name, next_category_position(conn, playlist_id)?],
    )?;
    Ok(Some(conn.last_insert_rowid()))
}

/// A category that mirrors one source category live and can't be edited.
pub fn create_auto_category(conn: &Connection, playlist_id: i64, source_id: i64, category_name: &str, name: &str) -> Result<Option<i64>> {
    let name = crate::js::trim(name);
    if name.is_empty() || crate::js::trim(category_name).is_empty() {
        return Ok(None);
    }
    conn.execute(
        "INSERT INTO playlist_categories (playlist_id, name, position, auto_source_id, auto_category_name) VALUES (?, ?, ?, ?, ?)",
        params![playlist_id, name, next_category_position(conn, playlist_id)?, source_id, category_name],
    )?;
    Ok(Some(conn.last_insert_rowid()))
}

pub fn rename_category(conn: &Connection, playlist_id: i64, category_id: i64, name: &str) -> Result<()> {
    let name = crate::js::trim(name);
    if name.is_empty() || !category_in_playlist(conn, playlist_id, category_id)? {
        return Ok(());
    }
    conn.execute("UPDATE playlist_categories SET name = ? WHERE id = ?", params![name, category_id])?;
    Ok(())
}

pub fn delete_category(conn: &Connection, playlist_id: i64, category_id: i64) -> Result<()> {
    if !category_in_playlist(conn, playlist_id, category_id)? {
        return Ok(());
    }
    // Its channels go with it through the foreign key.
    conn.execute("DELETE FROM playlist_categories WHERE id = ?", [category_id])?;
    Ok(())
}

pub fn reorder_categories(conn: &Connection, playlist_id: i64, ids: &[i64]) -> Result<()> {
    let owned: HashSet<i64> =
        ids_query(conn, "SELECT id FROM playlist_categories WHERE playlist_id = ?", [playlist_id])?.into_iter().collect();
    let tx = conn.unchecked_transaction()?;
    for (i, id) in ids.iter().enumerate() {
        if owned.contains(id) {
            tx.execute("UPDATE playlist_categories SET position = ? WHERE id = ?", params![i as i64, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Source channels in the order they were asked for, skipping unknown ids.
fn source_channels_in_order(conn: &Connection, ids: &[i64]) -> Result<Vec<(i64, i64, Option<String>)>> {
    let mut stmt = conn.prepare("SELECT id, source_id, epg_channel_id FROM source_channels WHERE id IN rarray(?)")?;
    let mut rows: Vec<(i64, i64, Option<String>)> = stmt
        .query_map([id_array(ids.iter().copied())], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let order: HashMap<i64, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    rows.sort_by_key(|r| order.get(&r.0).copied().unwrap_or(0));
    Ok(rows)
}

/// Add source channels to a category, with each one's EPG defaulting to its
/// own. Appends, or inserts at `insert_index` within the category. Returns the
/// source channels it actually added.
pub fn add_channels(conn: &Connection, playlist_id: i64, category_id: i64, source_channel_ids: &[i64], insert_index: Option<i64>) -> Result<Vec<i64>> {
    if source_channel_ids.is_empty() || !category_in_playlist(conn, playlist_id, category_id)? || category_is_auto(conn, category_id)? {
        return Ok(vec![]);
    }
    let channels = source_channels_in_order(conn, source_channel_ids)?;
    // Re-adding a channel already in this category doesn't duplicate it.
    let existing: HashSet<i64> =
        ids_query(conn, "SELECT source_channel_id FROM playlist_channels WHERE category_id = ?", [category_id])?.into_iter().collect();
    let mut seen = HashSet::new();
    let to_add: Vec<_> = channels.into_iter().filter(|c| !existing.contains(&c.0) && seen.insert(c.0)).collect();
    if to_add.is_empty() {
        return Ok(vec![]);
    }

    let tx = conn.unchecked_transaction()?;
    let current = ids_query(&tx, "SELECT id FROM playlist_channels WHERE category_id = ? ORDER BY position, id", [category_id])?;
    let mut new_ids = Vec::new();
    for (sc_id, source_id, epg) in &to_add {
        tx.execute(
            "INSERT INTO playlist_channels (playlist_id, category_id, source_channel_id, position, epg_source_id, epg_channel_id) \
             VALUES (?, ?, ?, 0, ?, ?)",
            params![playlist_id, category_id, sc_id, source_id, epg],
        )?;
        new_ids.push(tx.last_insert_rowid());
    }
    let at = insert_index.map(|i| i.clamp(0, current.len() as i64) as usize).unwrap_or(current.len());
    let ordered = current[..at].iter().chain(&new_ids).chain(&current[at..]);
    for (i, id) in ordered.enumerate() {
        tx.execute("UPDATE playlist_channels SET position = ? WHERE id = ?", params![i as i64, id])?;
    }
    tx.commit()?;
    Ok(to_add.into_iter().map(|c| c.0).collect())
}

/// Save a drag: move one channel to a category and store the new order of the
/// categories it touched.
pub fn reorder_channels(conn: &Connection, playlist_id: i64, moved_id: i64, to_category_id: i64, order: &BTreeMap<String, Vec<i64>>) -> Result<()> {
    if !channel_in_playlist(conn, playlist_id, moved_id)?
        || !category_in_playlist(conn, playlist_id, to_category_id)?
        || category_is_auto(conn, to_category_id)?
    {
        return Ok(());
    }
    let owned: HashSet<i64> =
        ids_query(conn, "SELECT id FROM playlist_channels WHERE playlist_id = ?", [playlist_id])?.into_iter().collect();
    let tx = conn.unchecked_transaction()?;
    tx.execute("UPDATE playlist_channels SET category_id = ? WHERE id = ?", params![to_category_id, moved_id])?;
    for (cat, ids) in order {
        let Ok(category_id) = cat.parse::<i64>() else { continue };
        if !category_in_playlist(&tx, playlist_id, category_id)? {
            continue;
        }
        for (i, id) in ids.iter().enumerate() {
            if owned.contains(id) {
                tx.execute(
                    "UPDATE playlist_channels SET position = ?, category_id = ? WHERE id = ?",
                    params![i as i64, category_id, id],
                )?;
            }
        }
    }
    keep_alternates_with_primary(&tx, playlist_id)?;
    tx.commit()?;
    Ok(())
}

pub fn rename_channel(conn: &Connection, playlist_id: i64, channel_id: i64, custom_name: &str) -> Result<()> {
    if !channel_in_playlist(conn, playlist_id, channel_id)? {
        return Ok(());
    }
    let row: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT sc.name, pc.primary_channel_id FROM playlist_channels pc \
             JOIN source_channels sc ON pc.source_channel_id = sc.id WHERE pc.id = ?",
            [channel_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    // Alternates are named after their primary, so they can't be renamed.
    let Some((source_name, None)) = row else { return Ok(()) };
    let trimmed = crate::js::trim(custom_name);
    // Renaming back to the source name clears the custom name.
    let next = (!trimmed.is_empty() && trimmed != source_name).then_some(trimmed);
    conn.execute("UPDATE playlist_channels SET custom_name = ? WHERE id = ?", params![next, channel_id])?;
    Ok(())
}

/// Give the streams behind these playlist channels a clean failure streak, so a
/// channel switched back on isn't switched off again by its next probe.
fn reset_failure_streak(conn: &Connection, playlist_channel_ids: &[i64]) -> Result<()> {
    conn.execute(
        "UPDATE source_channels SET consecutive_probe_failures = 0 \
         WHERE id IN (SELECT source_channel_id FROM playlist_channels WHERE id IN rarray(?))",
        [id_array(playlist_channel_ids.iter().copied())],
    )?;
    Ok(())
}

pub fn toggle_channel(conn: &Connection, playlist_id: i64, channel_id: i64, enabled: bool) -> Result<()> {
    if !channel_in_playlist(conn, playlist_id, channel_id)? {
        return Ok(());
    }
    // Any manual toggle clears the auto-disable marker.
    conn.execute(
        "UPDATE playlist_channels SET enabled = ?, auto_disabled_at = NULL WHERE id = ?",
        params![enabled, channel_id],
    )?;
    if enabled {
        reset_failure_streak(conn, &[channel_id])?;
    }
    Ok(())
}

pub fn set_epg(conn: &Connection, playlist_id: i64, channel_id: i64, epg_source_id: Option<i64>, epg_channel_id: Option<&str>) -> Result<()> {
    if !channel_in_playlist(conn, playlist_id, channel_id)? {
        return Ok(());
    }
    // Alternates always use their primary's guide.
    let primary: Option<i64> =
        conn.query_row("SELECT primary_channel_id FROM playlist_channels WHERE id = ?", [channel_id], |r| r.get(0))?;
    if primary.is_some() {
        return Ok(());
    }
    conn.execute(
        "UPDATE playlist_channels SET epg_source_id = ?, epg_channel_id = ? WHERE id = ?",
        params![epg_source_id, epg_channel_id, channel_id],
    )?;
    Ok(())
}

pub fn remove_channel(conn: &Connection, playlist_id: i64, channel_id: i64) -> Result<()> {
    if channel_in_playlist(conn, playlist_id, channel_id)? {
        perform_remove(conn, &[channel_id])?;
    }
    Ok(())
}

pub fn bulk_toggle(conn: &Connection, playlist_id: i64, ids: &[i64], enabled: bool) -> Result<()> {
    let ids = owned_channels(conn, playlist_id, ids)?;
    if ids.is_empty() {
        return Ok(());
    }
    conn.execute(
        "UPDATE playlist_channels SET enabled = ?, auto_disabled_at = NULL WHERE id IN rarray(?)",
        params![enabled, id_array(ids.iter().copied())],
    )?;
    if enabled {
        reset_failure_streak(conn, &ids)?;
    }
    Ok(())
}

pub fn bulk_remove(conn: &Connection, playlist_id: i64, ids: &[i64]) -> Result<()> {
    let ids = owned_channels(conn, playlist_id, ids)?;
    perform_remove(conn, &ids)
}

pub fn bulk_move(conn: &Connection, playlist_id: i64, ids: &[i64], to_category_id: i64) -> Result<()> {
    if !category_in_playlist(conn, playlist_id, to_category_id)? || category_is_auto(conn, to_category_id)? {
        return Ok(());
    }
    let ids = owned_channels(conn, playlist_id, ids)?;
    if ids.is_empty() {
        return Ok(());
    }
    let mut position = next_channel_position(conn, to_category_id)?;
    let tx = conn.unchecked_transaction()?;
    for id in ids {
        tx.execute(
            "UPDATE playlist_channels SET category_id = ?, position = ? WHERE id = ?",
            params![to_category_id, position, id],
        )?;
        position += 1;
    }
    keep_alternates_with_primary(&tx, playlist_id)?;
    tx.commit()?;
    Ok(())
}

/// Rename each selected primary from its current name (custom, or the source
/// name). A result that lands back on the source name clears the custom name.
fn bulk_rename(conn: &Connection, playlist_id: i64, ids: &[i64], transform: impl Fn(&str) -> String) -> Result<()> {
    let ids = owned_channels(conn, playlist_id, ids)?;
    if ids.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    let mut stmt = tx.prepare(
        "SELECT pc.id, pc.custom_name, sc.name, pc.primary_channel_id FROM playlist_channels pc \
         JOIN source_channels sc ON pc.source_channel_id = sc.id WHERE pc.id IN rarray(?)",
    )?;
    let rows: Vec<(i64, Option<String>, String, Option<i64>)> = stmt
        .query_map([id_array(ids)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    for (id, custom, source_name, primary) in rows {
        // Alternates are named after their primary.
        if primary.is_some() {
            continue;
        }
        let current = custom.unwrap_or_else(|| source_name.clone());
        let result = transform(&current);
        let result = crate::js::trim(&result);
        let next = (!result.is_empty() && result != source_name).then_some(result);
        tx.execute("UPDATE playlist_channels SET custom_name = ? WHERE id = ?", params![next, id])?;
    }
    tx.commit()?;
    Ok(())
}

pub fn bulk_add_prefix(conn: &Connection, playlist_id: i64, ids: &[i64], prefix: &str) -> Result<()> {
    if prefix.is_empty() {
        return Ok(());
    }
    bulk_rename(conn, playlist_id, ids, |c| format!("{prefix}{c}"))
}

pub fn bulk_add_suffix(conn: &Connection, playlist_id: i64, ids: &[i64], suffix: &str) -> Result<()> {
    if suffix.is_empty() {
        return Ok(());
    }
    bulk_rename(conn, playlist_id, ids, |c| format!("{c}{suffix}"))
}

/// Replace every literal occurrence of `search`. An empty `replace` removes it.
pub fn bulk_replace(conn: &Connection, playlist_id: i64, ids: &[i64], search: &str, replace: &str) -> Result<()> {
    if search.is_empty() {
        return Ok(());
    }
    bulk_rename(conn, playlist_id, ids, |c| c.replace(search, replace))
}

/// Compare names the way people expect a channel list sorted: case and accents
/// ignored, and numbers by value so "Sky 2" comes before "Sky 10".
pub fn natural_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use icu_collator::options::{CollatorOptions, Strength};
    use icu_collator::preferences::CollationNumericOrdering;
    use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
    use std::sync::LazyLock;

    static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
        let mut prefs = CollatorPreferences::default();
        prefs.numeric_ordering = Some(CollationNumericOrdering::True);
        let mut options = CollatorOptions::default();
        options.strength = Some(Strength::Primary);
        Collator::try_new(prefs, options).expect("the built-in collation data")
    });
    COLLATOR.compare(a, b)
}

/// Sort the selected primaries by name within each category, into the slots
/// they already occupy. Unselected channels stay put and alternates follow
/// their primary.
pub fn bulk_sort(conn: &Connection, playlist_id: i64, ids: &[i64], descending: bool) -> Result<()> {
    let ids = owned_channels(conn, playlist_id, ids)?;
    if ids.is_empty() {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT pc.id, pc.category_id, pc.position, pc.custom_name, sc.name, pc.primary_channel_id FROM playlist_channels pc \
         JOIN source_channels sc ON pc.source_channel_id = sc.id WHERE pc.id IN rarray(?) ORDER BY pc.id",
    )?;
    let rows: Vec<(i64, i64, i64, Option<String>, String, Option<i64>)> = stmt
        .query_map([id_array(ids)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);

    let mut by_cat: Vec<(i64, Vec<(i64, i64, String)>)> = Vec::new();
    for (id, cat, position, custom, source_name, primary) in rows {
        if primary.is_some() {
            continue;
        }
        let name = custom.unwrap_or(source_name);
        match by_cat.iter_mut().find(|(c, _)| *c == cat) {
            Some((_, list)) => list.push((id, position, name)),
            None => by_cat.push((cat, vec![(id, position, name)])),
        }
    }

    let tx = conn.unchecked_transaction()?;
    for (_, list) in by_cat {
        let mut slots: Vec<i64> = list.iter().map(|r| r.1).collect();
        slots.sort();
        let mut sorted = list;
        sorted.sort_by(|a, b| {
            let o = natural_compare(&a.2, &b.2);
            if descending { o.reverse() } else { o }
        });
        for (r, slot) in sorted.iter().zip(slots) {
            tx.execute("UPDATE playlist_channels SET position = ? WHERE id = ?", params![slot, r.0])?;
        }
    }
    tx.commit()?;
    Ok(())
}

struct Primary {
    category_id: i64,
    position: i64,
    epg_source_id: Option<i64>,
    epg_channel_id: Option<String>,
}

/// A channel that can head a group: in the playlist, not an alternate itself,
/// and not in an auto category.
fn primary_candidate(conn: &Connection, playlist_id: i64, channel_id: i64) -> Result<Option<Primary>> {
    let row: Option<(Primary, Option<i64>)> = conn
        .query_row(
            "SELECT category_id, position, epg_source_id, epg_channel_id, primary_channel_id FROM playlist_channels \
             WHERE id = ? AND playlist_id = ?",
            params![channel_id, playlist_id],
            |r| {
                Ok((
                    Primary { category_id: r.get(0)?, position: r.get(1)?, epg_source_id: r.get(2)?, epg_channel_id: r.get(3)? },
                    r.get(4)?,
                ))
            },
        )
        .optional()?;
    match row {
        Some((p, None)) if !category_is_auto(conn, p.category_id)? => Ok(Some(p)),
        _ => Ok(None),
    }
}

fn max_alt_position(conn: &Connection, primary_id: i64) -> Result<i64> {
    let max: Option<i64> =
        conn.query_row("SELECT max(alt_position) FROM playlist_channels WHERE primary_channel_id = ?", [primary_id], |r| r.get(0))?;
    Ok(max.unwrap_or(-1))
}

/// Turn playlist channels into alternates of a primary. They move into the
/// primary's category, take its guide, and drop their custom name so they're
/// named after it.
pub fn make_alternates(conn: &Connection, playlist_id: i64, primary_id: i64, alternate_ids: &[i64]) -> Result<()> {
    let Some(primary) = primary_candidate(conn, playlist_id, primary_id)? else { return Ok(()) };
    let candidates: Vec<i64> =
        owned_channels(conn, playlist_id, alternate_ids)?.into_iter().filter(|id| *id != primary_id).collect();
    if candidates.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    let mut next = max_alt_position(&tx, primary_id)? + 1;
    // Groups an alternate leaves get renumbered so their numbering stays tidy.
    let mut former = Vec::new();
    for id in candidates {
        let current: Option<i64> =
            tx.query_row("SELECT primary_channel_id FROM playlist_channels WHERE id = ?", [id], |r| r.get(0))?;
        // A primary with alternates of its own can't become an alternate, or
        // groups would nest.
        let has_own = tx
            .query_row("SELECT 1 FROM playlist_channels WHERE primary_channel_id = ? LIMIT 1", [id], |_| Ok(()))
            .optional()?
            .is_some();
        if has_own {
            continue;
        }
        if let Some(p) = current
            && p != primary_id
            && !former.contains(&p)
        {
            former.push(p);
        }
        tx.execute(
            "UPDATE playlist_channels SET primary_channel_id = ?, category_id = ?, alt_position = ?, \
               epg_source_id = ?, epg_channel_id = ?, custom_name = NULL WHERE id = ?",
            params![primary_id, primary.category_id, next, primary.epg_source_id, primary.epg_channel_id, id],
        )?;
        next += 1;
    }
    for p in former {
        renumber_alternates(&tx, p)?;
    }
    tx.commit()?;
    Ok(())
}

/// Add source channels as new alternates of a primary, taking its guide.
/// Returns the source channels it actually added.
pub fn add_alternates(conn: &Connection, playlist_id: i64, primary_id: i64, source_channel_ids: &[i64]) -> Result<Vec<i64>> {
    let Some(primary) = primary_candidate(conn, playlist_id, primary_id)? else { return Ok(vec![]) };
    if source_channel_ids.is_empty() {
        return Ok(vec![]);
    }
    let channels = source_channels_in_order(conn, source_channel_ids)?;
    // Don't duplicate a source channel already in the primary's category.
    let existing: HashSet<i64> = ids_query(
        conn,
        "SELECT source_channel_id FROM playlist_channels WHERE category_id = ?",
        [primary.category_id],
    )?
    .into_iter()
    .collect();
    let mut seen = HashSet::new();
    let to_add: Vec<i64> = channels.into_iter().map(|c| c.0).filter(|id| !existing.contains(id) && seen.insert(*id)).collect();
    if to_add.is_empty() {
        return Ok(vec![]);
    }
    let tx = conn.unchecked_transaction()?;
    let mut next = max_alt_position(&tx, primary_id)? + 1;
    for sc in &to_add {
        tx.execute(
            "INSERT INTO playlist_channels (playlist_id, category_id, source_channel_id, position, primary_channel_id, \
               alt_position, epg_source_id, epg_channel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![playlist_id, primary.category_id, sc, primary.position, primary_id, next, primary.epg_source_id, primary.epg_channel_id],
        )?;
        next += 1;
    }
    tx.commit()?;
    Ok(to_add)
}

pub fn reorder_alternates(conn: &Connection, playlist_id: i64, primary_id: i64, ordered_ids: &[i64]) -> Result<()> {
    if !channel_in_playlist(conn, playlist_id, primary_id)? {
        return Ok(());
    }
    let alts: HashSet<i64> =
        ids_query(conn, "SELECT id FROM playlist_channels WHERE primary_channel_id = ?", [primary_id])?.into_iter().collect();
    let tx = conn.unchecked_transaction()?;
    for (i, id) in ordered_ids.iter().enumerate() {
        if alts.contains(id) {
            tx.execute("UPDATE playlist_channels SET alt_position = ? WHERE id = ?", params![i as i64, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// The smart sort fields for a playlist channel row, starting at column `i`:
/// available, source enabled, auto_disabled_at, then the seven probe columns.
pub fn smart_sort_stream(r: &rusqlite::Row, i: usize) -> rusqlite::Result<SmartSortStream> {
    Ok(SmartSortStream {
        available: r.get(i)?,
        source_enabled: r.get(i + 1)?,
        auto_disabled: r.get::<_, Option<i64>>(i + 2)?.is_some(),
        probe_status: r.get(i + 3)?,
        probe_width: r.get(i + 4)?,
        probe_height: r.get(i + 5)?,
        probe_fps: r.get(i + 6)?,
        probe_video_codec: r.get(i + 7)?,
        probe_audio_codec: r.get(i + 8)?,
        probe_bitrate: r.get(i + 9)?,
    })
}

pub const SMART_SORT_COLUMNS: &str = "sc.available, s.enabled, pc.auto_disabled_at, sc.probe_status, sc.probe_width, \
    sc.probe_height, sc.probe_fps, sc.probe_video_codec, sc.probe_audio_codec, sc.probe_bitrate";

/// Reorder a whole group best-first from its probe data, putting the winner in
/// front. The group's name and guide stay with the group rather than the
/// stream, so output only changes in which stream plays.
pub fn smart_sort_group(conn: &Connection, playlist_id: i64, primary_id: i64, config: &SmartSortConfig) -> Result<()> {
    let Some(primary) = primary_candidate(conn, playlist_id, primary_id)? else { return Ok(()) };
    let mut stmt = conn.prepare(&format!(
        "SELECT pc.id, pc.custom_name, pc.epg_source_id, pc.epg_channel_id, {SMART_SORT_COLUMNS} \
         FROM playlist_channels pc JOIN source_channels sc ON pc.source_channel_id = sc.id \
         JOIN sources s ON sc.source_id = s.id \
         WHERE pc.playlist_id = ?1 AND (pc.id = ?2 OR pc.primary_channel_id = ?2) ORDER BY pc.alt_position, pc.id"
    ))?;
    struct Member {
        id: i64,
        custom_name: Option<String>,
        epg_source_id: Option<i64>,
        epg_channel_id: Option<String>,
    }
    let rows: Vec<(Member, SmartSortStream)> = stmt
        .query_map(params![playlist_id, primary_id], |r| {
            Ok((
                Member { id: r.get(0)?, custom_name: r.get(1)?, epg_source_id: r.get(2)?, epg_channel_id: r.get(3)? },
                smart_sort_stream(r, 4)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    if rows.len() < 2 {
        return Ok(());
    }
    let streams: Vec<SmartSortStream> = rows.iter().map(|r| r.1.clone()).collect();
    let order = smart_sort_order(&streams, config);
    let Some(old) = rows.iter().find(|r| r.0.id == primary_id).map(|r| &r.0) else { return Ok(()) };
    let new_primary = rows[order[0]].0.id;

    let tx = conn.unchecked_transaction()?;
    if new_primary != primary_id {
        tx.execute(
            "UPDATE playlist_channels SET primary_channel_id = NULL, alt_position = 0, position = ?, custom_name = ?, \
               epg_source_id = ?, epg_channel_id = ? WHERE id = ?",
            params![primary.position, old.custom_name, old.epg_source_id, old.epg_channel_id, new_primary],
        )?;
    }
    for (i, &idx) in order[1..].iter().enumerate() {
        tx.execute(
            "UPDATE playlist_channels SET primary_channel_id = ?, category_id = ?, alt_position = ?, custom_name = NULL, \
               epg_source_id = ?, epg_channel_id = ? WHERE id = ?",
            params![new_primary, primary.category_id, i as i64, old.epg_source_id, old.epg_channel_id, rows[idx].0.id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Make an alternate the group's primary. The old primary becomes the first
/// alternate and the others follow.
pub fn promote_alternate(conn: &Connection, playlist_id: i64, channel_id: i64) -> Result<()> {
    let old_primary_id: Option<Option<i64>> = conn
        .query_row(
            "SELECT primary_channel_id FROM playlist_channels WHERE id = ? AND playlist_id = ?",
            params![channel_id, playlist_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(Some(old_primary_id)) = old_primary_id else { return Ok(()) };
    let old: Option<(i64, Option<String>)> = conn
        .query_row("SELECT position, custom_name FROM playlist_channels WHERE id = ?", [old_primary_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let Some((position, custom_name)) = old else { return Ok(()) };
    let others: Vec<i64> = ids_query(
        conn,
        "SELECT id FROM playlist_channels WHERE primary_channel_id = ? ORDER BY alt_position, id",
        [old_primary_id],
    )?
    .into_iter()
    .filter(|id| *id != channel_id)
    .collect();

    let tx = conn.unchecked_transaction()?;
    // Picking a different primary isn't renaming the group, so the new primary
    // keeps the old one's custom name and list position.
    tx.execute(
        "UPDATE playlist_channels SET primary_channel_id = NULL, alt_position = 0, position = ?, custom_name = ? WHERE id = ?",
        params![position, custom_name, channel_id],
    )?;
    tx.execute(
        "UPDATE playlist_channels SET primary_channel_id = ?, alt_position = 0, custom_name = NULL WHERE id = ?",
        params![channel_id, old_primary_id],
    )?;
    for (i, id) in others.iter().enumerate() {
        tx.execute(
            "UPDATE playlist_channels SET primary_channel_id = ?, alt_position = ? WHERE id = ?",
            params![channel_id, i as i64 + 1, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// The first enabled alternate whose last probe passed, to stand in when a
/// failing primary is switched off.
fn working_alternate(conn: &Connection, primary_id: i64) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT pc.id FROM playlist_channels pc JOIN source_channels sc ON pc.source_channel_id = sc.id \
             WHERE pc.primary_channel_id = ? AND pc.enabled = 1 AND sc.probe_status = 'ok' \
             ORDER BY pc.alt_position, pc.id LIMIT 1",
            [primary_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// Switch off enabled channels whose stream has failed enough probes in a row
/// to reach their playlist's limit. A failing primary first hands over to a
/// working alternate, so the group keeps a live stream. Switched-off sources
/// are skipped: a failure there says nothing about the stream.
pub fn auto_disable_failed_channels(conn: &Connection, source_channel_ids: &[i64]) -> Result<()> {
    if source_channel_ids.is_empty() {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT pc.id, pc.playlist_id, pc.primary_channel_id, p.output_token FROM playlist_channels pc \
         JOIN source_channels sc ON pc.source_channel_id = sc.id JOIN sources s ON sc.source_id = s.id \
         JOIN playlists p ON pc.playlist_id = p.id \
         WHERE pc.source_channel_id IN rarray(?) AND pc.enabled = 1 AND s.enabled = 1 \
           AND p.auto_disable_failed_probes_after > 0 \
           AND sc.consecutive_probe_failures >= p.auto_disable_failed_probes_after ORDER BY pc.id",
    )?;
    let candidates: Vec<(i64, i64, Option<i64>, String)> = stmt
        .query_map([id_array(source_channel_ids.iter().copied())], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    let mut tokens = HashSet::new();
    for (channel_id, playlist_id, primary, token) in candidates {
        if primary.is_none()
            && let Some(replacement) = working_alternate(conn, channel_id)?
        {
            promote_alternate(conn, playlist_id, replacement)?;
        }
        conn.execute(
            "UPDATE playlist_channels SET enabled = 0, auto_disabled_at = ? WHERE id = ?",
            params![now(), channel_id],
        )?;
        tokens.insert(token);
    }
    for t in tokens {
        invalidate(&t);
    }
    Ok(())
}

/// Switch auto-disabled channels back on when their stream probes ok again,
/// in every playlist using it. Channels the user switched off have no marker,
/// so they stay off.
pub fn revive_recovered_channels(conn: &Connection, source_channel_ids: &[i64]) -> Result<()> {
    if source_channel_ids.is_empty() {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT pc.id, p.output_token FROM playlist_channels pc JOIN source_channels sc ON pc.source_channel_id = sc.id \
         JOIN playlists p ON pc.playlist_id = p.id \
         WHERE pc.source_channel_id IN rarray(?) AND pc.auto_disabled_at IS NOT NULL AND sc.probe_status = 'ok'",
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([id_array(source_channel_ids.iter().copied())], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    if rows.is_empty() {
        return Ok(());
    }
    conn.execute(
        "UPDATE playlist_channels SET enabled = 1, auto_disabled_at = NULL WHERE id IN rarray(?)",
        [id_array(rows.iter().map(|r| r.0))],
    )?;
    for t in rows.iter().map(|r| &r.1).collect::<HashSet<_>>() {
        invalidate(t);
    }
    Ok(())
}

/// Detach an alternate so it's a standalone channel again.
pub fn ungroup_alternate(conn: &Connection, playlist_id: i64, channel_id: i64) -> Result<()> {
    let row: Option<(i64, Option<i64>)> = conn
        .query_row(
            "SELECT category_id, primary_channel_id FROM playlist_channels WHERE id = ? AND playlist_id = ?",
            params![channel_id, playlist_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((category_id, Some(former))) = row else { return Ok(()) };
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE playlist_channels SET primary_channel_id = NULL, alt_position = 0, position = ? WHERE id = ?",
        params![next_channel_position(&tx, category_id)?, channel_id],
    )?;
    renumber_alternates(&tx, former)?;
    tx.commit()?;
    Ok(())
}

/// Detach every alternate of a primary, leaving standalone channels.
pub fn ungroup_primary(conn: &Connection, playlist_id: i64, primary_id: i64) -> Result<()> {
    if !channel_in_playlist(conn, playlist_id, primary_id)? {
        return Ok(());
    }
    let mut stmt = conn.prepare("SELECT id, category_id FROM playlist_channels WHERE primary_channel_id = ? ORDER BY id")?;
    let alts: Vec<(i64, i64)> = stmt.query_map([primary_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    if alts.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    for (id, category_id) in alts {
        tx.execute(
            "UPDATE playlist_channels SET primary_channel_id = NULL, alt_position = 0, position = ? WHERE id = ?",
            params![next_channel_position(&tx, category_id)?, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Point each selected primary back at its own source's guide.
pub fn bulk_reset_epg(conn: &Connection, playlist_id: i64, ids: &[i64]) -> Result<()> {
    let ids = owned_channels(conn, playlist_id, ids)?;
    if ids.is_empty() {
        return Ok(());
    }
    conn.execute(
        "UPDATE playlist_channels SET \
           epg_source_id = (SELECT sc.source_id FROM source_channels sc WHERE sc.id = playlist_channels.source_channel_id), \
           epg_channel_id = (SELECT sc.epg_channel_id FROM source_channels sc WHERE sc.id = playlist_channels.source_channel_id) \
         WHERE id IN rarray(?) AND primary_channel_id IS NULL",
        [id_array(ids)],
    )?;
    Ok(())
}
