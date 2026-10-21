use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{Connection, params};
use serde::Serialize;
use ts_rs::TS;

// Stored programmes only cover channels that were in enabled categories at the
// last sync, so flag the source for the UI to suggest a resync.
fn mark_epg_stale(conn: &Connection, source_id: i64) -> Result<()> {
    conn.execute("UPDATE sources SET epg_stale = 1 WHERE id = ?", [source_id])?;
    Ok(())
}

/// Seed category rows for a source. New ones start as `enabled_default` (the
/// source's auto-import setting); existing rows keep their state.
pub fn sync_source_categories(conn: &Connection, source_id: i64, names: &[String], enabled_default: bool) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO source_categories (source_id, name, enabled) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        )?;
        for name in names.iter().filter(|n| !n.is_empty()) {
            stmt.execute(params![source_id, name, enabled_default])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct SourceCategory {
    pub name: String,
    pub count: i64,
    pub enabled: bool,
}

/// A source's categories with channel counts, in provider order (by first
/// channel).
pub fn list_source_categories(conn: &Connection, source_id: i64) -> Result<Vec<SourceCategory>> {
    let enabled = category_states(conn, Some(source_id))?;
    let mut stmt = conn.prepare(
        "SELECT category_name, count(*), min(id) FROM source_channels \
         WHERE source_id = ? AND category_name IS NOT NULL AND category_name != '' \
         GROUP BY category_name ORDER BY min(id)",
    )?;
    let rows = stmt.query_map([source_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (name, count) = row?;
        let on = enabled.get(&(source_id, name.clone())).copied().unwrap_or(true);
        out.push(SourceCategory { name, count, enabled: on });
    }
    Ok(out)
}

fn category_states(conn: &Connection, source_id: Option<i64>) -> Result<HashMap<(i64, String), bool>> {
    let mut stmt = conn.prepare(
        "SELECT source_id, name, enabled FROM source_categories WHERE ?1 IS NULL OR source_id = ?1",
    )?;
    let rows = stmt.query_map([source_id], |r| Ok(((r.get(0)?, r.get(1)?), r.get(2)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[derive(Debug, Clone, Default)]
pub struct CategorySummary {
    pub categories_total: i64,
    pub categories_on: i64,
    pub off_channels: i64,
}

/// Enabled and total categories plus switched-off channel counts for every
/// source. Uncategorised channels count as enabled and aren't a category.
pub fn source_category_summaries(conn: &Connection) -> Result<HashMap<i64, CategorySummary>> {
    let enabled = category_states(conn, None)?;
    let mut stmt = conn.prepare(
        "SELECT source_id, category_name, count(*) FROM source_channels \
         WHERE category_name IS NOT NULL AND category_name != '' GROUP BY source_id, category_name",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))?;
    let mut out: HashMap<i64, CategorySummary> = HashMap::new();
    for row in rows {
        let (source_id, name, n) = row?;
        let agg = out.entry(source_id).or_default();
        agg.categories_total += 1;
        if enabled.get(&(source_id, name)).copied().unwrap_or(true) {
            agg.categories_on += 1;
        } else {
            agg.off_channels += n;
        }
    }
    Ok(out)
}

pub fn set_source_category_enabled(conn: &Connection, source_id: i64, name: &str, enabled: bool) -> Result<()> {
    conn.execute(
        "INSERT INTO source_categories (source_id, name, enabled) VALUES (?, ?, ?) \
         ON CONFLICT (source_id, name) DO UPDATE SET enabled = excluded.enabled",
        params![source_id, name, enabled],
    )?;
    mark_epg_stale(conn, source_id)
}

pub fn set_all_source_categories(conn: &Connection, source_id: i64, enabled: bool) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO source_categories (source_id, name, enabled) \
         SELECT DISTINCT source_id, category_name, ?2 FROM source_channels \
         WHERE source_id = ?1 AND category_name IS NOT NULL AND category_name != '' \
         ON CONFLICT (source_id, name) DO UPDATE SET enabled = excluded.enabled",
        params![source_id, enabled],
    )?;
    tx.commit()?;
    mark_epg_stale(conn, source_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;

    #[test]
    fn categories_keep_provider_order_and_state() {
        let db = test_support::db();
        let conn = db.lock();
        let s = test_support::source(&conn, "Main");
        test_support::source_channel(&conn, s, "1", "A", "News");
        test_support::source_channel(&conn, s, "2", "B", "Sport");
        test_support::source_channel(&conn, s, "3", "C", "News");
        sync_source_categories(&conn, s, &["News".into(), "Sport".into()], true).unwrap();
        set_source_category_enabled(&conn, s, "Sport", false).unwrap();

        let cats = list_source_categories(&conn, s).unwrap();
        assert_eq!(cats.iter().map(|c| (c.name.as_str(), c.count, c.enabled)).collect::<Vec<_>>(), [
            ("News", 2, true),
            ("Sport", 1, false)
        ]);
        let summary = &source_category_summaries(&conn).unwrap()[&s];
        assert_eq!((summary.categories_total, summary.categories_on, summary.off_channels), (2, 1, 1));

        // A resync doesn't flip a category the user switched off.
        sync_source_categories(&conn, s, &["Sport".into()], true).unwrap();
        assert!(!list_source_categories(&conn, s).unwrap()[1].enabled);

        set_all_source_categories(&conn, s, false).unwrap();
        assert!(list_source_categories(&conn, s).unwrap().iter().all(|c| !c.enabled));
        let stale: bool = conn.query_row("SELECT epg_stale FROM sources WHERE id = ?", [s], |r| r.get(0)).unwrap();
        assert!(stale);
    }
}
