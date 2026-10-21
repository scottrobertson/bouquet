//! Proxies remote channel logos through our origin. Providers often serve them
//! over http (mixed content on an https page) or block hotlinking.

use std::sync::LazyLock;
use std::time::Duration;

use axum::Router;
use axum::extract::Query;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;

use super::AppState;
use crate::xtream::USER_AGENT;

pub fn routes() -> Router<AppState> {
    Router::new().route("/img", get(handler))
}

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(10))
        .build()
        .expect("building the HTTP client")
});

// Block obvious internal targets so this can't be pointed at the host's own
// network. Best effort on the hostname, which is enough for a self-hosted tool.
fn is_blocked_host(host: &str) -> bool {
    let h = host.to_lowercase();
    let h = h.trim_start_matches('[').trim_end_matches(']');
    if h == "localhost" || h == "0.0.0.0" || h == "::1" || h.ends_with(".localhost") {
        return true;
    }
    if h.starts_with("127.") || h.starts_with("10.") || h.starts_with("192.168.") || h.starts_with("169.254.") {
        return true;
    }
    if let Some(rest) = h.strip_prefix("172.")
        && let Some(second) = rest.split('.').next().and_then(|s| s.parse::<u8>().ok())
    {
        return (16..=31).contains(&second);
    }
    false
}

#[derive(Deserialize)]
struct Params {
    u: Option<String>,
}

fn bad(msg: &'static str) -> Response {
    (StatusCode::BAD_REQUEST, msg).into_response()
}

async fn handler(Query(params): Query<Params>) -> Response {
    let Some(raw) = params.u.filter(|u| !u.is_empty()) else { return bad("missing url") };
    let Ok(target) = url::Url::parse(&raw) else { return bad("bad url") };
    if target.scheme() != "http" && target.scheme() != "https" {
        return bad("bad scheme");
    }
    if target.host_str().is_none_or(is_blocked_host) {
        return bad("blocked");
    }

    let upstream = match CLIENT.get(target).header("Accept", "image/*").send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(_) => return (StatusCode::BAD_GATEWAY, "upstream error").into_response(),
        Err(_) => return (StatusCode::BAD_GATEWAY, "fetch failed").into_response(),
    };
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or(HeaderValue::from_static("image/png"));
    let Ok(body) = upstream.bytes().await else {
        return (StatusCode::BAD_GATEWAY, "fetch failed").into_response();
    };
    (
        [
            (header::CONTENT_TYPE, content_type),
            // Logos rarely change, so let the browser cache hard.
            (header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=604800, immutable")),
        ],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_internal_hosts() {
        for h in ["localhost", "a.localhost", "0.0.0.0", "[::1]", "127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.0.1", "172.16.0.1", "172.31.9.9"] {
            assert!(is_blocked_host(h), "{h} should be blocked");
        }
        for h in ["example.com", "172.15.0.1", "172.32.0.1", "8.8.8.8"] {
            assert!(!is_blocked_host(h), "{h} should be allowed");
        }
    }
}
