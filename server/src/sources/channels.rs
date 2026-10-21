use anyhow::Result;
use rusqlite::{Connection, params_from_iter};
use serde::Serialize;
use ts_rs::TS;

/// Most channels one request sends back. A single category can hold thousands,
/// and the source screen only needs enough to find one.
pub const SOURCE_CHANNEL_LIMIT: i64 = 500;

/// How many categories a search can land in and still have them all opened on
/// screen. Past this the search was too vague for that to help.
pub const AUTO_OPEN_LIMIT: usize = 8;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceChannelRow {
    pub id: i64,
    pub name: String,
    pub logo: Option<String>,
    pub category_name: Option<String>,
    pub available: bool,
}

fn filter(source_id: i64, category: Option<&str>, q: Option<&str>) -> (String, Vec<rusqlite::types::Value>) {
    let mut sql = String::from("source_id = ?");
    let mut args: Vec<rusqlite::types::Value> = vec![source_id.into()];
    if let Some(c) = category.filter(|c| !c.is_empty()) {
        sql.push_str(" AND category_name = ?");
        args.push(c.to_string().into());
    }
    if let Some(q) = q.filter(|q| !q.is_empty()) {
        sql.push_str(" AND name LIKE ?");
        args.push(format!("%{q}%").into());
    }
    (sql, args)
}

/// Channels in a source, narrowed to a category and/or a name search. Provider
/// order, capped, with the uncapped total so the caller can say what it cut.
pub fn list_source_channels(
    conn: &Connection,
    source_id: i64,
    category: Option<&str>,
    q: Option<&str>,
) -> Result<(Vec<SourceChannelRow>, i64)> {
    let (where_sql, args) = filter(source_id, category, q);
    let total: i64 = conn.query_row(
        &format!("SELECT count(*) FROM source_channels WHERE {where_sql}"),
        params_from_iter(args.iter()),
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(&format!(
        "SELECT id, name, logo, category_name, available FROM source_channels WHERE {where_sql} \
         ORDER BY position, id LIMIT {SOURCE_CHANNEL_LIMIT}"
    ))?;
    let channels = stmt
        .query_map(params_from_iter(args.iter()), |r| {
            Ok(SourceChannelRow {
                id: r.get(0)?,
                name: r.get(1)?,
                logo: r.get(2)?,
                category_name: r.get(3)?,
                available: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok((channels, total))
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct CategoryCount {
    pub name: String,
    pub count: i64,
}

/// How many channels match a search in each category, biggest first.
pub fn search_category_counts(conn: &Connection, source_id: i64, q: &str) -> Result<Vec<CategoryCount>> {
    let mut stmt = conn.prepare(
        "SELECT category_name, count(*) FROM source_channels WHERE source_id = ? AND name LIKE ? \
         GROUP BY category_name ORDER BY count(*) DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![source_id, format!("%{q}%")], |r| {
        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        if let (Some(name), count) = row?
            && !name.is_empty()
        {
            out.push(CategoryCount { name, count });
        }
    }
    Ok(out)
}
