use std::collections::{HashMap, HashSet};

use anyhow::Result;
use chrono::DateTime;
use rusqlite::{Connection, params_from_iter};

use super::resolve::ResolvedChannel;
use crate::db::{ID_CHUNK, placeholders};

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Unix seconds as an XMLTV UTC timestamp, like "20240115140000 +0000".
pub fn format_xmltv_time(ts: i64) -> String {
    DateTime::from_timestamp(ts, 0)
        .map(|d| d.format("%Y%m%d%H%M%S +0000").to_string())
        .unwrap_or_default()
}

pub struct StoredProgramme {
    pub channel_id: String,
    pub start_ts: i64,
    pub stop_ts: i64,
    pub title: Option<String>,
    pub sub_title: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
}

fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

pub fn programme_block(p: &StoredProgramme) -> String {
    let mut lines = vec![format!(
        "  <programme start=\"{}\" stop=\"{}\" channel=\"{}\">",
        format_xmltv_time(p.start_ts),
        format_xmltv_time(p.stop_ts),
        escape_xml(&p.channel_id)
    )];
    if let Some(t) = non_empty(&p.title) {
        lines.push(format!("    <title>{}</title>", escape_xml(t)));
    }
    if let Some(t) = non_empty(&p.sub_title) {
        lines.push(format!("    <sub-title>{}</sub-title>", escape_xml(t)));
    }
    if let Some(t) = non_empty(&p.description) {
        lines.push(format!("    <desc>{}</desc>", escape_xml(t)));
    }
    if let Some(t) = non_empty(&p.category) {
        lines.push(format!("    <category>{}</category>", escape_xml(t)));
    }
    lines.push("  </programme>".into());
    lines.join("\n")
}

fn channel_block(id: &str, display_name: &Option<String>, icon: &Option<String>) -> String {
    let mut lines = vec![format!("  <channel id=\"{}\">", escape_xml(id))];
    if let Some(n) = non_empty(display_name) {
        lines.push(format!("    <display-name>{}</display-name>", escape_xml(n)));
    }
    if let Some(i) = non_empty(icon) {
        lines.push(format!("    <icon src=\"{}\" />", escape_xml(i)));
    }
    lines.push("  </channel>".into());
    lines.join("\n")
}

/// The merged XMLTV guide, built from what sync stored, so it matches what the
/// in-app guide shows.
pub fn build_xmltv(conn: &Connection, rows: &[ResolvedChannel]) -> Result<String> {
    // Channel ids each source has to contribute, in first-seen order.
    let mut sources: Vec<i64> = Vec::new();
    let mut needed: HashMap<i64, (Vec<String>, HashSet<String>)> = HashMap::new();
    for r in rows {
        if r.tvg_id.is_empty() {
            continue;
        }
        let entry = needed.entry(r.epg_source_id).or_insert_with(|| {
            sources.push(r.epg_source_id);
            (Vec::new(), HashSet::new())
        });
        if entry.1.insert(r.tvg_id.clone()) {
            entry.0.push(r.tvg_id.clone());
        }
    }

    let mut channel_parts = Vec::new();
    let mut programme_parts = Vec::new();
    // A channel id shared by several sources is only emitted once, from the
    // first source that defines it.
    let mut seen = HashSet::new();

    for source_id in sources {
        let ids = &needed[&source_id].0;
        for chunk in ids.chunks(ID_CHUNK) {
            let mut args: Vec<rusqlite::types::Value> = vec![source_id.into()];
            args.extend(chunk.iter().map(|s| s.clone().into()));
            let ph = placeholders(chunk.len());

            let mut stmt = conn.prepare_cached(&format!(
                "SELECT channel_id, display_name, icon FROM source_epg_channels \
                 WHERE source_id = ? AND channel_id IN ({ph})"
            ))?;
            let defs = stmt.query_map(params_from_iter(args.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?))
            })?;
            for d in defs {
                let (id, name, icon) = d?;
                if seen.insert(id.clone()) {
                    channel_parts.push(channel_block(&id, &name, &icon));
                }
            }

            let mut stmt = conn.prepare_cached(&format!(
                "SELECT channel_id, start_ts, stop_ts, title, sub_title, description, category \
                 FROM epg_programmes WHERE source_id = ? AND channel_id IN ({ph}) \
                 ORDER BY channel_id, start_ts"
            ))?;
            let progs = stmt.query_map(params_from_iter(args.iter()), |r| {
                Ok(StoredProgramme {
                    channel_id: r.get(0)?,
                    start_ts: r.get(1)?,
                    stop_ts: r.get(2)?,
                    title: r.get(3)?,
                    sub_title: r.get(4)?,
                    description: r.get(5)?,
                    category: r.get(6)?,
                })
            })?;
            for p in progs {
                programme_parts.push(programme_block(&p?));
            }
        }
    }

    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv generator-info-name=\"bouquet\">\n");
    for parts in [channel_parts, programme_parts] {
        if !parts.is_empty() {
            out.push_str(&parts.join("\n"));
            out.push('\n');
        }
    }
    out.push_str("</tv>\n");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(y: i32, m: u32, d: u32, h: u32) -> i64 {
        chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, 0, 0).unwrap().and_utc().timestamp()
    }

    #[test]
    fn formats_utc_time() {
        assert_eq!(format_xmltv_time(ts(2024, 1, 15, 14)), "20240115140000 +0000");
    }

    #[test]
    fn programme_block_from_stored_fields() {
        let block = programme_block(&StoredProgramme {
            channel_id: "bbc1.uk".into(),
            start_ts: ts(2024, 1, 15, 14),
            stop_ts: ts(2024, 1, 15, 15),
            title: Some("The News".into()),
            sub_title: None,
            description: Some("Headlines & weather.".into()),
            category: None,
        });
        assert!(block.contains("channel=\"bbc1.uk\""));
        assert!(block.contains("start=\"20240115140000 +0000\""));
        assert!(block.contains("stop=\"20240115150000 +0000\""));
        assert!(block.contains("<title>The News</title>"));
        assert!(block.contains("<desc>Headlines &amp; weather.</desc>"));
    }

    #[test]
    fn programme_block_omits_unset_fields() {
        let block = programme_block(&StoredProgramme {
            channel_id: "itv.uk".into(),
            start_ts: 100,
            stop_ts: 200,
            title: Some("Soap".into()),
            sub_title: None,
            description: None,
            category: None,
        });
        assert!(!block.contains("sub-title"));
        assert!(!block.contains("<desc>"));
        assert!(!block.contains("<category>"));
    }
}
