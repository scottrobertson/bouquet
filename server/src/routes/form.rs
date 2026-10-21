//! Form posts from the browser, read the way the browser's FormData works: a
//! key can repeat, and every value is a string.

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::response::{IntoResponse, Response};

pub struct Form(Vec<(String, String)>);

impl Form {
    pub fn parse(body: &[u8]) -> Form {
        Form(url::form_urlencoded::parse(body).into_owned().collect())
    }

    /// The first value for a key, like FormData.get.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// The value as a string, empty when missing, like String(form.get(key) ?? "").
    pub fn str(&self, key: &str) -> String {
        self.get(key).unwrap_or("").to_string()
    }

    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// Every value for a key, like FormData.getAll.
    pub fn all(&self, key: &str) -> Vec<&str> {
        self.0.iter().filter(|(k, _)| k == key).map(|(_, v)| v.as_str()).collect()
    }

    /// A whole number, or None when missing or not a number.
    pub fn int(&self, key: &str) -> Option<i64> {
        let v = crate::js::number(self.get(key).map(|s| serde_json::Value::String(s.to_string())).as_ref());
        (v.is_finite() && v.fract() == 0.0).then_some(v as i64)
    }

    /// Every value for a key that reads as a whole number.
    pub fn ints(&self, key: &str) -> Vec<i64> {
        self.all(key).iter().filter_map(|v| v.trim().parse().ok()).collect()
    }

    /// A checkbox or switch: present and not "false"/"0"/"off".
    pub fn flag(&self, key: &str) -> bool {
        matches!(self.get(key), Some(v) if !matches!(v, "false" | "0" | "off" | ""))
    }

    pub fn intent(&self) -> String {
        self.str("intent")
    }
}

impl<S: Send + Sync> FromRequest<S> for Form {
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let body = Bytes::from_request(req, state).await.map_err(IntoResponse::into_response)?;
        Ok(Form::parse(&body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_like_form_data() {
        let f = Form::parse(b"intent=bulkMove&channelIds=1&channelIds=2&channelIds=x&toCategoryId=5&name=a+b%26c&on=on");
        assert_eq!(f.intent(), "bulkMove");
        assert_eq!(f.ints("channelIds"), [1, 2]);
        assert_eq!(f.int("toCategoryId"), Some(5));
        assert_eq!(f.int("missing"), None);
        assert_eq!(f.str("name"), "a b&c");
        assert!(f.flag("on"));
        assert!(!f.flag("off"));
    }
}
