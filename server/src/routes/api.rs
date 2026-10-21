//! Shared bits for the JSON API the browser app calls. Each page has one GET
//! for its data and one POST for its form actions, at /api plus the page's own
//! path.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::json;

/// Text columns that only ever hold a few values. The database stores them as
/// plain text, so these exist only to give the browser app exact types.
pub mod kinds {
    use ts_rs::TS;

    macro_rules! string_union {
        ($name:ident, $ts:literal) => {
            #[derive(TS)]
            #[ts(export, type = $ts)]
            pub struct $name;
        };
    }

    string_union!(SyncStatus, r#""idle" | "queued" | "syncing" | "ok" | "error""#);
    string_union!(SourceProbeStatus, r#""idle" | "queued" | "probing" | "ok" | "error""#);
    string_union!(ChannelProbeStatus, r#""queued" | "probing" | "ok" | "error" | "timeout""#);
    string_union!(UploadStatus, r#""idle" | "queued" | "uploading" | "ok" | "error""#);
    string_union!(JobKind, r#""sync" | "probe" | "upload" | "backup""#);
    string_union!(JobTrigger, r#""manual" | "scheduled" | "automatic""#);
    string_union!(JobStatus, r#""queued" | "running" | "succeeded" | "failed" | "interrupted""#);
    string_union!(JobLogLevel, r#""info" | "warn" | "error""#);
    string_union!(
        ChangeKind,
        r#""channel_added" | "channel_returned" | "channel_removed" | "category_added" | "category_removed""#
    );
}

#[derive(Debug)]
pub enum ApiError {
    NotFound,
    BadRequest(String),
    Other(anyhow::Error),
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        ApiError::Other(e.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" }))).into_response(),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, Json(json!({ "error": m }))).into_response(),
            ApiError::Other(e) => {
                eprintln!("[api] {e:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response()
            }
        }
    }
}

pub type ApiResult<T = Response> = Result<T, ApiError>;

pub fn ok<T: Serialize>(value: T) -> ApiResult {
    Ok(Json(value).into_response())
}

/// An action result the page reads, sent with a status like the TypeScript
/// actions used, since a 4xx stops the page from reloading its data.
pub fn with_status<T: Serialize>(status: StatusCode, value: T) -> ApiResult {
    Ok((status, Json(value)).into_response())
}

pub fn bad_request<T: Serialize>(value: T) -> ApiResult {
    with_status(StatusCode::BAD_REQUEST, value)
}

/// Tells the browser app to navigate, the API version of a redirect.
pub fn redirect(to: impl Into<String>) -> ApiResult {
    ok(json!({ "redirect": to.into() }))
}

pub fn found<T>(v: Option<T>) -> ApiResult<T> {
    v.ok_or(ApiError::NotFound)
}

/// Unix seconds as the ISO string the browser turns back into a Date.
pub fn iso(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn iso_opt(secs: Option<i64>) -> Option<String> {
    secs.map(iso)
}
