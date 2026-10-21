use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Serialize;
use serde_json::json;
use ts_rs::TS;

use super::api::{ApiResult, bad_request, ok};
use super::{AppState, form::Form};
use crate::backup::{BackupInfo, backups};
use crate::config::config;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/settings", get(load).post(act))
        .route("/settings/backup/{file}", get(download))
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SettingsData {
    pub backups: Vec<BackupInfo>,
    pub backups_path: String,
    pub backup_cron: String,
    pub backup_keep: usize,
}

async fn load(State(state): State<AppState>) -> ApiResult {
    let backups_list = state.db.call(|conn| backups().list(conn)).await?;
    let cfg = config();
    ok(SettingsData {
        backups: backups_list,
        backups_path: cfg.backups_path.display().to_string(),
        backup_cron: cfg.backup_cron.clone(),
        backup_keep: cfg.backup_keep,
    })
}

async fn act(State(state): State<AppState>, form: Form) -> ApiResult {
    let intent = form.intent();
    let file = form.str("file");
    let result = match intent.as_str() {
        "backupNow" => state
            .db
            .call(|conn| backups().create(conn, "manual"))
            .await
            .map(|(file, _)| format!("Backup created: {file}")),
        "deleteBackup" => backups().delete(&file).map(|_| "Backup deleted".to_string()),
        "restore" => state
            .db
            .call(move |conn| backups().restore(conn, &file))
            .await
            .map(|_| "Restored from backup.".to_string()),
        _ => return bad_request(json!({ "ok": false, "message": "Unknown action" })),
    };
    match result {
        Ok(message) => ok(json!({ "ok": true, "intent": intent, "message": message })),
        Err(e) => bad_request(json!({ "ok": false, "intent": intent, "message": e.to_string() })),
    }
}

/// Download a backup so it can be kept off the box.
async fn download(Path(file): Path<String>) -> Response {
    match backups().read(&file) {
        Ok((name, body)) => (
            [
                (header::CONTENT_TYPE, HeaderValue::from_static("application/gzip")),
                (
                    header::CONTENT_DISPOSITION,
                    HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")).unwrap_or(HeaderValue::from_static("attachment")),
                ),
            ],
            body,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}
