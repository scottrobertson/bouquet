//! In-memory bus that lets background sync, probe and upload runs tell open
//! browser tabs that something moved. Tabs don't read the payload, they just
//! reload their data. Only works because the app is a single process.

use std::sync::LazyLock;

use serde::Serialize;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist_id: Option<i64>,
}

// A tab that falls this far behind just misses some nudges, which is harmless
// because it reloads on the next one anyway.
static BUS: LazyLock<broadcast::Sender<Change>> = LazyLock::new(|| broadcast::channel(256).0);

pub fn bump_source(source_id: i64) {
    let _ = BUS.send(Change { source_id: Some(source_id), playlist_id: None });
}

pub fn bump_playlist(playlist_id: i64) {
    let _ = BUS.send(Change { source_id: None, playlist_id: Some(playlist_id) });
}

pub fn subscribe() -> broadcast::Receiver<Change> {
    BUS.subscribe()
}
