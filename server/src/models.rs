//! Row types for the tables most code reads whole. Timestamps are unix seconds
//! in the database, so they're kept as plain integers here too.

use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::smart_sort::{SmartSortConfig, SmartSortPrefer};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub output_token: String,
    pub created_at: i64,
    pub alt_name_template: String,
    pub smart_sort_prefer: String,
    pub smart_sort_audio: bool,
    pub smart_sort_available_first: bool,
    pub auto_disable_failed_probes_after: i64,
    pub channel_name_template: String,
}

impl Playlist {
    pub const COLUMNS: &'static str = "id, name, output_token, created_at, alt_name_template, \
        smart_sort_prefer, smart_sort_audio, smart_sort_available_first, \
        auto_disable_failed_probes_after, channel_name_template";

    pub fn from_row(r: &Row) -> rusqlite::Result<Playlist> {
        Ok(Playlist {
            id: r.get(0)?,
            name: r.get(1)?,
            output_token: r.get(2)?,
            created_at: r.get(3)?,
            alt_name_template: r.get(4)?,
            smart_sort_prefer: r.get(5)?,
            smart_sort_audio: r.get(6)?,
            smart_sort_available_first: r.get(7)?,
            auto_disable_failed_probes_after: r.get(8)?,
            channel_name_template: r.get(9)?,
        })
    }

    pub fn by_id(conn: &Connection, id: i64) -> rusqlite::Result<Option<Playlist>> {
        conn.query_row(
            &format!("SELECT {} FROM playlists WHERE id = ?", Self::COLUMNS),
            [id],
            Self::from_row,
        )
        .optional()
    }

    pub fn by_token(conn: &Connection, token: &str) -> rusqlite::Result<Option<Playlist>> {
        conn.query_row(
            &format!("SELECT {} FROM playlists WHERE output_token = ?", Self::COLUMNS),
            [token],
            Self::from_row,
        )
        .optional()
    }

    pub fn smart_sort_config(&self) -> SmartSortConfig {
        SmartSortConfig {
            prefer: SmartSortPrefer::parse(&self.smart_sort_prefer),
            audio: self.smart_sort_audio,
            available_first: self.smart_sort_available_first,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub server_url: String,
    pub stream_base_url: Option<String>,
    pub username: String,
    pub password: String,
    pub sync_status: String,
    pub output_format: String,
    pub auto_import_groups: bool,
    pub enabled: bool,
    pub sync_interval_minutes: i64,
    pub last_synced_at: Option<i64>,
    pub last_error: Option<String>,
    pub channel_count: i64,
    pub expires_at: Option<i64>,
    pub max_connections: Option<i64>,
    pub account_status: Option<String>,
    pub epg_stale: bool,
    pub probe_enabled: bool,
    pub probe_concurrency: i64,
    pub probe_interval_minutes: i64,
    pub probe_timeout_seconds: i64,
    pub probe_detect_black_screen: bool,
    pub probe_status: String,
    pub last_probed_at: Option<i64>,
    pub probe_error: Option<String>,
    pub probe_total: i64,
    pub probe_done: i64,
    pub notes: Option<String>,
    pub created_at: i64,
}

impl Source {
    pub const COLUMNS: &'static str = "id, name, type, server_url, stream_base_url, username, password, \
        sync_status, output_format, auto_import_groups, enabled, sync_interval_minutes, last_synced_at, \
        last_error, channel_count, expires_at, max_connections, account_status, epg_stale, probe_enabled, \
        probe_concurrency, probe_interval_minutes, probe_timeout_seconds, \
        probe_detect_black_screen, probe_status, last_probed_at, probe_error, probe_total, probe_done, \
        notes, created_at";

    pub fn from_row(r: &Row) -> rusqlite::Result<Source> {
        Ok(Source {
            id: r.get(0)?,
            name: r.get(1)?,
            kind: r.get(2)?,
            server_url: r.get(3)?,
            stream_base_url: r.get(4)?,
            username: r.get(5)?,
            password: r.get(6)?,
            sync_status: r.get(7)?,
            output_format: r.get(8)?,
            auto_import_groups: r.get(9)?,
            enabled: r.get(10)?,
            sync_interval_minutes: r.get(11)?,
            last_synced_at: r.get(12)?,
            last_error: r.get(13)?,
            channel_count: r.get(14)?,
            expires_at: r.get(15)?,
            max_connections: r.get(16)?,
            account_status: r.get(17)?,
            epg_stale: r.get(18)?,
            probe_enabled: r.get(19)?,
            probe_concurrency: r.get(20)?,
            probe_interval_minutes: r.get(21)?,
            probe_timeout_seconds: r.get(22)?,
            probe_detect_black_screen: r.get(23)?,
            probe_status: r.get(24)?,
            last_probed_at: r.get(25)?,
            probe_error: r.get(26)?,
            probe_total: r.get(27)?,
            probe_done: r.get(28)?,
            notes: r.get(29)?,
            created_at: r.get(30)?,
        })
    }

    pub fn by_id(conn: &Connection, id: i64) -> rusqlite::Result<Option<Source>> {
        conn.query_row(&format!("SELECT {} FROM sources WHERE id = ?", Self::COLUMNS), [id], Self::from_row)
            .optional()
    }

    pub fn all(conn: &Connection) -> rusqlite::Result<Vec<Source>> {
        let mut stmt = conn.prepare(&format!("SELECT {} FROM sources ORDER BY id", Self::COLUMNS))?;
        stmt.query_map([], Self::from_row)?.collect()
    }

    /// The login used for API calls and stream URLs. Stream URLs use the real
    /// address the provider reported, so the server URL can be a proxy.
    pub fn stream_creds(&self) -> crate::xtream::Creds {
        crate::xtream::Creds {
            server_url: self.stream_base_url.clone().unwrap_or_else(|| self.server_url.clone()),
            username: self.username.clone(),
            password: self.password.clone(),
        }
    }

    pub fn api_creds(&self) -> crate::xtream::Creds {
        crate::xtream::Creds {
            server_url: self.server_url.clone(),
            username: self.username.clone(),
            password: self.password.clone(),
        }
    }
}
