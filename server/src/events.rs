//! In-memory bus that tells open browser tabs what's happening. Jobs send
//! their progress here, and anything that changes data sends a nudge so tabs
//! reload their page. Only works because the app is a single process.

use std::sync::LazyLock;

use serde::Serialize;
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::jobs::JobView;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ServerEvent {
    #[serde(rename_all = "camelCase")]
    Change {
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        source_id: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        playlist_id: Option<i64>,
    },
    Job { job: Box<JobView> },
}

// A tab that falls this far behind just misses some updates, which is harmless
// because the next one carries the full job and reloads the page anyway.
static BUS: LazyLock<broadcast::Sender<ServerEvent>> = LazyLock::new(|| broadcast::channel(256).0);

pub fn bump_source(source_id: i64) {
    let _ = BUS.send(ServerEvent::Change { source_id: Some(source_id), playlist_id: None });
}

pub fn bump_playlist(playlist_id: i64) {
    let _ = BUS.send(ServerEvent::Change { source_id: None, playlist_id: Some(playlist_id) });
}

pub fn send_job(job: JobView) {
    let _ = BUS.send(ServerEvent::Job { job: Box::new(job) });
}

pub fn subscribe() -> broadcast::Receiver<ServerEvent> {
    BUS.subscribe()
}
