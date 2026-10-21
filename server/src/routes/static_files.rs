//! Serves the built browser app. Release builds carry the files inside the
//! binary; debug builds read them from disk, so a fresh `npm run build` shows
//! up without rebuilding the server.

use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../build/client"]
#[allow_missing = true]
struct App;

fn file(path: &str) -> Option<Response> {
    let asset = App::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // Built assets have a content hash in their name, so they never change.
    // The page itself points at the current ones, so it's always rechecked.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else if path == "index.html" {
        "no-cache"
    } else {
        "public, max-age=3600"
    };
    Some(
        (
            [
                (header::CONTENT_TYPE, HeaderValue::from_str(mime.as_ref()).unwrap()),
                (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
            ],
            asset.data,
        )
            .into_response(),
    )
}

/// Anything no other route answered: a built file, or the app's page so the
/// browser can route it.
pub async fn fallback(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path == "api" || path.starts_with("api/") {
        return (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({ "error": "Not found" }))).into_response();
    }
    if let Some(res) = file(path).filter(|_| !path.is_empty()) {
        return res;
    }
    // A tab left open across a deploy asks for the old build's files. Answering
    // with the page would make it choke on HTML where it expected a script.
    if path.starts_with("assets/") {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    file("index.html").unwrap_or_else(|| {
        (StatusCode::NOT_FOUND, "The browser app hasn't been built. Run `npm run build`.").into_response()
    })
}
