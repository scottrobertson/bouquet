//! The public M3U and EPG URLs that IPTV players poll. No auth; the output
//! token in the URL is the only key.

use std::sync::LazyLock;
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use regex::Regex;

use super::{AppState, external_origin};
use crate::output::{cache, m3u, resolve, xmltv};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/output/m3u/{token}", get(m3u_handler))
        .route("/output/epg/{token}", get(epg_handler))
}

static UNSAFE_FILENAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-zA-Z0-9._-]+").unwrap());

// Strip anything that would be unsafe in a Content-Disposition filename.
fn safe_filename(name: &str) -> String {
    let cleaned = UNSAFE_FILENAME.replace_all(name, "_");
    let cleaned = cleaned.trim_matches('_');
    if cleaned.is_empty() { "playlist".into() } else { cleaned.to_string() }
}

struct Output {
    content_type: &'static str,
    extension: &'static str,
    max_age: u32,
}

fn respond(out: Output, request: &HeaderMap, name: &str, built: cache::Cached) -> Response {
    let etag = format!("\"{}\"", built.etag);
    let cache_control = format!("public, max-age={}", out.max_age);
    if request.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag), (header::CACHE_CONTROL, cache_control)])
            .into_response();
    }
    let mut res = built.body.as_str().to_owned().into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(out.content_type));
    h.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    h.insert(header::CACHE_CONTROL, HeaderValue::from_str(&cache_control).unwrap());
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("inline; filename=\"{}.{}\"", safe_filename(name), out.extension)).unwrap(),
    );
    res
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn server_error(e: anyhow::Error) -> Response {
    eprintln!("output failed: {e:#}");
    (StatusCode::INTERNAL_SERVER_ERROR, "error").into_response()
}

async fn m3u_handler(State(state): State<AppState>, Path(token): Path<String>, headers: HeaderMap) -> Response {
    let epg_url = format!("{}/output/epg/{token}", external_origin(&headers));
    let key = format!("m3u:{token}");
    let result = state
        .db
        .call(move |conn| {
            let Some((playlist, channels)) = resolve::get_playlist_output(conn, &token)? else {
                return Ok(None);
            };
            let built = match cache::get(&key, Duration::from_secs(60)) {
                Some(c) => c,
                None => cache::put(&key, m3u::build_m3u(&channels, &epg_url)),
            };
            Ok(Some((playlist.name, built)))
        })
        .await;
    match result {
        Ok(Some((name, built))) => respond(
            Output { content_type: "audio/x-mpegurl; charset=utf-8", extension: "m3u", max_age: 60 },
            &headers,
            &name,
            built,
        ),
        Ok(None) => not_found(),
        Err(e) => server_error(e),
    }
}

async fn epg_handler(State(state): State<AppState>, Path(token): Path<String>, headers: HeaderMap) -> Response {
    let key = format!("epg:{token}");
    let result = state
        .db
        .call(move |conn| {
            let Some((playlist, channels)) = resolve::get_playlist_output(conn, &token)? else {
                return Ok(None);
            };
            let built = match cache::get(&key, Duration::from_secs(3600)) {
                Some(c) => c,
                None => cache::put(&key, xmltv::build_xmltv(conn, &channels)?),
            };
            Ok(Some((playlist.name, built)))
        })
        .await;
    match result {
        Ok(Some((name, built))) => respond(
            Output { content_type: "application/xml; charset=utf-8", extension: "xml", max_age: 1800 },
            &headers,
            &name,
            built,
        ),
        Ok(None) => not_found(),
        Err(e) => server_error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames_are_made_safe() {
        assert_eq!(safe_filename("My List!"), "My_List");
        assert_eq!(safe_filename("???"), "playlist");
        assert_eq!(safe_filename("uk-tv_2.0"), "uk-tv_2.0");
    }
}
