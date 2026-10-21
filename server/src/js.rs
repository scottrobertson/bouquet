//! Providers return loosely typed JSON: the same field can be a number, a
//! string, empty or missing depending on the panel. These helpers read values
//! the way JavaScript's Number() and String() do, so parsing behaves the same
//! across panels.

use serde_json::Value;

/// Like JavaScript's Number(v). A missing value is NaN, null is 0.
pub fn number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(*b as u8),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) }
        }
        Some(_) => f64::NAN,
    }
}

fn number_to_string(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 { format!("{}", n as i64) } else { n.to_string() }
}

/// Like JavaScript's String(v), including "undefined" and "null".
pub fn string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => match n.as_i64() {
            Some(i) => i.to_string(),
            None => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        },
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// Like JavaScript's trim(), which also strips the byte order mark.
pub fn trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// A trimmed string, or None when the value is missing, null or blank.
pub fn opt_string(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        other => {
            let s = string(other);
            let t = trim(&s);
            if t.is_empty() { None } else { Some(t.to_string()) }
        }
    }
}

/// Number(v) truncated toward zero, or None when it isn't a finite number.
pub fn trunc(v: Option<&Value>) -> Option<i64> {
    let n = number(v);
    if n.is_finite() { Some(n.trunc() as i64) } else { None }
}

/// Node's base64 decoding is forgiving: it skips characters outside the
/// alphabet, accepts the URL-safe alphabet and doesn't need padding. Provider
/// EPG text relies on that.
pub fn decode_base64_lossy(s: &str) -> String {
    use base64::Engine;
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};

    let mut clean: String = s
        .chars()
        .filter_map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => Some(c),
            '-' => Some('+'),
            '_' => Some('/'),
            _ => None,
        })
        .collect();
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    let engine = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    match engine.decode(clean.as_bytes()) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => s.to_string(),
    }
}

/// Like JavaScript's encodeURIComponent.
pub fn encode_uri_component(s: &str) -> String {
    use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
    const SET: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    utf8_percent_encode(s, SET).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_matches_javascript() {
        assert_eq!(number(Some(&json!("12"))), 12.0);
        assert_eq!(number(Some(&json!(" 7 "))), 7.0);
        assert_eq!(number(Some(&json!(""))), 0.0);
        assert_eq!(number(Some(&json!(null))), 0.0);
        assert!(number(None).is_nan());
        assert!(number(Some(&json!("abc"))).is_nan());
        assert_eq!(number(Some(&json!(true))), 1.0);
    }

    #[test]
    fn string_matches_javascript() {
        assert_eq!(string(Some(&json!(12))), "12");
        assert_eq!(string(Some(&json!(12.0))), "12");
        assert_eq!(string(Some(&json!(1.5))), "1.5");
        assert_eq!(string(None), "undefined");
        assert_eq!(opt_string(Some(&json!("  "))), None);
        assert_eq!(opt_string(Some(&json!(" a "))), Some("a".into()));
    }

    #[test]
    fn base64_is_forgiving() {
        assert_eq!(decode_base64_lossy("VGhlIE5ld3M="), "The News");
        assert_eq!(decode_base64_lossy("VGhlIE5ld3M"), "The News");
        assert_eq!(decode_base64_lossy(""), "");
    }

    #[test]
    fn encode_uri_component_matches_javascript() {
        assert_eq!(encode_uri_component("a b"), "a%20b");
        assert_eq!(encode_uri_component("p@ss/word"), "p%40ss%2Fword");
        assert_eq!(encode_uri_component("a-b_c.d!e~f*g'h(i)"), "a-b_c.d!e~f*g'h(i)");
    }
}
