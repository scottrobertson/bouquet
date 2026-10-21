pub mod storage;

use std::time::Duration;

use anyhow::{Result, anyhow};
use rusqlite::OptionalExtension;

use crate::db::Db;
use crate::debounce::Debouncer;
use crate::events::bump_playlist;
use crate::jobs::{JobCtx, Jobs, Trigger, Work};
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

/// The upload job: rebuild a destination's M3U and EPG and push both. The
/// result is recorded on the destination too, so the settings page shows it.
pub async fn upload_destination(db: &Db, dest_id: i64, ctx: &JobCtx) -> Result<()> {
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
    let Some(dest) = dest? else {
        ctx.summary("The destination was deleted before it could upload");
        return Ok(());
    };
    let playlist_id = dest.playlist_id;
    let result = push(db, &dest, ctx).await;
    let error = result.as_ref().err().map(|e| format!("{e:#}"));
    db.call(move |conn| {
        match error {
            None => conn.execute(
                "UPDATE upload_destinations SET upload_status = 'ok', last_uploaded_at = ?, upload_error = NULL WHERE id = ?",
                rusqlite::params![now(), dest_id],
            )?,
            Some(e) => conn.execute(
                "UPDATE upload_destinations SET upload_status = 'error', upload_error = ? WHERE id = ?",
                rusqlite::params![e, dest_id],
            )?,
        };
        Ok(())
    })
    .await?;
    bump_playlist(playlist_id);
    result?;
    ctx.summary(format!("Uploaded {} and {}", dest.m3u_path, dest.epg_path));
    Ok(())
}

async fn push(db: &Db, dest: &Destination, ctx: &JobCtx) -> Result<()> {
    let playlist_id = dest.playlist_id;
    let epg_url = match &dest.public_url_base {
        Some(base) if !base.is_empty() => join_url(base, &dest.epg_path),
        _ => String::new(),
    };
    ctx.step("Building the playlist and guide").await;
    let (m3u, epg, count) = db
        .call(move |conn| {
            let playlist = crate::models::Playlist::by_id(conn, playlist_id)?.ok_or_else(|| anyhow!("Playlist not found"))?;
            let channels = resolve::resolve_playlist_channels(conn, &playlist)?;
            Ok((m3u::build_m3u(&channels, &epg_url), xmltv::build_xmltv(conn, &channels)?, channels.len()))
        })
        .await?;
    ctx.info(format!("Built {count} channels for {} ({})", dest.name, dest.kind)).await;
    let target = storage::build_target(&dest.kind, &dest.config)?;
    ctx.step(&format!("Uploading {}", dest.m3u_path)).await;
    target.write(&dest.m3u_path, &m3u).await?;
    ctx.info(format!("Uploaded {} ({} KB)", dest.m3u_path, m3u.len().div_ceil(1024))).await;
    ctx.step(&format!("Uploading {}", dest.epg_path)).await;
    target.write(&dest.epg_path, &epg).await?;
    ctx.info(format!("Uploaded {} ({} KB)", dest.epg_path, epg.len().div_ceil(1024))).await;
    Ok(())
}

/// The uploaded M3U points at the uploaded EPG, so the pair works on its own.
fn join_url(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

async fn enabled_destinations(db: &Db) -> Result<Vec<i64>> {
    db.call(move |conn| {
        let mut stmt = conn.prepare("SELECT id FROM upload_destinations WHERE enabled = 1 ORDER BY id")?;
        Ok(stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<i64>>>()?)
    })
    .await
}

// Wait after a sync before uploading, so a cron tick that syncs several sources
// uploads once instead of once per source.
static UPLOAD_SOON: Debouncer = Debouncer::new(Duration::from_secs(5));

impl Jobs {
    /// Queue an upload job for every enabled destination, once syncs go quiet.
    pub fn upload_all_soon(&self) {
        let jobs = self.clone();
        UPLOAD_SOON.call(move || async move {
            let ids = match enabled_destinations(jobs.db()).await {
                Ok(ids) => ids,
                Err(e) => return eprintln!("[upload] couldn't list destinations: {e:#}"),
            };
            for id in ids {
                if let Err(e) = jobs.enqueue(Work::Upload { destination_id: id }, Trigger::Automatic).await {
                    eprintln!("[upload] couldn't queue destination {id}: {e:#}");
                }
            }
        });
    }
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

        let _ = upload_destination(&db, dest, &JobCtx::detached()).await;

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

        let _ = upload_destination(&db, dest, &JobCtx::detached()).await;

        let (s, _, err) = status(&db, dest);
        assert_eq!(s, "error");
        assert!(err.is_some_and(|e| !e.is_empty()));
    }
}
