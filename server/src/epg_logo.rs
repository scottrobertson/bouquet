use std::collections::{BTreeSet, HashMap};

use anyhow::Result;
use rusqlite::{Connection, params_from_iter};

use crate::db::{ID_CHUNK, placeholders};

/// What's needed to work out a channel's EPG logo: its own source and that
/// source's default EPG id, plus any per-playlist EPG override.
#[derive(Debug, Clone)]
pub struct EpgLogoRef {
    pub channel_source_id: i64,
    pub source_default_epg_id: Option<String>,
    pub epg_source_id: Option<i64>,
    pub epg_channel_id: Option<String>,
}

/// The EPG channel a ref points at, but only when it isn't the channel's own
/// source default. The default keeps the source logo; a custom pick borrows the
/// picked EPG channel's logo.
fn custom_epg(r: &EpgLogoRef) -> Option<(i64, String)> {
    let source_id = r.epg_source_id.unwrap_or(r.channel_source_id);
    let channel_id = r.epg_channel_id.as_ref().or(r.source_default_epg_id.as_ref())?;
    if channel_id.is_empty() {
        return None;
    }
    if source_id == r.channel_source_id && Some(channel_id) == r.source_default_epg_id.as_ref() {
        return None;
    }
    Some((source_id, channel_id.clone()))
}

/// Icons for the custom EPG picks among `refs`. Each EPG channel's icon is the
/// logo of the source channel it came from, so picking another provider's EPG
/// borrows that provider's logo.
pub struct EpgLogos(HashMap<(i64, String), String>);

impl EpgLogos {
    pub fn load(conn: &Connection, refs: &[EpgLogoRef]) -> Result<EpgLogos> {
        let mut source_ids = BTreeSet::new();
        let mut channel_ids = BTreeSet::new();
        for r in refs {
            if let Some((s, c)) = custom_epg(r) {
                source_ids.insert(s);
                channel_ids.insert(c);
            }
        }
        let mut by_key = HashMap::new();
        if channel_ids.is_empty() {
            return Ok(EpgLogos(by_key));
        }
        let source_ids: Vec<i64> = source_ids.into_iter().collect();
        let channel_ids: Vec<String> = channel_ids.into_iter().collect();
        for chunk in channel_ids.chunks(ID_CHUNK) {
            let sql = format!(
                "SELECT source_id, channel_id, icon FROM source_epg_channels \
                 WHERE source_id IN ({}) AND channel_id IN ({})",
                placeholders(source_ids.len()),
                placeholders(chunk.len())
            );
            let mut args: Vec<rusqlite::types::Value> = source_ids.iter().map(|&s| s.into()).collect();
            args.extend(chunk.iter().map(|c| c.clone().into()));
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(args), |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
            })?;
            for row in rows {
                let (s, c, icon) = row?;
                if let Some(icon) = icon.filter(|i| !i.is_empty()) {
                    by_key.insert((s, c), icon);
                }
            }
        }
        Ok(EpgLogos(by_key))
    }

    /// The borrowed logo for a ref, or "" when it isn't a custom pick.
    pub fn get(&self, r: &EpgLogoRef) -> String {
        custom_epg(r).and_then(|k| self.0.get(&k).cloned()).unwrap_or_default()
    }
}
