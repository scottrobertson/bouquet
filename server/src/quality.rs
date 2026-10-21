use std::sync::LazyLock;

use regex::Regex;

static URL_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://\S+?:\s+").unwrap());

/// ffmpeg prefixes its errors with the input URL, which holds the provider
/// login. Drop that so credentials never reach the logs or the UI.
pub fn clean_probe_error(error: &str) -> String {
    URL_PREFIX.replace(error, "").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_url_prefix() {
        assert_eq!(
            clean_probe_error("https://host/live/user/pass/123.m3u8: Invalid data found"),
            "Invalid data found"
        );
        assert_eq!(
            clean_probe_error("http://host:8080/live/u/p/1.ts: Server returned 404 Not Found"),
            "Server returned 404 Not Found"
        );
    }

    #[test]
    fn leaves_other_errors_alone() {
        assert_eq!(clean_probe_error("Connection refused"), "Connection refused");
        assert_eq!(clean_probe_error(""), "");
    }
}
