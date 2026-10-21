//! The add and edit source forms, read with the same rules and defaults.

use std::collections::BTreeMap;

use crate::routes::form::Form;

// How often the scheduler syncs or probes a source. 0 means manual only.
const SYNC_INTERVALS: &[i64] = &[60, 360, 720, 1440, 0];
const PROBE_INTERVALS: &[i64] = &[1440, 4320, 10080, 0];
const PROBE_TIMEOUTS: &[i64] = &[5, 10, 20, 30];

#[derive(Debug, Clone, PartialEq)]
pub struct SourceInput {
    pub name: String,
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub output_format: String,
    pub auto_import_groups: bool,
    pub sync_interval_minutes: i64,
    pub probe_enabled: bool,
    pub probe_concurrency: i64,
    pub probe_interval_minutes: i64,
    pub probe_timeout_seconds: i64,
    pub probe_detect_black_screen: bool,
}

fn one_of(form: &Form, key: &str, allowed: &[i64], fallback: i64) -> i64 {
    form.int(key).filter(|n| allowed.contains(n)).unwrap_or(fallback)
}

/// The source fields, or the first problem with each field that has one.
pub fn parse_source_form(form: &Form) -> Result<SourceInput, BTreeMap<String, String>> {
    let mut errors = BTreeMap::new();
    let trimmed = |k: &str| crate::js::trim(&form.str(k)).to_string();
    let (name, server_url, username, password) =
        (trimmed("name"), trimmed("serverUrl"), trimmed("username"), form.str("password"));
    if name.is_empty() {
        errors.insert("name".into(), "Name is required".into());
    }
    if server_url.is_empty() {
        errors.insert("serverUrl".into(), "Server URL is required".into());
    } else if url::Url::parse(&server_url).map(|u| u.host_str().is_none()).unwrap_or(true) {
        errors.insert("serverUrl".into(), "Enter a valid URL".into());
    }
    if username.is_empty() {
        errors.insert("username".into(), "Username is required".into());
    }
    if password.is_empty() {
        errors.insert("password".into(), "Password is required".into());
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    // Checkboxes send "on" when ticked and nothing otherwise.
    let checked = |k: &str| form.get(k) == Some("on");
    Ok(SourceInput {
        name,
        server_url,
        username,
        password,
        output_format: if form.get("outputFormat") == Some("m3u8") { "m3u8".into() } else { "ts".into() },
        auto_import_groups: checked("autoImportGroups"),
        sync_interval_minutes: one_of(form, "syncIntervalMinutes", SYNC_INTERVALS, 1440),
        probe_enabled: checked("probeEnabled"),
        // The provider's connection limit is the real ceiling, but cap at 20 to
        // keep out silly values.
        probe_concurrency: form.int("probeConcurrency").filter(|n| (1..=20).contains(n)).unwrap_or(1),
        probe_interval_minutes: one_of(form, "probeIntervalMinutes", PROBE_INTERVALS, 1440),
        probe_timeout_seconds: one_of(form, "probeTimeoutSeconds", PROBE_TIMEOUTS, 10),
        probe_detect_black_screen: checked("probeDetectBlackScreen"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_full_form() {
        let f = Form::parse(
            b"name=+Main+&serverUrl=http%3A%2F%2Fx.com%3A8080&username=u&password=p&outputFormat=m3u8&autoImportGroups=on\
              &syncIntervalMinutes=60&probeConcurrency=4&probeIntervalMinutes=4320&probeTimeoutSeconds=30",
        );
        let s = parse_source_form(&f).unwrap();
        assert_eq!(s.name, "Main");
        assert_eq!(s.output_format, "m3u8");
        assert!(s.auto_import_groups && !s.probe_enabled);
        assert_eq!((s.sync_interval_minutes, s.probe_concurrency, s.probe_interval_minutes, s.probe_timeout_seconds), (60, 4, 4320, 30));
    }

    #[test]
    fn falls_back_on_odd_values() {
        let f = Form::parse(b"name=a&serverUrl=http://x&username=u&password=p&outputFormat=mkv&syncIntervalMinutes=7&probeConcurrency=99");
        let s = parse_source_form(&f).unwrap();
        assert_eq!((s.output_format.as_str(), s.sync_interval_minutes, s.probe_concurrency), ("ts", 1440, 1));
    }

    #[test]
    fn reports_each_missing_field() {
        let e = parse_source_form(&Form::parse(b"serverUrl=nope")).unwrap_err();
        assert_eq!(e["name"], "Name is required");
        assert_eq!(e["serverUrl"], "Enter a valid URL");
        assert_eq!(e["username"], "Username is required");
        assert_eq!(e["password"], "Password is required");
    }
}
