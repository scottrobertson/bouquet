//! Xtream Codes API client. Talks to a provider's player_api.php. Bouquet never
//! proxies streams; it only reads metadata and builds the direct stream URLs
//! that go into the output M3U.

use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{Result, anyhow};
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::js;

#[derive(Debug, Clone)]
pub struct Creds {
    pub server_url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone)]
pub struct LiveCategory {
    pub category_id: String,
    pub category_name: String,
}

#[derive(Debug, Clone)]
pub struct LiveStream {
    pub stream_id: String,
    pub name: String,
    pub logo: Option<String>,
    pub epg_channel_id: Option<String>,
    pub category_id: Option<String>,
    pub tv_archive: bool,
    // Days of catchup the provider keeps. 0 when there's no archive.
    pub tv_archive_duration: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Programme {
    pub channel_id: String,
    pub start_ts: i64,
    pub stop_ts: i64,
    pub title: Option<String>,
    pub description: Option<String>,
    pub has_archive: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Account {
    pub ok: bool,
    pub message: Option<String>,
    pub status: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub max_connections: Option<i64>,
    // The provider's real base URL from server_info, if it gave one.
    pub stream_base_url: Option<String>,
}

pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT: Duration = Duration::from_secs(30);

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(TIMEOUT)
        .build()
        .expect("building the HTTP client")
});

/// Strip trailing slashes so paths can be appended cleanly.
pub fn normalize_server_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// reqwest's own error text is vague, so say what actually went wrong.
pub fn describe_request_error(err: &reqwest::Error, timeout: Duration) -> String {
    if err.is_timeout() {
        return format!("Request timed out after {}s", timeout.as_secs());
    }
    let mut source = std::error::Error::source(err);
    let mut deepest = None;
    while let Some(s) = source {
        deepest = Some(s.to_string());
        source = s.source();
    }
    match deepest {
        Some(cause) => format!("Connection failed: {cause}"),
        None => err.to_string(),
    }
}

// Providers turn requests away with a 503 or 429 when they're busy or when
// too many arrive at once, so those get tried again after a growing pause.
const ATTEMPTS: u32 = 5;
const FIRST_RETRY_DELAY: Duration = if cfg!(test) { Duration::from_millis(5) } else { Duration::from_secs(1) };
const LONGEST_RETRY_DELAY: Duration = Duration::from_secs(30);

fn worth_retrying(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504)
}

/// How long to wait before the next try: what the provider asked for in
/// Retry-After if it said, otherwise doubling from FIRST_RETRY_DELAY. A little
/// randomness stops requests that failed together from all retrying together.
pub fn retry_delay(attempt: u32, retry_after: Option<Duration>) -> Duration {
    let backoff = FIRST_RETRY_DELAY * 2u32.pow(attempt);
    let jitter_ms = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos()
        % 250) as u64;
    let jitter = if cfg!(test) { Duration::ZERO } else { Duration::from_millis(jitter_ms) };
    (retry_after.unwrap_or(backoff) + jitter).min(LONGEST_RETRY_DELAY)
}

async fn player_api(creds: &Creds, params: &[(&str, &str)]) -> Result<Value> {
    let base = normalize_server_url(&creds.server_url);
    let mut query: Vec<(&str, &str)> =
        vec![("username", &creds.username), ("password", &creds.password)];
    query.extend_from_slice(params);
    let url = format!(
        "{base}/player_api.php?{}",
        url::form_urlencoded::Serializer::new(String::new()).extend_pairs(query).finish()
    );
    let mut attempt = 0;
    let res = loop {
        // A refused connection or a timeout means the provider is down or the
        // address is wrong, which waiting won't fix, so those fail straight away.
        let res = CLIENT
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| anyhow!(describe_request_error(&e, TIMEOUT)))?;
        let status = res.status();
        if status.is_success() {
            break res;
        }
        attempt += 1;
        if !worth_retrying(status) || attempt >= ATTEMPTS {
            return Err(anyhow!("Provider returned HTTP {}", status.as_u16()));
        }
        let retry_after = res
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        tokio::time::sleep(retry_delay(attempt - 1, retry_after)).await;
    };
    let text = res.text().await.map_err(|e| anyhow!(describe_request_error(&e, TIMEOUT)))?;
    serde_json::from_str(&text)
        .map_err(|_| anyhow!("Provider did not return valid JSON (check the server URL)"))
}

/// The provider's real base URL from server_info, like http://host:8080. Lets
/// output use the real address even when the server URL points at a proxy.
fn stream_base_from_server_info(si: Option<&Value>) -> Option<String> {
    let si = si?;
    let host = js::opt_string(si.get("url"))?;
    let lower = host.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(normalize_server_url(&host));
    }
    let protocol = js::opt_string(si.get("server_protocol")).unwrap_or_else(|| "http".into());
    let port = if protocol == "https" {
        js::opt_string(si.get("https_port")).or_else(|| js::opt_string(si.get("port")))
    } else {
        js::opt_string(si.get("port"))
    };
    Some(normalize_server_url(&match port {
        Some(p) => format!("{protocol}://{host}:{p}"),
        None => format!("{protocol}://{host}"),
    }))
}

/// Check the login and read the account status.
pub async fn validate_account(creds: &Creds) -> Account {
    let data = match player_api(creds, &[]).await {
        Ok(d) => d,
        Err(e) => return Account { ok: false, message: Some(e.to_string()), ..Default::default() },
    };
    parse_account(&data)
}

pub fn parse_account(data: &Value) -> Account {
    let info = data.get("user_info").filter(|v| v.is_object());
    let Some(info) = info.filter(|i| js::number(i.get("auth")) == 1.0) else {
        let message = info
            .and_then(|i| js::opt_string(i.get("message")))
            .unwrap_or_else(|| "Authentication failed".into());
        return Account { ok: false, message: Some(message), ..Default::default() };
    };
    let truthy = |v: Option<&Value>| match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => true,
    };
    let expires_at = if truthy(info.get("exp_date")) {
        let secs = js::number(info.get("exp_date"));
        if secs.is_finite() { DateTime::from_timestamp(secs as i64, 0) } else { None }
    } else {
        None
    };
    let max_connections = if truthy(info.get("max_connections")) {
        let n = js::number(info.get("max_connections"));
        n.is_finite().then_some(n as i64)
    } else {
        None
    };
    Account {
        ok: true,
        message: None,
        status: js::opt_string(info.get("status")),
        expires_at,
        max_connections,
        stream_base_url: stream_base_from_server_info(data.get("server_info")),
    }
}

pub async fn fetch_live_categories(creds: &Creds) -> Result<Vec<LiveCategory>> {
    let data = player_api(creds, &[("action", "get_live_categories")]).await?;
    let Some(list) = data.as_array() else { return Ok(vec![]) };
    Ok(list
        .iter()
        .map(|c| LiveCategory {
            category_id: js::string(c.get("category_id")),
            category_name: js::opt_string(c.get("category_name"))
                .unwrap_or_else(|| "Uncategorized".into()),
        })
        .collect())
}

pub async fn fetch_live_streams(creds: &Creds) -> Result<Vec<LiveStream>> {
    let data = player_api(creds, &[("action", "get_live_streams")]).await?;
    Ok(parse_live_streams(&data))
}

pub fn parse_live_streams(data: &Value) -> Vec<LiveStream> {
    let Some(list) = data.as_array() else { return vec![] };
    list.iter()
        .map(|s| {
            let stream_id = js::string(s.get("stream_id"));
            LiveStream {
                name: js::opt_string(s.get("name")).unwrap_or_else(|| format!("Channel {stream_id}")),
                logo: js::opt_string(s.get("stream_icon")),
                epg_channel_id: js::opt_string(s.get("epg_channel_id")),
                category_id: js::opt_string(s.get("category_id")),
                tv_archive: js::number(s.get("tv_archive")) == 1.0,
                tv_archive_duration: js::trunc(s.get("tv_archive_duration")).unwrap_or(0).max(0),
                stream_id,
            }
        })
        .collect()
}

/// The direct stream URL that goes into the output M3U.
pub fn build_stream_url(creds: &Creds, stream_id: &str, ext: &str) -> String {
    format!(
        "{}/live/{}/{}/{stream_id}.{ext}",
        normalize_server_url(&creds.server_url),
        js::encode_uri_component(&creds.username),
        js::encode_uri_component(&creds.password),
    )
}

/// The catchup URL template for a channel's archive, filled in by the in-app
/// guide. It has to be {duration:60}: plain {duration} means seconds in the
/// catchup spec, but the provider's timeshift endpoint wants minutes.
pub fn build_timeshift_source(creds: &Creds, stream_id: &str, ext: &str) -> String {
    format!(
        "{}/timeshift/{}/{}/{{duration:60}}/{{Y}}-{{m}}-{{d}}:{{H}}-{{M}}/{stream_id}.{ext}",
        normalize_server_url(&creds.server_url),
        js::encode_uri_component(&creds.username),
        js::encode_uri_component(&creds.password),
    )
}

/// Programmes from a get_simple_data_table response. Titles and descriptions
/// come back base64 encoded and times as unix seconds. The stored channel id is
/// the one we asked for, so it lines up with the channel's tvg-id.
pub fn parse_simple_data_table(data: &Value, channel_id: &str) -> Vec<Programme> {
    let Some(listings) = data.get("epg_listings").and_then(|l| l.as_array()) else {
        return vec![];
    };
    let text = |v: Option<&Value>| {
        let raw = js::opt_string(v).unwrap_or_default();
        js::opt_string(Some(&Value::String(js::decode_base64_lossy(&raw))))
    };
    listings
        .iter()
        .filter_map(|l| {
            let start_ts = js::trunc(l.get("start_timestamp"))?;
            let stop_ts = js::trunc(l.get("stop_timestamp"))?;
            if stop_ts <= start_ts {
                return None;
            }
            Some(Programme {
                channel_id: channel_id.to_string(),
                start_ts,
                stop_ts,
                title: text(l.get("title")),
                description: text(l.get("description")),
                has_archive: js::number(l.get("has_archive")) == 1.0,
            })
        })
        .collect()
}

/// One channel's EPG. Unlike xmltv.php this includes recently aired programmes,
/// which is how players show catchup history.
pub async fn fetch_simple_data_table(creds: &Creds, stream_id: &str, channel_id: &str) -> Result<Vec<Programme>> {
    let data = player_api(creds, &[("action", "get_simple_data_table"), ("stream_id", stream_id)]).await?;
    Ok(parse_simple_data_table(&data, channel_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::json;

    fn creds() -> Creds {
        Creds { server_url: "http://example.com:8080".into(), username: "user".into(), password: "pass".into() }
    }

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    #[test]
    fn normalize_strips_trailing_slashes_and_whitespace() {
        assert_eq!(normalize_server_url("  http://example.com/// "), "http://example.com");
        assert_eq!(normalize_server_url("http://example.com:8080"), "http://example.com:8080");
    }

    #[test]
    fn stream_urls() {
        assert_eq!(build_stream_url(&creds(), "123", "ts"), "http://example.com:8080/live/user/pass/123.ts");
        assert_eq!(build_stream_url(&creds(), "123", "m3u8"), "http://example.com:8080/live/user/pass/123.m3u8");
        let special = Creds { server_url: "http://x.com".into(), username: "a b".into(), password: "p@ss/word".into() };
        assert_eq!(build_stream_url(&special, "9", "ts"), "http://x.com/live/a%20b/p%40ss%2Fword/9.ts");
    }

    #[test]
    fn timeshift_template() {
        assert_eq!(
            build_timeshift_source(&creds(), "5", "ts"),
            "http://example.com:8080/timeshift/user/pass/{duration:60}/{Y}-{m}-{d}:{H}-{M}/5.ts"
        );
    }

    #[test]
    fn simple_data_table_decodes_base64_and_uses_unix_times() {
        let data = json!({ "epg_listings": [{
            "title": b64("The News"),
            "description": b64("Headlines & weather."),
            "start_timestamp": "1705327200",
            "stop_timestamp": "1705330800",
            "has_archive": 1,
        }]});
        assert_eq!(
            parse_simple_data_table(&data, "bbc1.uk"),
            vec![Programme {
                channel_id: "bbc1.uk".into(),
                start_ts: 1705327200,
                stop_ts: 1705330800,
                title: Some("The News".into()),
                description: Some("Headlines & weather.".into()),
                has_archive: true,
            }]
        );
    }

    #[test]
    fn simple_data_table_flags_no_archive() {
        let data = json!({ "epg_listings": [{
            "title": b64("Soap"), "description": "", "start_timestamp": "100", "stop_timestamp": "200", "has_archive": 0,
        }]});
        let progs = parse_simple_data_table(&data, "itv.uk");
        assert!(!progs[0].has_archive);
        assert_eq!(progs[0].description, None);
    }

    #[test]
    fn simple_data_table_drops_bad_times() {
        let data = json!({ "epg_listings": [
            { "title": b64("No times") },
            { "title": b64("Backwards"), "start_timestamp": "200", "stop_timestamp": "100" },
        ]});
        assert!(parse_simple_data_table(&data, "x").is_empty());
        assert!(parse_simple_data_table(&json!({}), "x").is_empty());
        assert!(parse_simple_data_table(&Value::Null, "x").is_empty());
    }

    #[test]
    fn account_parsing() {
        let ok = parse_account(&json!({
            "user_info": { "auth": 1, "status": "Active", "exp_date": "1800000000", "max_connections": "2" },
            "server_info": { "url": "real.host", "port": "8080", "https_port": "443", "server_protocol": "http" },
        }));
        assert!(ok.ok);
        assert_eq!(ok.status.as_deref(), Some("Active"));
        assert_eq!(ok.max_connections, Some(2));
        assert_eq!(ok.expires_at.unwrap().timestamp(), 1800000000);
        assert_eq!(ok.stream_base_url.as_deref(), Some("http://real.host:8080"));

        let https = parse_account(&json!({
            "user_info": { "auth": "1" },
            "server_info": { "url": "real.host", "port": "8080", "https_port": "443", "server_protocol": "https" },
        }));
        assert_eq!(https.stream_base_url.as_deref(), Some("https://real.host:443"));
        assert_eq!(https.expires_at, None);

        let bad = parse_account(&json!({ "user_info": { "auth": 0, "message": "Nope" } }));
        assert!(!bad.ok);
        assert_eq!(bad.message.as_deref(), Some("Nope"));
        assert_eq!(parse_account(&json!({})).message.as_deref(), Some("Authentication failed"));
    }

    #[test]
    fn live_streams_are_read_leniently() {
        let streams = parse_live_streams(&json!([
            { "stream_id": 7, "name": "", "tv_archive": "1", "tv_archive_duration": "3.7", "category_id": 2 },
            { "stream_id": "8", "name": "BBC", "stream_icon": " ", "tv_archive_duration": -1 },
        ]));
        assert_eq!(streams[0].stream_id, "7");
        assert_eq!(streams[0].name, "Channel 7");
        assert!(streams[0].tv_archive);
        assert_eq!(streams[0].tv_archive_duration, 3);
        assert_eq!(streams[0].category_id.as_deref(), Some("2"));
        assert_eq!(streams[1].logo, None);
        assert_eq!(streams[1].tv_archive_duration, 0);
    }
}
