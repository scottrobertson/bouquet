//! The playlist editor: its page data, every edit it posts, and the two lists
//! it loads on demand (the source browser and the EPG picker).

use std::collections::{BTreeMap, HashMap};

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::get;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use super::api::{ApiResult, bad_request, found, ok};
use super::{AppState, external_origin, form::Form};
use crate::models::Playlist;
use crate::output::cache::invalidate;
use crate::playlist::mutations as m;
use crate::playlist::queries::{
    self as q, AutoChannelView, BROWSER_LIMIT, BrowserChannel, BrowserFilter, EditorCategory, EditorChannel, EpgChannel,
};
use crate::probe::{Only, PlaylistFilter, clear_playlist_probes};
use crate::smart_sort::SmartSortConfig;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/playlists/{id}", get(load).post(act))
        .route("/api/playlists/{id}/epg-channels", get(epg_channels))
        .route("/api/playlists/{id}/source-channels", get(source_channels))
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditorPlaylist {
    pub id: i64,
    pub name: String,
    pub channel_name_template: String,
    // The editor runs the same sort in the browser to flag groups that are out
    // of order, so it needs the settings the real sort uses.
    pub smart_sort: SmartSortConfig,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditorOutput {
    pub m3u_url: String,
    pub epg_url: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditorData {
    pub playlist: EditorPlaylist,
    pub output: EditorOutput,
    pub categories: Vec<EditorCategory>,
    pub channels: Vec<EditorChannel>,
    // Keyed by playlist category id.
    pub auto_channels: HashMap<String, Vec<AutoChannelView>>,
    pub any_probing: bool,
}

/// Kept light on purpose: the source browser loads on its own, so editing the
/// playlist only reloads the playlist.
async fn load(State(state): State<AppState>, Path(id): Path<i64>, headers: HeaderMap) -> ApiResult {
    let origin = external_origin(&headers);
    let data = state
        .db
        .call(move |conn| {
            let Some(p) = Playlist::by_id(conn, id)? else { return Ok(None) };
            let cats = q::categories(conn, id)?;
            let mirrors: Vec<(i64, (i64, String))> = cats.iter().filter_map(|(c, m)| m.clone().map(|m| (c.id, m))).collect();
            Ok(Some(EditorData {
                output: EditorOutput {
                    m3u_url: format!("{origin}/output/m3u/{}", p.output_token),
                    epg_url: format!("{origin}/output/epg/{}", p.output_token),
                },
                channels: q::playlist_channels(conn, id, &p.alt_name_template)?,
                auto_channels: q::auto_channels(conn, &mirrors)?,
                any_probing: q::has_probing_source(conn, id)?,
                categories: cats.into_iter().map(|(c, _)| c).collect(),
                playlist: EditorPlaylist {
                    smart_sort: p.smart_sort_config(),
                    id: p.id,
                    name: p.name,
                    channel_name_template: p.channel_name_template,
                },
            }))
        })
        .await?;
    ok(found(data)?)
}

fn int_or_none(form: &Form, key: &str) -> i64 {
    // A missing or garbled id can't match a row, so the edit quietly does nothing.
    form.int(key).unwrap_or(-1)
}

async fn act(State(state): State<AppState>, Path(id): Path<i64>, form: Form) -> ApiResult {
    let playlist = found(state.db.call(move |conn| Ok(Playlist::by_id(conn, id)?)).await?)?;
    let intent = form.intent();
    let done = |extra: Value| {
        let mut body = json!({ "ok": true, "intent": intent });
        if let (Value::Object(b), Value::Object(e)) = (&mut body, extra) {
            b.extend(e);
        }
        ok(body)
    };
    let db = &state.db;
    let prober = &state.prober;
    let channel_ids = form.ints("channelIds");

    // Runs one edit against the database and reports it done.
    macro_rules! edit {
        ($body:expr) => {{
            db.call(move |conn| $body(conn)).await?;
            done(json!({}))
        }};
    }

    match intent.as_str() {
        "addChannels" => {
            let ids = form.ints("sourceChannelIds");
            let Some(category_id) = form.int("categoryId") else {
                return bad_request(json!({ "ok": false, "error": "Pick a category" }));
            };
            let index = form.get("index").filter(|v| !v.is_empty()).and_then(|v| v.trim().parse::<i64>().ok());
            let added = db.call(move |conn| m::add_channels(conn, id, category_id, &ids, index)).await?;
            let n = added.len();
            prober.probe_added_channels(added).await?;
            done(json!({ "added": n }))
        }
        "addSourceCategory" => {
            // A whole source group becomes a new category named after it.
            let source_id = form.int("sourceId");
            let name = crate::js::trim(&form.str("categoryName")).to_string();
            let (Some(source_id), false) = (source_id, name.is_empty()) else {
                return bad_request(json!({ "ok": false, "error": "Missing group" }));
            };
            let added = db
                .call(move |conn| {
                    let filter = BrowserFilter {
                        source_id: Some(source_id),
                        categories: vec![name.clone()],
                        exclude_playlist_id: Some(id),
                        ..Default::default()
                    };
                    let ids = q::matching_source_channel_ids(conn, &filter)?;
                    let Some(cat) = m::create_category(conn, id, &name)? else { return Ok(None) };
                    Ok(Some(m::add_channels(conn, id, cat, &ids, None)?))
                })
                .await?;
            let Some(added) = added else {
                return bad_request(json!({ "ok": false, "error": "Could not create category" }));
            };
            let n = added.len();
            prober.probe_added_channels(added).await?;
            done(json!({ "added": n }))
        }
        "addMatching" => {
            // Every source channel matching the browser's current filter.
            let categories: Vec<String> = form.str("categories").split(',').filter(|c| !c.is_empty()).map(String::from).collect();
            let search = crate::js::trim(&form.str("q")).to_string();
            let Some(category_id) = form.int("categoryId") else {
                return bad_request(json!({ "ok": false, "error": "Pick a category" }));
            };
            let added = db
                .call(move |conn| {
                    let filter = BrowserFilter {
                        categories,
                        q: (!search.is_empty()).then_some(search),
                        exclude_playlist_id: Some(id),
                        ..Default::default()
                    };
                    let ids = q::matching_source_channel_ids(conn, &filter)?;
                    m::add_channels(conn, id, category_id, &ids, None)
                })
                .await?;
            let n = added.len();
            prober.probe_added_channels(added).await?;
            done(json!({ "added": n }))
        }
        "createCategory" => {
            let name = form.str("name");
            match db.call(move |conn| m::create_category(conn, id, &name)).await? {
                Some(_) => done(json!({})),
                None => bad_request(json!({ "ok": false, "error": "Name is required" })),
            }
        }
        "createAutoCategory" => {
            let source_id = form.int("sourceId");
            let (category_name, name) = (form.str("categoryName"), form.str("name"));
            let Some(source_id) =
                source_id.filter(|_| !crate::js::trim(&category_name).is_empty() && !crate::js::trim(&name).is_empty())
            else {
                return bad_request(json!({ "ok": false, "error": "Missing fields" }));
            };
            match db.call(move |conn| m::create_auto_category(conn, id, source_id, &category_name, &name)).await? {
                Some(_) => {
                    // An auto group adds live channels to output, so show them now.
                    invalidate(&playlist.output_token);
                    done(json!({}))
                }
                None => bad_request(json!({ "ok": false, "error": "Could not create category" })),
            }
        }
        "renameCategory" => {
            let (category_id, name) = (int_or_none(&form, "categoryId"), form.str("name"));
            edit!(move |conn| m::rename_category(conn, id, category_id, &name))
        }
        "deleteCategory" => {
            let category_id = int_or_none(&form, "categoryId");
            db.call(move |conn| m::delete_category(conn, id, category_id)).await?;
            // An auto group adds live channels to output, so refresh it.
            invalidate(&playlist.output_token);
            done(json!({}))
        }
        "reorderCategories" => {
            let ids = form.ints("categoryIds");
            edit!(move |conn| m::reorder_categories(conn, id, &ids))
        }
        "reorder" => {
            let order: Option<BTreeMap<String, Vec<i64>>> = serde_json::from_str(form.get("order").unwrap_or("{}")).ok();
            let (Some(moved), Some(to), Some(order)) = (form.int("movedId"), form.int("toCategoryId"), order) else {
                return bad_request(json!({ "ok": false, "error": "Bad reorder payload" }));
            };
            edit!(move |conn| m::reorder_channels(conn, id, moved, to, &order))
        }
        "renameChannel" => {
            let (channel_id, name) = (int_or_none(&form, "channelId"), form.str("customName"));
            edit!(move |conn| m::rename_channel(conn, id, channel_id, &name))
        }
        "toggleChannel" => {
            let (channel_id, enabled) = (int_or_none(&form, "channelId"), form.get("enabled") == Some("true"));
            edit!(move |conn| m::toggle_channel(conn, id, channel_id, enabled))
        }
        "probeChannel" => {
            // One channel on demand, whatever its source's probe setting. Waits,
            // so the row shows the result when the page reloads.
            prober.probe_single_channel(int_or_none(&form, "sourceChannelId")).await?;
            done(json!({}))
        }
        "probeGroup" => {
            let queued = prober.start_probe_group(id, int_or_none(&form, "primaryId")).await?;
            done(json!({ "queued": queued }))
        }
        "probeAll" | "probeMissing" | "probeFailed" | "probeAutoDisabled" | "probeCategory" => {
            let filter = PlaylistFilter {
                category_id: (intent == "probeCategory").then(|| int_or_none(&form, "categoryId")),
                only: match intent.as_str() {
                    "probeMissing" => Some(Only::Missing),
                    "probeFailed" => Some(Only::Failed),
                    "probeAutoDisabled" => Some(Only::AutoDisabled),
                    _ => None,
                },
            };
            let queued = prober.start_probe_playlist(id, filter).await?;
            done(json!({ "queued": queued }))
        }
        "clearProbes" => {
            let cleared = db.call(move |conn| clear_playlist_probes(conn, id)).await?;
            done(json!({ "cleared": cleared }))
        }
        "setEpg" => {
            let channel_id = int_or_none(&form, "channelId");
            let source = form.get("epgSourceId").filter(|v| !v.is_empty()).map(|v| v.trim().parse::<i64>().unwrap_or(-1));
            let channel = form.get("epgChannelId").filter(|v| !v.is_empty()).map(String::from);
            edit!(move |conn| m::set_epg(conn, id, channel_id, source, channel.as_deref()))
        }
        "removeChannel" => {
            let channel_id = int_or_none(&form, "channelId");
            edit!(move |conn| m::remove_channel(conn, id, channel_id))
        }
        "makeAlternates" => {
            let (primary, ids) = (int_or_none(&form, "primaryId"), form.ints("alternateIds"));
            edit!(move |conn| m::make_alternates(conn, id, primary, &ids))
        }
        "addAlternates" => {
            let (primary, ids) = (int_or_none(&form, "primaryId"), form.ints("sourceChannelIds"));
            let added = db.call(move |conn| m::add_alternates(conn, id, primary, &ids)).await?;
            let n = added.len();
            prober.probe_added_channels(added).await?;
            done(json!({ "added": n }))
        }
        "reorderAlternates" => {
            let (primary, ids) = (int_or_none(&form, "primaryId"), form.ints("alternateIds"));
            edit!(move |conn| m::reorder_alternates(conn, id, primary, &ids))
        }
        "promoteAlternate" => {
            let channel_id = int_or_none(&form, "channelId");
            edit!(move |conn| m::promote_alternate(conn, id, channel_id))
        }
        "previewSmartSort" => {
            // The order without applying it, so the editor can show what would
            // change and why before it's confirmed.
            let config = playlist.smart_sort_config();
            let primary = int_or_none(&form, "primaryId");
            let streams = db.call(move |conn| q::smart_sort_preview(conn, id, primary, &config)).await?;
            done(json!({ "config": config, "streams": streams }))
        }
        "smartSortGroup" => {
            let (config, primary) = (playlist.smart_sort_config(), int_or_none(&form, "primaryId"));
            edit!(move |conn| m::smart_sort_group(conn, id, primary, &config))
        }
        "ungroupAlternate" => {
            let channel_id = int_or_none(&form, "channelId");
            edit!(move |conn| m::ungroup_alternate(conn, id, channel_id))
        }
        "ungroupPrimary" => {
            let primary = int_or_none(&form, "primaryId");
            edit!(move |conn| m::ungroup_primary(conn, id, primary))
        }
        "bulkToggle" => {
            let enabled = form.get("enabled") == Some("true");
            edit!(move |conn| m::bulk_toggle(conn, id, &channel_ids, enabled))
        }
        "bulkMove" => {
            let to = int_or_none(&form, "toCategoryId");
            edit!(move |conn| m::bulk_move(conn, id, &channel_ids, to))
        }
        "bulkRemove" => edit!(move |conn| m::bulk_remove(conn, id, &channel_ids)),
        "bulkResetEpg" => edit!(move |conn| m::bulk_reset_epg(conn, id, &channel_ids)),
        "bulkSort" => {
            let descending = form.get("direction") == Some("desc");
            edit!(move |conn| m::bulk_sort(conn, id, &channel_ids, descending))
        }
        "bulkPrefix" => {
            let text = form.str("text");
            edit!(move |conn| m::bulk_add_prefix(conn, id, &channel_ids, &text))
        }
        "bulkSuffix" => {
            let text = form.str("text");
            edit!(move |conn| m::bulk_add_suffix(conn, id, &channel_ids, &text))
        }
        "bulkReplace" => {
            let (search, replace) = (form.str("search"), form.str("replace"));
            edit!(move |conn| m::bulk_replace(conn, id, &channel_ids, &search, &replace))
        }
        _ => bad_request(json!({ "ok": false, "error": "Unknown action" })),
    }
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EpgChannelsData {
    pub epg_channels: Vec<EpgChannel>,
}

/// There can be thousands of EPG channels, so the picker loads them only when
/// it opens.
async fn epg_channels(State(state): State<AppState>) -> ApiResult {
    let epg_channels = state.db.call(|conn| q::epg_channels(conn)).await?;
    ok(EpgChannelsData { epg_channels })
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceBrowserData {
    pub channels: Vec<BrowserChannel>,
    pub categories: Vec<String>,
    pub total: i64,
    pub already_added: i64,
    pub limit: i64,
}

#[derive(Deserialize)]
struct BrowserQuery {
    categories: Option<String>,
    q: Option<String>,
}

/// The source browser's channels across every source, kept out of the editor's
/// own data so edits never reload this potentially huge list.
async fn source_channels(State(state): State<AppState>, Path(id): Path<i64>, Query(query): Query<BrowserQuery>) -> ApiResult {
    let data = state
        .db
        .call(move |conn| {
            let search = crate::js::trim(query.q.as_deref().unwrap_or("")).to_string();
            let filter = BrowserFilter {
                categories: query.categories.unwrap_or_default().split(',').filter(|c| !c.is_empty()).map(String::from).collect(),
                q: (!search.is_empty()).then_some(search),
                exclude_playlist_id: Some(id),
                ..Default::default()
            };
            let (channels, total, already_added) = q::browser_channels(conn, &filter)?;
            Ok(SourceBrowserData { channels, categories: q::browser_categories(conn)?, total, already_added, limit: BROWSER_LIMIT })
        })
        .await?;
    ok(data)
}
