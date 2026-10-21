use std::collections::BTreeSet;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

use super::AppState;
use super::api::{ApiResult, found, ok};
use crate::guide::{GuideCategory, GuideSource, playlist_guide};
use crate::models::Playlist;
use crate::output::resolve::resolve_playlist_channels;
use crate::jobs::{Trigger, Work};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/playlists/{id}/guide", get(load).post(refresh))
}

// A few days either side of the anchor, so moving between days happens in the
// browser and doesn't refetch (and flicker) at each boundary.
const WINDOW_PAST_MS: i64 = 3 * 24 * 3_600_000;
const WINDOW_FUTURE_MS: i64 = 24 * 3_600_000;

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GuideData {
    pub playlist_id: i64,
    pub playlist_name: String,
    pub categories: Vec<GuideCategory>,
    pub from_ms: i64,
    pub to_ms: i64,
    pub at_ms: i64,
    pub now_ms: i64,
    pub sources: Vec<GuideSource>,
    pub needs_sync: bool,
}

#[derive(Deserialize)]
struct GuideQuery {
    at: Option<String>,
}

async fn load(State(state): State<AppState>, Path(id): Path<i64>, Query(q): Query<GuideQuery>) -> ApiResult {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let at = q.at.and_then(|a| a.trim().parse::<f64>().ok()).filter(|a| a.is_finite() && *a > 0.0);
    let at_ms = at.map(|a| a as i64).unwrap_or(now_ms);
    let (from_ms, to_ms) = (at_ms - WINDOW_PAST_MS, at_ms + WINDOW_FUTURE_MS);
    let guide = state.db.call(move |conn| playlist_guide(conn, id, from_ms.div_euclid(1000), to_ms.div_euclid(1000))).await?;
    let guide = found(guide)?;
    ok(GuideData {
        playlist_id: id,
        playlist_name: guide.playlist.name,
        needs_sync: guide.sources.iter().any(|s| s.epg_stale || s.last_synced_at.is_none()),
        categories: guide.categories,
        from_ms,
        to_ms,
        at_ms,
        now_ms,
        sources: guide.sources,
    })
}

/// Sync every source behind the playlist's guide.
async fn refresh(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult {
    let source_ids = state
        .db
        .call(move |conn| {
            let Some(p) = Playlist::by_id(conn, id)? else { return Ok(None) };
            let ids: BTreeSet<i64> = resolve_playlist_channels(conn, &p)?.iter().map(|c| c.epg_source_id).collect();
            Ok(Some(ids))
        })
        .await?;
    let source_ids = found(source_ids)?;
    for sid in &source_ids {
        state.jobs.enqueue(Work::Sync { source_id: *sid }, Trigger::Manual).await?;
    }
    ok(json!({ "ok": true, "count": source_ids.len() }))
}
