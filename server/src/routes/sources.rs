use std::collections::BTreeMap;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::routing::get;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

use super::api::{ApiResult, bad_request, found, iso, iso_opt, kinds, ok, redirect};
use super::{AppState, form::Form};
use crate::models::Source;
use crate::output::cache::invalidate_all;
use crate::sources::categories::{SourceCategory, list_source_categories, set_all_source_categories, set_source_category_enabled, source_category_summaries};
use crate::sources::changes::{changes_for_sync, list_syncs, PlaylistRef};
use crate::sources::channels::{AUTO_OPEN_LIMIT, CategoryCount, SOURCE_CHANNEL_LIMIT, SourceChannelRow, list_source_channels, search_category_counts};
use crate::sources::form::{SourceInput, parse_source_form};
use crate::sync::start_sync;
use crate::xtream;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/sources", get(list).post(list_action))
        .route("/api/sources/new", axum::routing::post(new_action))
        .route("/api/sources/{id}", get(detail).post(detail_action))
        .route("/api/sources/{id}/edit", get(edit).post(edit_action))
        .route("/api/sources/{id}/changes", get(changes))
        .route("/api/sources/{id}/channels", get(channels))
}

/// Just the host and port of a server URL, for compact display.
fn host_from_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.to_string(),
            _ => url.to_string(),
        },
        Err(_) => url.to_string(),
    }
}

// Account details are only known once a sync has read them. Before that they
// go out missing, so the page can say "Unknown" rather than "Never".
fn after_first_sync<T>(s: &Source, v: T) -> Option<T> {
    s.last_synced_at.map(|_| v)
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceListRow {
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    pub host: String,
    pub username: String,
    pub output_format: String,
    pub sync_interval_minutes: i64,
    #[ts(as = "kinds::SyncStatus")]
    pub sync_status: String,
    #[ts(as = "kinds::SourceProbeStatus")]
    pub probe_status: String,
    pub probe_done: i64,
    pub probe_total: i64,
    pub channel_count: i64,
    pub channels_on: i64,
    pub categories_total: i64,
    pub categories_on: i64,
    pub last_synced_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expires_at: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_connections: Option<Option<i64>>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct SourcesData {
    pub sources: Vec<SourceListRow>,
}

async fn list(State(state): State<AppState>) -> ApiResult {
    let data = state
        .db
        .call(|conn| {
            let summaries = source_category_summaries(conn)?;
            let sources = Source::all(conn)?
                .into_iter()
                .map(|s| {
                    let summary = summaries.get(&s.id).cloned().unwrap_or_default();
                    SourceListRow {
                        expires_at: after_first_sync(&s, iso_opt(s.expires_at)),
                        max_connections: after_first_sync(&s, s.max_connections),
                        id: s.id,
                        enabled: s.enabled,
                        host: host_from_url(&s.server_url),
                        username: s.username.clone(),
                        output_format: s.output_format.clone(),
                        sync_interval_minutes: s.sync_interval_minutes,
                        sync_status: s.sync_status.clone(),
                        probe_status: s.probe_status.clone(),
                        probe_done: s.probe_done,
                        probe_total: s.probe_total,
                        channel_count: s.channel_count,
                        channels_on: (s.channel_count - summary.off_channels).max(0),
                        categories_total: summary.categories_total,
                        categories_on: summary.categories_on,
                        last_synced_at: iso_opt(s.last_synced_at),
                        name: s.name,
                    }
                })
                .collect();
            Ok(SourcesData { sources })
        })
        .await?;
    ok(data)
}

async fn set_enabled(state: &AppState, id: i64, enabled: bool) -> anyhow::Result<()> {
    state
        .db
        .call(move |conn| {
            conn.execute("UPDATE sources SET enabled = ? WHERE id = ?", params![enabled, id])?;
            invalidate_all();
            Ok(())
        })
        .await
}

async fn delete_source(state: &AppState, id: i64) -> anyhow::Result<()> {
    state
        .db
        .call(move |conn| {
            conn.execute("DELETE FROM sources WHERE id = ?", [id])?;
            Ok(())
        })
        .await
}

async fn list_action(State(state): State<AppState>, form: Form) -> ApiResult {
    let intent = form.intent();
    if intent == "syncAll" {
        let ids: Vec<i64> = state
            .db
            .call(|conn| {
                let mut stmt = conn.prepare("SELECT id FROM sources WHERE enabled = 1")?;
                Ok(stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
            })
            .await?;
        for id in &ids {
            start_sync(&state.db, *id).await;
        }
        return ok(json!({ "intent": "syncAll", "started": ids.len() }));
    }
    let Some(id) = form.int("id") else { return bad_request(json!({ "ok": false, "error": "Missing source" })) };
    match intent.as_str() {
        "sync" => {
            start_sync(&state.db, id).await;
            ok(json!({ "intent": "sync", "started": true }))
        }
        "probe" => {
            state.prober.start_probe(id).await;
            ok(json!({ "intent": "probe", "started": true }))
        }
        "setEnabled" => {
            let enabled = form.get("enabled") == Some("true");
            set_enabled(&state, id, enabled).await?;
            ok(json!({ "intent": "setEnabled", "enabled": enabled }))
        }
        "delete" => {
            delete_source(&state, id).await?;
            ok(json!({ "intent": "delete", "ok": true }))
        }
        _ => bad_request(json!({ "ok": false, "error": "Unknown action" })),
    }
}

async fn test_connection(input: &SourceInput) -> ApiResult {
    let account = xtream::validate_account(&xtream::Creds {
        server_url: input.server_url.clone(),
        username: input.username.clone(),
        password: input.password.clone(),
    })
    .await;
    ok(json!({ "testResult": {
        "ok": account.ok,
        "message": account.message,
        "status": account.status,
        "expiresAt": account.expires_at.map(|d| iso(d.timestamp())),
        "maxConnections": account.max_connections,
    }}))
}

fn field_errors(errors: BTreeMap<String, String>) -> ApiResult {
    bad_request(json!({ "fieldErrors": errors }))
}

const SOURCE_SETTINGS: &str = "name = ?, server_url = ?, username = ?, password = ?, output_format = ?, \
    auto_import_groups = ?, sync_interval_minutes = ?, probe_enabled = ?, probe_concurrency = ?, \
    probe_interval_minutes = ?, probe_timeout_seconds = ?, probe_measure_bitrate = ?, probe_detect_black_screen = ?";

fn settings_params(s: &SourceInput) -> Vec<rusqlite::types::Value> {
    vec![
        s.name.clone().into(),
        s.server_url.clone().into(),
        s.username.clone().into(),
        s.password.clone().into(),
        s.output_format.clone().into(),
        (s.auto_import_groups as i64).into(),
        s.sync_interval_minutes.into(),
        (s.probe_enabled as i64).into(),
        s.probe_concurrency.into(),
        s.probe_interval_minutes.into(),
        s.probe_timeout_seconds.into(),
        (s.probe_measure_bitrate as i64).into(),
        (s.probe_detect_black_screen as i64).into(),
    ]
}

async fn new_action(State(state): State<AppState>, form: Form) -> ApiResult {
    let intent = form.intent();
    let parsed = parse_source_form(&form);
    match (intent.as_str(), parsed) {
        ("test" | "create", Err(errors)) => field_errors(errors),
        ("test", Ok(input)) => test_connection(&input).await,
        ("create", Ok(input)) => {
            let id = state
                .db
                .call(move |conn| {
                    conn.execute(
                        "INSERT INTO sources (name, server_url, username, password, output_format, auto_import_groups, \
                           sync_interval_minutes, probe_enabled, probe_concurrency, probe_interval_minutes, \
                           probe_timeout_seconds, probe_measure_bitrate, probe_detect_black_screen, sync_status) \
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'syncing')",
                        rusqlite::params_from_iter(settings_params(&input)),
                    )?;
                    Ok(conn.last_insert_rowid())
                })
                .await?;
            // Sync in the background and go straight to the source page, which
            // follows along until the sync finishes.
            start_sync(&state.db, id).await;
            redirect(format!("/sources/{id}"))
        }
        _ => bad_request(json!({ "error": "Unknown action" })),
    }
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceDetail {
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    #[ts(as = "kinds::SyncStatus")]
    pub sync_status: String,
    pub last_synced_at: Option<String>,
    pub channel_count: i64,
    pub last_error: Option<String>,
    pub epg_stale: bool,
    pub sync_interval_minutes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expires_at: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_connections: Option<Option<i64>>,
    pub account_status: Option<String>,
    pub probe_enabled: bool,
    #[ts(as = "kinds::SourceProbeStatus")]
    pub probe_status: String,
    pub probe_interval_minutes: i64,
    pub last_probed_at: Option<String>,
    pub probe_total: i64,
    pub probe_done: i64,
    pub probe_error: Option<String>,
    pub notes: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct SourceDetailData {
    pub source: SourceDetail,
    pub categories: Vec<SourceCategory>,
}

async fn detail(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult {
    let data = state
        .db
        .call(move |conn| {
            let Some(s) = Source::by_id(conn, id)? else { return Ok(None) };
            let categories = list_source_categories(conn, id)?;
            Ok(Some(SourceDetailData {
                source: SourceDetail {
                    expires_at: after_first_sync(&s, iso_opt(s.expires_at)),
                    max_connections: after_first_sync(&s, s.max_connections),
                    id: s.id,
                    name: s.name,
                    enabled: s.enabled,
                    sync_status: s.sync_status,
                    last_synced_at: iso_opt(s.last_synced_at),
                    channel_count: s.channel_count,
                    last_error: s.last_error,
                    epg_stale: s.epg_stale,
                    sync_interval_minutes: s.sync_interval_minutes,
                    account_status: s.account_status,
                    probe_enabled: s.probe_enabled,
                    probe_status: s.probe_status,
                    probe_interval_minutes: s.probe_interval_minutes,
                    last_probed_at: iso_opt(s.last_probed_at),
                    probe_total: s.probe_total,
                    probe_done: s.probe_done,
                    probe_error: s.probe_error,
                    notes: s.notes,
                },
                categories,
            }))
        })
        .await?;
    ok(found(data)?)
}

async fn detail_action(State(state): State<AppState>, Path(id): Path<i64>, form: Form) -> ApiResult {
    let enabled = form.get("enabled") == Some("true");
    match form.intent().as_str() {
        "sync" => {
            start_sync(&state.db, id).await;
            ok(json!({ "intent": "sync", "started": true }))
        }
        "probe" => {
            state.prober.start_probe(id).await;
            ok(json!({ "intent": "probe", "started": true }))
        }
        "setEnabled" => {
            set_enabled(&state, id, enabled).await?;
            ok(json!({ "intent": "setEnabled", "enabled": enabled }))
        }
        "setNotes" => {
            let notes = crate::js::trim(&form.str("notes")).to_string();
            let notes = (!notes.is_empty()).then_some(notes);
            state
                .db
                .call(move |conn| {
                    conn.execute("UPDATE sources SET notes = ? WHERE id = ?", params![notes, id])?;
                    Ok(())
                })
                .await?;
            ok(json!({ "intent": "setNotes", "ok": true }))
        }
        "delete" => {
            delete_source(&state, id).await?;
            redirect("/sources")
        }
        "toggleCategory" => {
            let name = form.str("name");
            state
                .db
                .call(move |conn| {
                    set_source_category_enabled(conn, id, &name, enabled)?;
                    invalidate_all();
                    Ok(())
                })
                .await?;
            ok(json!({ "intent": "toggleCategory", "ok": true }))
        }
        "setAllCategories" => {
            state
                .db
                .call(move |conn| {
                    set_all_source_categories(conn, id, enabled)?;
                    invalidate_all();
                    Ok(())
                })
                .await?;
            ok(json!({ "intent": "setAllCategories", "ok": true }))
        }
        _ => bad_request(json!({ "ok": false, "error": "Unknown action" })),
    }
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceFormValues {
    pub name: String,
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub output_format: String,
    pub auto_import_groups: bool,
    pub sync_interval_minutes: i64,
    pub probe_enabled: bool,
    pub probe_concurrency: i64,
    pub probe_interval_minutes: i64,
    pub probe_timeout_seconds: i64,
    pub probe_measure_bitrate: bool,
    pub probe_detect_black_screen: bool,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceEditData {
    pub source: SourceFormValues,
    // Shown as guidance next to the probe concurrency field.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_connections: Option<Option<i64>>,
}

async fn edit(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult {
    let s = found(state.db.call(move |conn| Ok(Source::by_id(conn, id)?)).await?)?;
    ok(SourceEditData {
        max_connections: after_first_sync(&s, s.max_connections),
        source: SourceFormValues {
            name: s.name,
            server_url: s.server_url,
            username: s.username,
            password: s.password,
            output_format: s.output_format,
            auto_import_groups: s.auto_import_groups,
            sync_interval_minutes: s.sync_interval_minutes,
            probe_enabled: s.probe_enabled,
            probe_concurrency: s.probe_concurrency,
            probe_interval_minutes: s.probe_interval_minutes,
            probe_timeout_seconds: s.probe_timeout_seconds,
            probe_measure_bitrate: s.probe_measure_bitrate,
            probe_detect_black_screen: s.probe_detect_black_screen,
        },
    })
}

async fn edit_action(State(state): State<AppState>, Path(id): Path<i64>, form: Form) -> ApiResult {
    found(state.db.call(move |conn| Ok(Source::by_id(conn, id)?)).await?)?;
    match (form.intent().as_str(), parse_source_form(&form)) {
        ("test" | "update", Err(errors)) => field_errors(errors),
        ("test", Ok(input)) => test_connection(&input).await,
        ("update", Ok(input)) => {
            state
                .db
                .call(move |conn| {
                    let mut p = settings_params(&input);
                    p.push(id.into());
                    conn.execute(&format!("UPDATE sources SET {SOURCE_SETTINGS} WHERE id = ?"), rusqlite::params_from_iter(p))?;
                    Ok(())
                })
                .await?;
            redirect(format!("/sources/{id}"))
        }
        _ => bad_request(json!({ "error": "Unknown action" })),
    }
}

#[derive(Serialize, TS)]
#[ts(export, rename = "SourceRef")]
pub struct SourceRef {
    pub id: i64,
    pub name: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncRow {
    // Epoch milliseconds as a string, which is how the page picks a sync in
    // its address.
    pub at: String,
    pub synced_at: String,
    pub added: i64,
    pub removed: i64,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChangeRow {
    pub id: i64,
    #[ts(as = "kinds::ChangeKind")]
    pub kind: String,
    pub name: String,
    pub category_name: Option<String>,
    pub playlists: Vec<PlaylistRef>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceChangesData {
    pub source: SourceRef,
    pub syncs: Vec<SyncRow>,
    pub selected_at: Option<String>,
    pub changes: Vec<ChangeRow>,
}

#[derive(Deserialize)]
struct ChangesQuery {
    at: Option<String>,
}

async fn changes(State(state): State<AppState>, Path(id): Path<i64>, Query(q): Query<ChangesQuery>) -> ApiResult {
    let data = state
        .db
        .call(move |conn| {
            let Some(s) = Source::by_id(conn, id)? else { return Ok(None) };
            let syncs: Vec<SyncRow> = list_syncs(conn, id)?
                .into_iter()
                .map(|s| SyncRow { at: (s.synced_at * 1000).to_string(), synced_at: iso(s.synced_at), added: s.added, removed: s.removed })
                .collect();
            // The sync shown comes from ?at, defaulting to the newest.
            let selected_at = q
                .at
                .filter(|at| syncs.iter().any(|s| &s.at == at))
                .or_else(|| syncs.first().map(|s| s.at.clone()));
            let changes = match &selected_at {
                Some(at) => changes_for_sync(conn, id, at.parse::<i64>().unwrap_or(0) / 1000)?
                    .into_iter()
                    .map(|c| ChangeRow {
                        id: c.id,
                        kind: c.kind,
                        name: c.name,
                        category_name: c.category_name,
                        playlists: c.playlists.unwrap_or_default(),
                    })
                    .collect(),
                None => vec![],
            };
            Ok(Some(SourceChangesData { source: SourceRef { id: s.id, name: s.name }, syncs, selected_at, changes }))
        })
        .await?;
    ok(found(data)?)
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct SourceChannelsData {
    pub q: String,
    pub channels: Vec<SourceChannelRow>,
    pub total: i64,
    pub counts: Option<Vec<CategoryCount>>,
    pub limit: i64,
}

#[derive(Deserialize)]
struct ChannelsQuery {
    q: Option<String>,
    category: Option<String>,
}

/// The channels behind the category list on the source page, loaded on
/// demand so toggling a category doesn't reload a catalog of tens of
/// thousands. With `category`, that category's channels, optionally searched.
/// With `q` alone, how many channels match in each category.
async fn channels(State(state): State<AppState>, Path(id): Path<i64>, Query(query): Query<ChannelsQuery>) -> ApiResult {
    let data = state
        .db
        .call(move |conn| {
            let q = crate::js::trim(query.q.as_deref().unwrap_or("")).to_string();
            if let Some(category) = query.category.filter(|c| !c.is_empty()) {
                let (channels, total) = list_source_channels(conn, id, Some(&category), Some(&q))?;
                return Ok(SourceChannelsData { q, channels, total, counts: None, limit: SOURCE_CHANNEL_LIMIT });
            }
            if q.is_empty() {
                return Ok(SourceChannelsData { q, channels: vec![], total: 0, counts: Some(vec![]), limit: SOURCE_CHANNEL_LIMIT });
            }
            let counts = search_category_counts(conn, id, &q)?;
            // A search that lands in only a few categories sends their channels
            // along too. The page opens those categories straight away, and a
            // second fetch would make the channels pop in a moment later.
            let narrow = !counts.is_empty() && counts.len() <= AUTO_OPEN_LIMIT;
            let (channels, total) = if narrow {
                list_source_channels(conn, id, None, Some(&q))?
            } else {
                (vec![], counts.iter().map(|c| c.count).sum())
            };
            Ok(SourceChannelsData { q, channels, total, counts: Some(counts), limit: SOURCE_CHANNEL_LIMIT })
        })
        .await?;
    ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_from_url_keeps_the_port() {
        assert_eq!(host_from_url("http://example.com:8080/x"), "example.com:8080");
        assert_eq!(host_from_url("https://example.com"), "example.com");
        assert_eq!(host_from_url("not a url"), "not a url");
    }
}
