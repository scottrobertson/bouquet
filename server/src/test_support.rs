//! Small helpers for building test data in an in-memory database.

use rusqlite::{Connection, params};

use crate::db::Db;

pub fn db() -> Db {
    Db::open_in_memory().unwrap()
}

pub fn source(conn: &Connection, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO sources (name, server_url, stream_base_url, username, password) VALUES (?, 'http://s', 'http://s', 'u', 'p')",
        [name],
    )
    .unwrap();
    conn.last_insert_rowid()
}

pub fn source_channel(conn: &Connection, source_id: i64, stream_id: &str, name: &str, category: &str) -> i64 {
    conn.execute(
        "INSERT INTO source_channels (source_id, stream_id, name, epg_channel_id, category_name, position) \
         VALUES (?, ?, ?, ?, ?, 0)",
        params![source_id, stream_id, name, format!("{stream_id}.epg"), category],
    )
    .unwrap();
    conn.last_insert_rowid()
}

pub fn playlist(conn: &Connection, name: &str, token: &str) -> i64 {
    conn.execute("INSERT INTO playlists (name, output_token) VALUES (?, ?)", [name, token]).unwrap();
    conn.last_insert_rowid()
}

pub fn category(conn: &Connection, playlist_id: i64, name: &str, position: i64) -> i64 {
    conn.execute(
        "INSERT INTO playlist_categories (playlist_id, name, position) VALUES (?, ?, ?)",
        params![playlist_id, name, position],
    )
    .unwrap();
    conn.last_insert_rowid()
}
