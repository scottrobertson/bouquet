use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use sha1::{Digest, Sha1};

struct Entry {
    etag: String,
    body: std::sync::Arc<String>,
    built_at: Instant,
}

// Players poll the output URLs often, so the built output is kept and only
// rebuilt once its TTL has passed or something it depends on changes.
static CACHE: LazyLock<Mutex<HashMap<String, Entry>>> = LazyLock::new(Default::default);

fn cache() -> std::sync::MutexGuard<'static, HashMap<String, Entry>> {
    CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Cached {
    pub body: std::sync::Arc<String>,
    pub etag: String,
}

pub fn get(key: &str, ttl: Duration) -> Option<Cached> {
    let cache = cache();
    let e = cache.get(key)?;
    (e.built_at.elapsed() < ttl).then(|| Cached { body: e.body.clone(), etag: e.etag.clone() })
}

pub fn put(key: &str, body: String) -> Cached {
    let etag = hex::encode(Sha1::digest(body.as_bytes()));
    let body = std::sync::Arc::new(body);
    cache().insert(
        key.to_string(),
        Entry { etag: etag.clone(), body: body.clone(), built_at: Instant::now() },
    );
    Cached { body, etag }
}

pub fn invalidate(token: &str) {
    let mut cache = cache();
    cache.remove(&format!("m3u:{token}"));
    cache.remove(&format!("epg:{token}"));
}

/// Drop all cached output, for changes that can touch many playlists at once.
pub fn invalidate_all() {
    cache().clear();
}
