pub mod storage;

use std::time::Duration;

use anyhow::{Result, anyhow};
use rusqlite::OptionalExtension;

use crate::db::Db;
use crate::debounce::Debouncer;
use crate::events::bump_playlist;
use crate::output::{m3u, resolve, xmltv};
use crate::pool::now;

struct Destination {
    playlist_id: i64,
    name: String,
    kind: String,
    config: String,
    m3u_path: String,
    epg_path: String,
    public_url_base: Option<String>,
}

/// Rebuild a destination's M3U and EPG and push both. It records its own
/// status and never fails, so a batch upload carries on past a broken one.
pub async fn upload_destination(db: &Db, dest_id: i64) {
    let dest = db
        .call(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT playlist_id, name, type, config, m3u_path, epg_path, public_url_base \
                     FROM upload_destinations WHERE id = ?",
                    [dest_id],
                    |r| {
                        Ok(Destination {
                            playlist_id: r.get(0)?,
                            name: r.get(1)?,
                            kind: r.get(2)?,
                            config: r.get(3)?,
                            m3u_path: r.get(4)?,
                            epg_path: r.get(5)?,
                            public_url_base: r.get(6)?,
                        })
                    },
                )
                .optional()?)
        })
        .await;
    let Ok(Some(dest)) = dest else { return };
    let playlist_id = dest.playlist_id;

    let _ = db
        .call(move |conn| {
            conn.execute(
                "UPDATE upload_destinations SET upload_status = 'uploading', upload_error = NULL WHERE id = ?",
                [dest_id],
            )?;
            Ok(())
        })
        .await;
    bump_playlist(playlist_id);

    let name = dest.name.clone();
    let result = push(db, dest).await;
    let _ = db
        .call(move |conn| {
            match &result {
                Ok(()) => conn.execute(
                    "UPDATE upload_destinations SET upload_status = 'ok', last_uploaded_at = ?, upload_error = NULL WHERE id = ?",
                    rusqlite::params![now(), dest_id],
                )?,
                Err(e) => {
                    eprintln!("[upload] destination {dest_id} ({name}) failed: {e:#}");
                    conn.execute(
                        "UPDATE upload_destinations SET upload_status = 'error', upload_error = ? WHERE id = ?",
                        rusqlite::params![format!("{e:#}"), dest_id],
                    )?
                }
            };
            Ok(())
        })
        .await;
    bump_playlist(playlist_id);
}

async fn push(db: &Db, dest: Destination) -> Result<()> {
    let playlist_id = dest.playlist_id;
    let epg_url = match &dest.public_url_base {
        Some(base) if !base.is_empty() => join_url(base, &dest.epg_path),
        _ => String::new(),
    };
    let (m3u, epg) = db
        .call(move |conn| {
            let playlist = crate::models::Playlist::by_id(conn, playlist_id)?.ok_or_else(|| anyhow!("Playlist not found"))?;
            let channels = resolve::resolve_playlist_channels(conn, &playlist)?;
            Ok((m3u::build_m3u(&channels, &epg_url), xmltv::build_xmltv(conn, &channels)?))
        })
        .await?;
    let target = storage::build_target(&dest.kind, &dest.config)?;
    target.write(&dest.m3u_path, &m3u).await?;
    target.write(&dest.epg_path, &epg).await?;
    Ok(())
}

/// The uploaded M3U points at the uploaded EPG, so the pair works on its own.
fn join_url(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// Upload one destination in the background. Used by the manual button.
pub fn start_upload(db: &Db, dest_id: i64) {
    let db = db.clone();
    tokio::spawn(async move { upload_destination(&db, dest_id).await });
}

async fn enabled_destinations(db: &Db, playlist_id: Option<i64>) -> Vec<i64> {
    db.call(move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id FROM upload_destinations WHERE enabled = 1 AND (?1 IS NULL OR playlist_id = ?1) ORDER BY id",
        )?;
        Ok(stmt.query_map([playlist_id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<i64>>>()?)
    })
    .await
    .unwrap_or_default()
}

pub async fn upload_playlist(db: &Db, playlist_id: i64) {
    for id in enabled_destinations(db, Some(playlist_id)).await {
        upload_destination(db, id).await;
    }
}

pub async fn upload_all_playlists(db: &Db) {
    let ids = enabled_destinations(db, None).await;
    if ids.is_empty() {
        return;
    }
    println!("[upload] uploading {} destination(s)", ids.len());
    for id in ids {
        upload_destination(db, id).await;
    }
}

// Wait after a sync before uploading, so a cron tick that syncs several sources
// uploads once instead of once per source.
static UPLOAD_SOON: Debouncer = Debouncer::new(Duration::from_secs(5));

pub fn request_upload_soon(db: &Db) {
    let db = db.clone();
    UPLOAD_SOON.call(move || async move { upload_all_playlists(&db).await });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;

    fn add_destination(db: &Db, playlist_id: i64, path: &str, public_url_base: Option<&str>) -> i64 {
        let conn = db.lock();
        conn.execute(
            "INSERT INTO upload_destinations (playlist_id, name, type, config, m3u_path, epg_path, public_url_base) \
             VALUES (?, 'Local', 'local', ?, 'playlist.m3u', 'guide.xml', ?)",
            rusqlite::params![playlist_id, serde_json::json!({ "path": path }).to_string(), public_url_base],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn status(db: &Db, id: i64) -> (String, Option<i64>, Option<String>) {
        db.lock()
            .query_row(
                "SELECT upload_status, last_uploaded_at, upload_error FROM upload_destinations WHERE id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
    }

    #[tokio::test]
    async fn writes_m3u_and_epg_pointing_at_the_public_epg() {
        let db = test_support::db();
        let dir = tempfile::tempdir().unwrap();
        let playlist = test_support::playlist(&db.lock(), "Test", "tok-upload");
        let dest = add_destination(&db, playlist, dir.path().to_str().unwrap(), Some("https://cdn.example.com/iptv"));

        upload_destination(&db, dest).await;

        let m3u = std::fs::read_to_string(dir.path().join("playlist.m3u")).unwrap();
        assert!(m3u.contains("url-tvg=\"https://cdn.example.com/iptv/guide.xml\""));
        let epg = std::fs::read_to_string(dir.path().join("guide.xml")).unwrap();
        assert!(epg.contains("<tv"));
        let (s, at, err) = status(&db, dest);
        assert_eq!(s, "ok");
        assert!(at.is_some());
        assert_eq!(err, None);
    }

    #[tokio::test]
    async fn records_an_error_when_the_target_fails() {
        let db = test_support::db();
        let dir = tempfile::tempdir().unwrap();
        // A regular file as the root, so writing under it fails on every OS.
        let not_a_dir = dir.path().join("not-a-dir");
        std::fs::write(&not_a_dir, "x").unwrap();
        let playlist = test_support::playlist(&db.lock(), "Bad", "tok-bad");
        let dest = add_destination(&db, playlist, not_a_dir.to_str().unwrap(), None);

        upload_destination(&db, dest).await;

        let (s, _, err) = status(&db, dest);
        assert_eq!(s, "error");
        assert!(err.is_some_and(|e| !e.is_empty()));
    }
}
