use axum::Router;
use axum::http::HeaderMap;

use crate::db::Db;
use crate::jobs::Jobs;

pub mod api;
pub mod editor;
pub mod events;
pub mod form;
pub mod guide;
pub mod img;
pub mod jobs;
pub mod output;
pub mod playlists;
pub mod settings;
pub mod sources;
pub mod static_files;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub jobs: Jobs,
}

impl AppState {
    pub fn new(db: Db) -> AppState {
        AppState { jobs: Jobs::new(&db), db }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(output::routes())
        .merge(img::routes())
        .merge(events::routes())
        .merge(jobs::routes())
        .merge(settings::routes())
        .merge(sources::routes())
        .merge(playlists::routes())
        .merge(guide::routes())
        .merge(editor::routes())
        .fallback(static_files::fallback)
        .with_state(state)
}

/// The public origin for a request. Behind a reverse proxy that terminates
/// SSL the request reaches us over http, so trust the proxy's forwarded
/// headers to build https output URLs.
pub fn external_origin(headers: &HeaderMap) -> String {
    let first = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let proto = first("x-forwarded-proto").unwrap_or_else(|| "http".into());
    let host = first("x-forwarded-host")
        .or_else(|| headers.get("host").and_then(|v| v.to_str().ok()).map(String::from))
        .unwrap_or_else(|| "localhost".into());
    format!("{proto}://{host}")
}
