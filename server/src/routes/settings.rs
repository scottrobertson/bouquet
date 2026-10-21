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
use crate::jobs::{Trigger, Work};

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
            .jobs
            .enqueue(Work::Backup { manual: true }, Trigger::Manual)
            .await
            .map(|_| "Backing up in the background".to_string()),
        "deleteBackup" => backups().delete(&file).map(|_| "Backup deleted".to_string()),
        // A restore replaces every table, so a job running at the same time
        // would write into data that no longer exists.
        "restore" => {
            let db = state.db.clone();
            state
                .jobs
                .run_exclusive(|| async move { db.call(move |conn| backups().restore(conn, &file)).await })
                .await
                .map(|_| "Restored from backup.".to_string())
        }
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
