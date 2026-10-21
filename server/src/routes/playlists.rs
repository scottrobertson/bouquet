use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use ts_rs::TS;

use super::api::{ApiResult, bad_request, found, iso, iso_opt, kinds, ok, redirect, with_status};
use super::{AppState, external_origin, form::Form};
use crate::models::Playlist;
use crate::output::cache::invalidate;
use crate::jobs::{Trigger, Work};
use crate::upload::storage::S3Config;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/playlists", get(list).post(list_action))
        .route("/api/playlists/{id}/settings", get(settings).post(settings_action))
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlaylistListRow {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub category_count: i64,
    pub channel_count: i64,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct PlaylistsData {
    pub playlists: Vec<PlaylistListRow>,
}

async fn list(State(state): State<AppState>) -> ApiResult {
    let playlists = state
        .db
        .call(|conn| {
            let mut stmt = conn.prepare(
                "SELECT p.id, p.name, p.created_at, \
                   (SELECT count(*) FROM playlist_categories c WHERE c.playlist_id = p.id), \
                   (SELECT count(*) FROM playlist_channels pc WHERE pc.playlist_id = p.id) \
                 FROM playlists p ORDER BY p.name",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(PlaylistListRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    created_at: iso(r.get(2)?),
                    category_count: r.get(3)?,
                    channel_count: r.get(4)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    ok(PlaylistsData { playlists })
}

/// The trimmed name field, or None when it's blank.
fn name_field(form: &Form) -> Option<String> {
    let name = crate::js::trim(&form.str("name")).to_string();
    (!name.is_empty()).then_some(name)
}

fn name_required() -> ApiResult {
    bad_request(json!({ "ok": false, "error": "Name is required" }))
}

async fn list_action(State(state): State<AppState>, form: Form) -> ApiResult {
    let intent = form.intent();
    if intent == "create" {
        let Some(name) = name_field(&form) else { return name_required() };
        let id = state
            .db
            .call(move |conn| {
                conn.execute("INSERT INTO playlists (name, output_token) VALUES (?, ?)", params![name, nanoid::nanoid!()])?;
                Ok(conn.last_insert_rowid())
            })
            .await?;
        return redirect(format!("/playlists/{id}"));
    }
    let Some(id) = form.int("id") else { return bad_request(json!({ "ok": false, "error": "Missing playlist" })) };
    match intent.as_str() {
        "delete" => {
            state
                .db
                .call(move |conn| {
                    conn.execute("DELETE FROM playlists WHERE id = ?", [id])?;
                    Ok(())
                })
                .await?;
            ok(json!({ "ok": true, "intent": intent }))
        }
        _ => bad_request(json!({ "ok": false, "error": "Unknown action" })),
    }
}

/// A destination's settings for the browser. The S3 secret never leaves the
/// server; an edit that leaves it blank keeps the stored one.
#[derive(Serialize, TS, Default)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DestinationConfigView {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub access_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub force_path_style: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DestinationView {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    #[ts(rename = "type", type = r#""s3" | "local""#)]
    pub kind: String,
    pub enabled: bool,
    pub m3u_path: String,
    pub epg_path: String,
    pub public_url_base: Option<String>,
    #[ts(as = "kinds::UploadStatus")]
    pub upload_status: String,
    pub last_uploaded_at: Option<String>,
    pub upload_error: Option<String>,
    pub config: DestinationConfigView,
    pub public_m3u_url: Option<String>,
    pub public_epg_url: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlaylistSettingsView {
    pub id: i64,
    pub name: String,
    pub alt_name_template: String,
    pub channel_name_template: String,
    #[ts(type = r#""resolution" | "bitrate""#)]
    pub smart_sort_prefer: String,
    pub smart_sort_audio: bool,
    pub smart_sort_available_first: bool,
    pub auto_disable_failed_probes_after: i64,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlaylistSettingsData {
    pub playlist: PlaylistSettingsView,
    pub m3u_url: String,
    pub epg_url: String,
    pub destinations: Vec<DestinationView>,
}

fn config_view(raw: &str) -> DestinationConfigView {
    let v: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
    DestinationConfigView {
        endpoint: s("endpoint"),
        region: s("region"),
        bucket: s("bucket"),
        access_key_id: s("accessKeyId"),
        force_path_style: v.get("forcePathStyle").and_then(|x| x.as_bool()),
        prefix: s("prefix"),
        path: s("path"),
    }
}

async fn settings(State(state): State<AppState>, Path(id): Path<i64>, headers: HeaderMap) -> ApiResult {
    let origin = external_origin(&headers);
    let data = state
        .db
        .call(move |conn| {
            let Some(p) = Playlist::by_id(conn, id)? else { return Ok(None) };
            let mut stmt = conn.prepare(
                "SELECT id, name, type, enabled, m3u_path, epg_path, public_url_base, \
                   CASE \
                     WHEN EXISTS (SELECT 1 FROM jobs j WHERE j.destination_id = d.id AND j.status = 'running') THEN 'uploading' \
                     WHEN EXISTS (SELECT 1 FROM jobs j WHERE j.destination_id = d.id AND j.status = 'queued') THEN 'queued' \
                     ELSE upload_status END, \
                   last_uploaded_at, upload_error, config FROM upload_destinations d WHERE playlist_id = ? ORDER BY id",
            )?;
            let destinations = stmt
                .query_map([id], |r| {
                    let m3u_path: String = r.get(4)?;
                    let epg_path: String = r.get(5)?;
                    let public_url_base: Option<String> = r.get(6)?;
                    let base = public_url_base.as_deref().map(|b| b.trim_end_matches('/')).filter(|b| !b.is_empty());
                    let public = |path: &str| base.map(|b| format!("{b}/{}", path.trim_start_matches('/')));
                    Ok(DestinationView {
                        public_m3u_url: public(&m3u_path),
                        public_epg_url: public(&epg_path),
                        id: r.get(0)?,
                        name: r.get(1)?,
                        kind: r.get(2)?,
                        enabled: r.get(3)?,
                        m3u_path,
                        epg_path,
                        upload_status: r.get(7)?,
                        last_uploaded_at: iso_opt(r.get(8)?),
                        upload_error: r.get(9)?,
                        config: config_view(&r.get::<_, String>(10)?),
                        public_url_base,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Some(PlaylistSettingsData {
                m3u_url: format!("{origin}/output/m3u/{}", p.output_token),
                epg_url: format!("{origin}/output/epg/{}", p.output_token),
                playlist: PlaylistSettingsView {
                    id: p.id,
                    name: p.name,
                    alt_name_template: p.alt_name_template,
                    channel_name_template: p.channel_name_template,
                    smart_sort_prefer: p.smart_sort_prefer,
                    smart_sort_audio: p.smart_sort_audio,
                    smart_sort_available_first: p.smart_sort_available_first,
                    auto_disable_failed_probes_after: p.auto_disable_failed_probes_after,
                },
                destinations,
            }))
        })
        .await?;
    ok(found(data)?)
}

/// A naming template. Every template keeps {name} so the channel's name shows;
/// the alternate template also keeps {n} so each alternate gets its own number.
fn template(form: &Form, key: &str, needs_n: bool) -> Result<String, &'static str> {
    let t = crate::js::trim(&form.str(key)).to_string();
    if t.is_empty() {
        return Err("Template is required");
    }
    if !t.contains("{name}") {
        return Err("Must include {name}");
    }
    if needs_n && !t.contains("{n}") {
        return Err("Must include {n}");
    }
    Ok(t)
}

/// A destination's settings from the form. For an S3 edit a blank secret
/// keeps the stored one.
fn parse_destination_config(form: &Form, kind: &str, existing: Option<S3Config>) -> Result<String, &'static str> {
    let field = |k: &str| crate::js::trim(&form.str(k)).to_string();
    if kind == "s3" {
        let (region, bucket, access_key_id) = (field("region"), field("bucket"), field("accessKeyId"));
        let secret = form.str("secretAccessKey");
        let secret = if secret.is_empty() { existing.map(|e| e.secret_access_key).unwrap_or_default() } else { secret };
        if region.is_empty() {
            return Err("Region is required");
        }
        if bucket.is_empty() {
            return Err("Bucket is required");
        }
        if access_key_id.is_empty() {
            return Err("Access key ID is required");
        }
        if secret.is_empty() {
            return Err("Secret access key is required");
        }
        let optional = |v: String| (!v.is_empty()).then_some(v);
        let config = S3Config {
            endpoint: optional(field("endpoint")),
            region,
            bucket,
            access_key_id,
            secret_access_key: secret,
            force_path_style: Some(form.has("forcePathStyle")),
            prefix: optional(field("prefix")),
        };
        return Ok(serde_json::to_string(&config).expect("plain settings serialize"));
    }
    let path = field("path");
    if path.is_empty() {
        return Err("Folder path is required");
    }
    Ok(json!({ "path": path }).to_string())
}

fn settings_error(intent: &str, msg: &str) -> ApiResult {
    bad_request(json!({ "ok": false, "error": msg, "intent": intent }))
}

async fn update_playlist(state: &AppState, sql: &'static str, values: Vec<rusqlite::types::Value>) -> anyhow::Result<()> {
    state
        .db
        .call(move |conn| {
            conn.execute(sql, rusqlite::params_from_iter(values))?;
            Ok(())
        })
        .await
}

async fn settings_action(State(state): State<AppState>, Path(id): Path<i64>, form: Form) -> ApiResult {
    let playlist = found(state.db.call(move |conn| Ok(Playlist::by_id(conn, id)?)).await?)?;
    let intent = form.intent();
    let done = || ok(json!({ "ok": true, "intent": intent }));
    match intent.as_str() {
        "renamePlaylist" => {
            let Some(name) = name_field(&form) else { return name_required() };
            update_playlist(&state, "UPDATE playlists SET name = ? WHERE id = ?", vec![name.into(), id.into()]).await?;
            done()
        }
        "setChannelTemplate" | "setAltTemplate" => {
            let alt = intent == "setAltTemplate";
            let key = if alt { "altNameTemplate" } else { "channelNameTemplate" };
            let t = match template(&form, key, alt) {
                Ok(t) => t,
                Err(e) => return bad_request(json!({ "ok": false, "error": e })),
            };
            let sql = if alt {
                "UPDATE playlists SET alt_name_template = ? WHERE id = ?"
            } else {
                "UPDATE playlists SET channel_name_template = ? WHERE id = ?"
            };
            update_playlist(&state, sql, vec![t.into(), id.into()]).await?;
            // Names in the M3U change, so drop the cached output.
            invalidate(&playlist.output_token);
            done()
        }
        "setSmartSort" => {
            let prefer = if form.get("smartSortPrefer") == Some("bitrate") { "bitrate" } else { "resolution" };
            // Switches only send a value when on, so a missing field means off.
            update_playlist(
                &state,
                "UPDATE playlists SET smart_sort_prefer = ?, smart_sort_audio = ?, smart_sort_available_first = ? WHERE id = ?",
                vec![
                    prefer.to_string().into(),
                    (form.has("smartSortAudio") as i64).into(),
                    (form.has("smartSortAvailableFirst") as i64).into(),
                    id.into(),
                ],
            )
            .await?;
            done()
        }
        "setAutoDisable" => {
            let after = form.int("autoDisableFailedProbesAfter").filter(|n| (0..=20).contains(n)).unwrap_or(3);
            update_playlist(&state, "UPDATE playlists SET auto_disable_failed_probes_after = ? WHERE id = ?", vec![
                after.into(),
                id.into(),
            ])
            .await?;
            done()
        }
        "deletePlaylist" => {
            update_playlist(&state, "DELETE FROM playlists WHERE id = ?", vec![id.into()]).await?;
            redirect("/playlists")
        }
        "addDestination" | "updateDestination" => {
            let name = crate::js::trim(&form.str("name")).to_string();
            if name.is_empty() {
                return settings_error(&intent, "Name is required");
            }
            let kind = form.str("type");
            if kind != "s3" && kind != "local" {
                return settings_error(&intent, "Pick S3 or a local folder");
            }
            let path_or = |k: &str, fallback: &str| {
                let v = crate::js::trim(&form.str(k)).to_string();
                if v.is_empty() { fallback.to_string() } else { v }
            };
            let m3u_path = path_or("m3uPath", "playlist.m3u");
            let epg_path = path_or("epgPath", "playlist.xml");
            let public_url_base = crate::js::trim(&form.str("publicUrlBase")).to_string();
            let public_url_base = (!public_url_base.is_empty()).then_some(public_url_base);

            let dest_id = form.int("id");
            let mut existing = None;
            if intent == "updateDestination" {
                let row: Option<(String, String)> = state
                    .db
                    .call(move |conn| {
                        Ok(conn
                            .query_row(
                                "SELECT type, config FROM upload_destinations WHERE id = ? AND playlist_id = ?",
                                params![dest_id, id],
                                |r| Ok((r.get(0)?, r.get(1)?)),
                            )
                            .optional()?)
                    })
                    .await?;
                let Some((stored_kind, config)) = row else {
                    return with_status(StatusCode::NOT_FOUND, json!({ "ok": false, "error": "Destination not found", "intent": intent }));
                };
                if stored_kind == "s3" {
                    existing = serde_json::from_str::<S3Config>(&config).ok();
                }
            }
            let config = match parse_destination_config(&form, &kind, existing) {
                Ok(c) => c,
                Err(e) => return settings_error(&intent, e),
            };
            let adding = intent == "addDestination";
            state
                .db
                .call(move |conn| {
                    if adding {
                        conn.execute(
                            "INSERT INTO upload_destinations (playlist_id, name, type, config, m3u_path, epg_path, public_url_base) \
                             VALUES (?, ?, ?, ?, ?, ?, ?)",
                            params![id, name, kind, config, m3u_path, epg_path, public_url_base],
                        )?;
                    } else {
                        conn.execute(
                            "UPDATE upload_destinations SET name = ?, type = ?, config = ?, m3u_path = ?, epg_path = ?, \
                               public_url_base = ? WHERE id = ?",
                            params![name, kind, config, m3u_path, epg_path, public_url_base, dest_id],
                        )?;
                    }
                    Ok(())
                })
                .await?;
            done()
        }
        "uploadDestination" => {
            let dest_id = form.int("id");
            let exists = state
                .db
                .call(move |conn| {
                    Ok(conn
                        .query_row("SELECT 1 FROM upload_destinations WHERE id = ? AND playlist_id = ?", params![dest_id, id], |_| Ok(()))
                        .optional()?
                        .is_some())
                })
                .await?;
            match (exists, dest_id) {
                (true, Some(dest_id)) => {
                    state.jobs.enqueue(Work::Upload { destination_id: dest_id }, Trigger::Manual).await?;
                    done()
                }
                _ => with_status(StatusCode::NOT_FOUND, json!({ "ok": false, "error": "Destination not found", "intent": intent })),
            }
        }
        "deleteDestination" => {
            let dest_id = form.int("id");
            state
                .db
                .call(move |conn| {
                    conn.execute("DELETE FROM upload_destinations WHERE id = ? AND playlist_id = ?", params![dest_id, id])?;
                    Ok(())
                })
                .await?;
            done()
        }
        _ => bad_request(json!({ "ok": false, "error": "Unknown action" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_must_keep_their_placeholders() {
        let f = Form::parse(b"a=%7Bname%7D+%28Alt+%7Bn%7D%29&b=%7Bname%7D&c=+&d=Alt");
        assert_eq!(template(&f, "a", true), Ok("{name} (Alt {n})".into()));
        assert_eq!(template(&f, "b", true), Err("Must include {n}"));
        assert_eq!(template(&f, "b", false), Ok("{name}".into()));
        assert_eq!(template(&f, "c", false), Err("Template is required"));
        assert_eq!(template(&f, "d", false), Err("Must include {name}"));
    }

    #[test]
    fn s3_edits_keep_the_stored_secret() {
        let f = Form::parse(b"region=us-east-1&bucket=b&accessKeyId=k&secretAccessKey=&prefix=+iptv+");
        let existing = S3Config { secret_access_key: "old".into(), ..Default::default() };
        let config: S3Config = serde_json::from_str(&parse_destination_config(&f, "s3", Some(existing)).unwrap()).unwrap();
        assert_eq!(config.secret_access_key, "old");
        assert_eq!(config.prefix.as_deref(), Some("iptv"));
        assert_eq!(config.endpoint, None);
        assert_eq!(config.force_path_style, Some(false));
        assert_eq!(parse_destination_config(&f, "s3", None), Err("Secret access key is required"));
        assert_eq!(parse_destination_config(&Form::parse(b""), "local", None), Err("Folder path is required"));
    }

    #[test]
    fn redacts_the_secret_from_the_view() {
        let v = config_view(r#"{"region":"r","bucket":"b","accessKeyId":"k","secretAccessKey":"s","forcePathStyle":true}"#);
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains("\"s\""));
        assert!(json.contains("forcePathStyle"));
    }
}
