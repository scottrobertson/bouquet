use std::collections::{HashMap, HashSet};
use std::time::Instant;

use anyhow::{Result, anyhow};
use rusqlite::{Connection, params};

use crate::db::Db;
use crate::events::bump_source;
use crate::models::Source;
use crate::output::cache::invalidate_all;
use crate::pool::{is_interval_due, map_pool, now};
use crate::sources::categories::sync_source_categories;
use crate::sources::changes::{BeforeChannel, SeenChannel, record_sync_changes};
use crate::upload::request_upload_soon;
use crate::xtream;

// How long to keep programmes for sources that stop syncing.
const GUIDE_RETENTION_DAYS: i64 = 7;
// EPG is one request per channel, so fetch a handful at a time rather than
// hitting the provider with all of them at once.
const EPG_FETCH_CONCURRENCY: usize = 10;

fn set_error(conn: &Connection, source_id: i64, message: &str) -> Result<()> {
    conn.execute(
        "UPDATE sources SET sync_status = 'error', last_error = ? WHERE id = ?",
        params![message, source_id],
    )?;
    Ok(())
}

/// Start a sync in the background. The source shows as syncing straight away
/// so the UI updates before the slow fetch finishes.
pub async fn start_sync(db: &Db, source_id: i64) {
    let _ = db
        .call(move |conn| {
            conn.execute("UPDATE sources SET sync_status = 'syncing' WHERE id = ?", [source_id])?;
            Ok(())
        })
        .await;
    bump_source(source_id);
    let db = db.clone();
    tokio::spawn(async move {
        if let Err(e) = run_sync(&db, source_id).await {
            let msg = e.to_string();
            let _ = db.call(move |conn| set_error(conn, source_id, &msg)).await;
            bump_source(source_id);
        }
    });
}

/// Pull a source's catalog and guide. Channels the provider stops returning
/// are marked unavailable rather than deleted. The channel step commits before
/// the EPG step, so a slow or failing guide never throws away a good sync, but
/// the source shows as syncing until the guide is done too.
pub async fn run_sync(db: &Db, source_id: i64) -> Result<()> {
    let Some(source) = db.call(move |conn| Ok(Source::by_id(conn, source_id)?)).await? else {
        return Ok(());
    };
    println!("[sync] {}: starting", source.name);
    let started = Instant::now();
    db.call(move |conn| {
        conn.execute("UPDATE sources SET sync_status = 'syncing' WHERE id = ?", [source_id])?;
        Ok(())
    })
    .await?;

    let creds = source.api_creds();
    let synced_at = now();

    match sync_channels(db, &source, &creds, synced_at).await {
        Ok(ChannelStep::Synced) => {}
        Ok(ChannelStep::AccountFailed) => return Ok(()),
        Err(e) => {
            eprintln!("[sync] {}: failed: {e:#}", source.name);
            let msg = e.to_string();
            db.call(move |conn| set_error(conn, source_id, &msg)).await?;
            bump_source(source_id);
            return Ok(());
        }
    }

    // The guide is best effort. A failure still ends the sync "ok" but leaves a
    // note, so the catalog stays usable even without a guide.
    let note = match sync_epg(db, &source, &creds).await {
        Ok(note) => note,
        Err(e) => {
            eprintln!("[sync] {}: EPG update failed: {e}", source.name);
            Some(format!("Channels synced. EPG update failed: {e}"))
        }
    };
    db.call(move |conn| {
        conn.execute(
            "UPDATE sources SET sync_status = 'ok', last_error = ? WHERE id = ?",
            params![note, source_id],
        )?;
        Ok(())
    })
    .await?;
    bump_source(source_id);

    println!("[sync] {}: done in {:.1}s", source.name, started.elapsed().as_secs_f64());
    // A fresh catalog and guide, so push playlists to their upload destinations.
    request_upload_soon(db);
    Ok(())
}

enum ChannelStep {
    AccountFailed,
    Synced,
}

async fn sync_channels(db: &Db, source: &Source, creds: &xtream::Creds, synced_at: i64) -> Result<ChannelStep> {
    let source_id = source.id;
    let account = xtream::validate_account(creds).await;
    if !account.ok {
        let msg = account.message.clone().unwrap_or_else(|| "Account validation failed".into());
        eprintln!("[sync] {}: account validation failed: {msg}", source.name);
        db.call(move |conn| set_error(conn, source_id, &msg)).await?;
        bump_source(source_id);
        return Ok(ChannelStep::AccountFailed);
    }

    let fetch_started = Instant::now();
    let categories = xtream::fetch_live_categories(creds).await?;
    let streams = xtream::fetch_live_streams(creds).await?;
    println!(
        "[sync] {}: fetched {} categories, {} streams in {:.1}s",
        source.name,
        categories.len(),
        streams.len(),
        fetch_started.elapsed().as_secs_f64()
    );
    let category_names: HashMap<String, String> =
        categories.into_iter().map(|c| (c.category_id, c.category_name)).collect();

    let auto_import = source.auto_import_groups;
    let name = source.name.clone();
    let stream_count = streams.len();
    db.call(move |conn| {
        let before = catalog_snapshot(conn, source_id)?;
        let tx = conn.transaction()?;
        // Mark everything unavailable, then the upsert flips the channels still
        // present back on.
        tx.execute("UPDATE source_channels SET available = 0 WHERE source_id = ?", [source_id])?;
        let mut seen = Vec::with_capacity(streams.len());
        let mut seen_categories: Vec<String> = Vec::new();
        let mut seen_category_set = HashSet::new();
        {
            let mut stmt = tx.prepare(
                "INSERT INTO source_channels (source_id, stream_id, name, logo, epg_channel_id, category_name, \
                   position, tv_archive, tv_archive_duration, available, last_seen_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10) \
                 ON CONFLICT (source_id, stream_id) DO UPDATE SET name = excluded.name, logo = excluded.logo, \
                   epg_channel_id = excluded.epg_channel_id, category_name = excluded.category_name, \
                   position = excluded.position, tv_archive = excluded.tv_archive, \
                   tv_archive_duration = excluded.tv_archive_duration, available = 1, \
                   last_seen_at = excluded.last_seen_at",
            )?;
            for (position, s) in streams.iter().enumerate() {
                let category_name = s.category_id.as_ref().and_then(|id| category_names.get(id)).cloned();
                if let Some(c) = &category_name
                    && seen_category_set.insert(c.clone())
                {
                    seen_categories.push(c.clone());
                }
                stmt.execute(params![
                    source_id,
                    s.stream_id,
                    s.name,
                    s.logo,
                    s.epg_channel_id,
                    category_name,
                    position as i64,
                    s.tv_archive,
                    s.tv_archive_duration,
                    synced_at
                ])?;
                seen.push(SeenChannel { stream_id: s.stream_id.clone(), name: s.name.clone(), category_name });
            }
        }
        tx.commit()?;
        sync_source_categories(conn, source_id, &seen_categories, auto_import)?;

        // Commit the channel success now, before the slower guide step. Keep the
        // old stream base URL if the provider didn't send one this time.
        conn.execute(
            "UPDATE sources SET last_synced_at = ?, last_error = NULL, channel_count = ?, \
               expires_at = ?, max_connections = ?, account_status = ?, \
               stream_base_url = coalesce(?, stream_base_url) WHERE id = ?",
            params![
                synced_at,
                stream_count as i64,
                account.expires_at.map(|d| d.timestamp()),
                account.max_connections,
                account.status,
                account.stream_base_url,
                source_id
            ],
        )?;
        // Availability and auto-sync groups changed, so players should see it on
        // their next poll rather than after the cache runs out.
        invalidate_all();
        bump_source(source_id);
        println!("[sync] {name}: {stream_count} channels synced");

        // The change history must never break a sync.
        match record_sync_changes(conn, source_id, &before, &seen, synced_at) {
            Ok(Some((added, removed))) => println!("[sync] {name}: {added} added, {removed} removed since last sync"),
            Ok(None) => {}
            Err(e) => eprintln!("[sync] recording changes failed: {e:#}"),
        }
        // After the change log, so the diff above still sees the rows.
        let pruned = prune_unavailable_channels(conn, source_id)?;
        if pruned > 0 {
            println!("[sync] {name}: pruned {pruned} dead channels");
        }
        Ok(())
    })
    .await?;
    Ok(ChannelStep::Synced)
}

fn catalog_snapshot(conn: &Connection, source_id: i64) -> Result<Vec<(String, BeforeChannel)>> {
    let mut stmt =
        conn.prepare("SELECT stream_id, name, category_name, available FROM source_channels WHERE source_id = ? ORDER BY id")?;
    let rows = stmt.query_map([source_id], |r| {
        Ok((r.get(0)?, BeforeChannel { name: r.get(1)?, category_name: r.get(2)?, available: r.get(3)? }))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Fetch and store the guide. Returns a note to show on the source when some
/// channels still failed after retrying.
async fn sync_epg(db: &Db, source: &Source, creds: &xtream::Creds) -> Result<Option<String>> {
    let source_id = source.id;
    // Only channels that can reach output: available, and in an enabled
    // category or none. Channels sharing an EPG id share a guide, so fetch each
    // id once.
    let targets: Vec<(String, String)> = db
        .call(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT sc.stream_id, sc.epg_channel_id FROM source_channels sc \
                 LEFT JOIN source_categories cat ON cat.source_id = sc.source_id AND cat.name = sc.category_name \
                 WHERE sc.source_id = ? AND sc.available = 1 AND (cat.id IS NULL OR cat.enabled = 1) ORDER BY sc.id",
            )?;
            let rows: Vec<(String, Option<String>)> = stmt
                .query_map([source_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            drop(stmt);
            let mut seen = HashSet::new();
            let mut targets = Vec::new();
            for (stream_id, epg_id) in rows {
                if let Some(epg_id) = epg_id.filter(|e| !e.is_empty())
                    && seen.insert(epg_id.clone())
                {
                    targets.push((epg_id, stream_id));
                }
            }
            refresh_source_epg_channels(conn, source_id)?;
            Ok(targets)
        })
        .await?;

    println!("[sync] {}: fetching EPG for {} channels", source.name, targets.len());
    let started = Instant::now();
    let fetched = map_pool(targets.clone(), EPG_FETCH_CONCURRENCY, |(epg_id, stream_id)| {
        let creds = creds.clone();
        async move { xtream::fetch_simple_data_table(&creds, &stream_id, &epg_id).await }
    })
    .await;
    let failures = fetched.iter().filter(|r| r.is_err()).count();
    let first_error = fetched.iter().find_map(|r| r.as_ref().err().map(|e| e.to_string()));
    // Couldn't reach the provider for any channel, so leave the stored guide alone.
    if !targets.is_empty() && failures == targets.len() {
        return Err(anyhow!("every channel's EPG request failed ({})", first_error.unwrap_or_default()));
    }
    let results: Vec<Option<Vec<xtream::Programme>>> = fetched.into_iter().map(|r| r.ok()).collect();

    let total = targets.len();
    db.call(move |conn| {
        // Channels whose fetch failed keep their old programmes rather than going blank.
        let tx = conn.transaction()?;
        {
            let mut delete = tx.prepare("DELETE FROM epg_programmes WHERE source_id = ? AND channel_id = ?")?;
            let mut insert = tx.prepare(
                "INSERT INTO epg_programmes (source_id, channel_id, start_ts, stop_ts, title, sub_title, description, \
                   category, has_archive) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?)",
            )?;
            for ((epg_id, _), programmes) in targets.iter().zip(results) {
                let Some(programmes) = programmes else { continue };
                delete.execute(params![source_id, epg_id])?;
                for p in programmes {
                    insert.execute(params![source_id, p.channel_id, p.start_ts, p.stop_ts, p.title, p.description, p.has_archive])?;
                }
            }
        }
        // Stored programmes now match the enabled categories, unless some
        // channels were missed.
        if failures == 0 {
            tx.execute("UPDATE sources SET epg_stale = 0 WHERE id = ?", [source_id])?;
        }
        tx.commit()?;
        Ok(())
    })
    .await?;
    let failed = if failures > 0 { format!(" ({failures} failed)") } else { String::new() };
    println!(
        "[sync] {}: EPG done, {}/{total} channels{failed} in {:.1}s",
        source.name,
        total - failures,
        started.elapsed().as_secs_f64()
    );
    Ok((failures > 0).then(|| {
        format!(
            "Channels synced. The guide for {failures} of {total} channels couldn't be updated ({}), \
             so they still show their previous guide. Sync again to retry them.",
            first_error.unwrap_or_default()
        )
    }))
}

/// Delete a source's unavailable channels that no playlist uses, so channels a
/// provider dropped for good don't clutter the browser. Channels in a playlist
/// stay, so the edit survives a provider hiccup and can be repointed.
pub fn prune_unavailable_channels(conn: &Connection, source_id: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM source_channels WHERE source_id = ? AND available = 0 \
         AND id NOT IN (SELECT source_channel_id FROM playlist_channels)",
        [source_id],
    )?)
}

/// Rebuild a source's EPG channel list, for the EPG picker, from its catalog:
/// one entry per distinct EPG id, named after its first channel.
fn refresh_source_epg_channels(conn: &mut Connection, source_id: i64) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT epg_channel_id, name, logo FROM source_channels WHERE source_id = ? AND available = 1 ORDER BY position, id",
    )?;
    let rows = stmt.query_map([source_id], |r| {
        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
    })?;
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for row in rows {
        let (epg_id, name, logo) = row?;
        if let Some(epg_id) = epg_id.filter(|e| !e.is_empty())
            && seen.insert(epg_id.clone())
        {
            entries.push((epg_id, name, logo));
        }
    }
    drop(stmt);
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM source_epg_channels WHERE source_id = ?", [source_id])?;
    {
        let mut insert =
            tx.prepare("INSERT INTO source_epg_channels (source_id, channel_id, display_name, icon) VALUES (?, ?, ?, ?)")?;
        for (epg_id, name, logo) in entries {
            insert.execute(params![source_id, epg_id, name, logo])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Drop programmes that ended longer ago than the retention window. Each sync
/// already replaces a source's rows, so this only matters for sources that
/// have stopped syncing.
pub fn prune_old_programmes(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM epg_programmes WHERE stop_ts < ?", [now() - GUIDE_RETENTION_DAYS * 86_400])?;
    Ok(())
}

/// Sync the sources whose interval has passed, one at a time so providers
/// aren't hit in parallel. Run hourly; most ticks sync nothing.
pub async fn sync_due_sources(db: &Db) -> Result<()> {
    let sources = db.call(|conn| Ok(Source::all(conn)?)).await?;
    let t = now();
    let due: Vec<&Source> = sources
        .iter()
        .filter(|s| s.enabled && is_interval_due(s.last_synced_at, s.sync_interval_minutes, t))
        .collect();
    println!("[sync] {} of {} sources due", due.len(), sources.len());
    for s in due {
        if let Err(e) = run_sync(db, s.id).await {
            eprintln!("[sync] {}: failed: {e:#}", s.name);
        }
    }
    db.call(|conn| prune_old_programmes(conn)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;

    fn add(conn: &Connection, source_id: i64, stream: &str, available: bool) -> i64 {
        let id = test_support::source_channel(conn, source_id, stream, stream, "UK");
        conn.execute("UPDATE source_channels SET available = ? WHERE id = ?", params![available, id]).unwrap();
        id
    }

    fn ids(conn: &Connection, source_id: i64) -> Vec<i64> {
        let mut stmt = conn.prepare("SELECT id FROM source_channels WHERE source_id = ? ORDER BY id").unwrap();
        stmt.query_map([source_id], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    #[test]
    fn prunes_unavailable_channels_no_playlist_uses() {
        let db = test_support::db();
        let conn = db.lock();
        let s = test_support::source(&conn, "Main");
        add(&conn, s, "a", false);
        let alive = add(&conn, s, "b", true);
        assert_eq!(prune_unavailable_channels(&conn, s).unwrap(), 1);
        assert_eq!(ids(&conn, s), [alive]);
    }

    #[test]
    fn keeps_an_unavailable_channel_a_playlist_uses() {
        let db = test_support::db();
        let conn = db.lock();
        let s = test_support::source(&conn, "Main");
        let dead = add(&conn, s, "a", false);
        let p = test_support::playlist(&conn, "PL", "tok");
        let cat = test_support::category(&conn, p, "UK", 0);
        conn.execute(
            "INSERT INTO playlist_channels (playlist_id, category_id, source_channel_id) VALUES (?, ?, ?)",
            params![p, cat, dead],
        )
        .unwrap();
        assert_eq!(prune_unavailable_channels(&conn, s).unwrap(), 0);
        assert_eq!(ids(&conn, s), [dead]);
    }

    /// A pretend Xtream provider on a local port, serving `streams` and one
    /// programme per channel.
    async fn fake_provider(streams: serde_json::Value) -> String {
        use axum::extract::Query;
        use base64::Engine;
        use std::collections::HashMap;
        let app = axum::Router::new().route(
            "/player_api.php",
            axum::routing::get(move |Query(q): Query<HashMap<String, String>>| {
                let streams = streams.clone();
                async move {
                    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
                    let body = match q.get("action").map(String::as_str) {
                        None => serde_json::json!({
                            "user_info": { "auth": 1, "status": "Active", "exp_date": "1900000000", "max_connections": "2" },
                            "server_info": { "url": "real.example", "port": "8080", "server_protocol": "http" },
                        }),
                        Some("get_live_categories") => serde_json::json!([
                            { "category_id": "1", "category_name": "News" },
                            { "category_id": "2", "category_name": "Sport" },
                        ]),
                        Some("get_live_streams") => streams,
                        Some("get_simple_data_table") => serde_json::json!({ "epg_listings": [{
                            "title": b64(&format!("Show on {}", q["stream_id"])),
                            "start_timestamp": "1000", "stop_timestamp": "2000", "has_archive": 1,
                        }]}),
                        _ => serde_json::json!(null),
                    };
                    axum::Json(body)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn full_sync_against_a_provider() {
        let db = test_support::db();
        let url = fake_provider(serde_json::json!([
            { "stream_id": 1, "name": "BBC News", "category_id": "1", "epg_channel_id": "bbcnews.uk", "tv_archive": 1, "tv_archive_duration": "7" },
            { "stream_id": 2, "name": "Sky Sports", "category_id": "2", "epg_channel_id": "sky.uk" },
            { "stream_id": 3, "name": "Sky Sports Backup", "category_id": "2", "epg_channel_id": "sky.uk" },
        ]))
        .await;
        let source = {
            let conn = db.lock();
            conn.execute(
                "INSERT INTO sources (name, server_url, username, password) VALUES ('Fake', ?, 'u', 'p')",
                [&url],
            )
            .unwrap();
            conn.last_insert_rowid()
        };

        run_sync(&db, source).await.unwrap();

        let conn = db.lock();
        let s = Source::by_id(&conn, source).unwrap().unwrap();
        assert_eq!(s.sync_status, "ok");
        assert_eq!(s.last_error, None);
        assert!(!s.epg_stale);
        assert_eq!(s.channel_count, 3);
        assert_eq!(s.stream_base_url.as_deref(), Some("http://real.example:8080"));
        assert_eq!(s.max_connections, Some(2));
        let channels: Vec<(String, Option<String>, i64)> = conn
            .prepare("SELECT name, category_name, tv_archive_duration FROM source_channels ORDER BY position")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(channels[0], ("BBC News".into(), Some("News".into()), 7));
        assert_eq!(channels[2].1.as_deref(), Some("Sport"));
        // Two channels share sky.uk, so the guide holds two channels, not three.
        let epg: i64 = conn.query_row("SELECT count(*) FROM source_epg_channels", [], |r| r.get(0)).unwrap();
        let progs: Vec<(String, String)> = conn
            .prepare("SELECT channel_id, title FROM epg_programmes ORDER BY channel_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(epg, 2);
        assert_eq!(progs, [("bbcnews.uk".into(), "Show on 1".into()), ("sky.uk".into(), "Show on 2".into())]);
        // A first sync is a baseline, so no history yet.
        let changes: i64 = conn.query_row("SELECT count(*) FROM source_changes", [], |r| r.get(0)).unwrap();
        assert_eq!(changes, 0);
    }

    /// A provider that turns some guide requests away: stream 1 gets two 503s
    /// before it answers, stream 2 never gets through.
    async fn flaky_provider() -> String {
        use axum::extract::Query;
        use base64::Engine;
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};
        let tries: Arc<Mutex<HashMap<String, u32>>> = Default::default();
        let app = axum::Router::new().route(
            "/player_api.php",
            axum::routing::get(move |Query(q): Query<HashMap<String, String>>| {
                let tries = tries.clone();
                async move {
                    use axum::response::IntoResponse;
                    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
                    let body = match q.get("action").map(String::as_str) {
                        None => serde_json::json!({ "user_info": { "auth": 1 } }),
                        Some("get_live_categories") => serde_json::json!([{ "category_id": "1", "category_name": "News" }]),
                        Some("get_live_streams") => serde_json::json!([
                            { "stream_id": 1, "name": "Flaky", "category_id": "1", "epg_channel_id": "flaky.uk" },
                            { "stream_id": 2, "name": "Down", "category_id": "1", "epg_channel_id": "down.uk" },
                        ]),
                        Some("get_simple_data_table") => {
                            let stream = q["stream_id"].clone();
                            let n = {
                                let mut t = tries.lock().unwrap();
                                let n = t.entry(stream.clone()).or_default();
                                *n += 1;
                                *n
                            };
                            if stream == "2" || n <= 2 {
                                return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
                            }
                            serde_json::json!({ "epg_listings": [{ "title": b64("Show"), "start_timestamp": "1000", "stop_timestamp": "2000" }] })
                        }
                        _ => serde_json::json!(null),
                    };
                    axum::Json(body).into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn retries_busy_responses_and_reports_channels_that_never_answer() {
        let db = test_support::db();
        let url = flaky_provider().await;
        let source = {
            let conn = db.lock();
            conn.execute("INSERT INTO sources (name, server_url, username, password, epg_stale) VALUES ('Flaky', ?, 'u', 'p', 1)", [&url])
                .unwrap();
            conn.last_insert_rowid()
        };

        run_sync(&db, source).await.unwrap();

        let conn = db.lock();
        let s = Source::by_id(&conn, source).unwrap().unwrap();
        assert_eq!(s.sync_status, "ok");
        let note = s.last_error.unwrap();
        assert!(note.contains("1 of 2 channels"), "{note}");
        assert!(note.contains("HTTP 503"), "{note}");
        // Not every channel's guide was refreshed, so the source still says so.
        assert!(s.epg_stale);
        let stored: Vec<String> = conn
            .prepare("SELECT channel_id FROM epg_programmes")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(stored, ["flaky.uk"]);
    }

    #[test]
    fn retry_delays_double_and_honour_retry_after() {
        assert_eq!(xtream::retry_delay(0, None) * 2, xtream::retry_delay(1, None));
        assert_eq!(xtream::retry_delay(3, Some(std::time::Duration::from_secs(7))).as_secs(), 7);
        assert_eq!(xtream::retry_delay(0, Some(std::time::Duration::from_secs(600))).as_secs(), 30);
    }

    #[tokio::test]
    async fn asks_the_provider_for_gzip() {
        use axum::http::HeaderMap;
        let app = axum::Router::new().route(
            "/player_api.php",
            axum::routing::get(|headers: HeaderMap| async move {
                let accepts = headers.get("accept-encoding").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                axum::Json(serde_json::json!([{ "category_id": "1", "category_name": accepts }]))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let creds = xtream::Creds { server_url: format!("http://{addr}"), username: "u".into(), password: "p".into() };
        let cats = xtream::fetch_live_categories(&creds).await.unwrap();
        assert!(cats[0].category_name.contains("gzip"), "{}", cats[0].category_name);
    }

    #[tokio::test]
    async fn bad_login_marks_the_source_failed() {
        let db = test_support::db();
        let source = {
            let conn = db.lock();
            // Nothing listens on port 9, so the request fails straight away.
            conn.execute("INSERT INTO sources (name, server_url, username, password) VALUES ('Dead', 'http://127.0.0.1:9', 'u', 'p')", [])
                .unwrap();
            conn.last_insert_rowid()
        };
        run_sync(&db, source).await.unwrap();
        let s = Source::by_id(&db.lock(), source).unwrap().unwrap();
        assert_eq!(s.sync_status, "error");
        assert!(s.last_error.unwrap().starts_with("Connection failed"));
    }

    #[test]
    fn prune_only_touches_the_given_source() {
        let db = test_support::db();
        let conn = db.lock();
        let s = test_support::source(&conn, "Main");
        let other = test_support::source(&conn, "Other");
        add(&conn, s, "a", false);
        let other_dead = add(&conn, other, "a", false);
        assert_eq!(prune_unavailable_channels(&conn, s).unwrap(), 1);
        assert_eq!(ids(&conn, other), [other_dead]);
    }
}
