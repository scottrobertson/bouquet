pub mod ffprobe;

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use rusqlite::{Connection, params, params_from_iter};

use crate::db::{Db, ID_CHUNK, placeholders};
use crate::debounce::Debouncer;
use crate::events::bump_source;
use crate::models::Source;
use crate::playlist::mutations::{auto_disable_failed_channels, revive_recovered_channels};
use crate::pool::{is_interval_due, map_pool, now};
use crate::xtream::build_stream_url;
use ffprobe::ProbeResult;

/// The external programs a probe runs, behind a trait so tests can stand in
/// for ffmpeg.
#[async_trait]
pub trait Tools: Send + Sync {
    async fn probe_stream(&self, url: &str, timeout_seconds: i64, hls: bool) -> ProbeResult;
    async fn detect_black_screen(&self, url: &str, seconds: i64, hls: bool) -> bool;
    async fn measure_bitrate(&self, url: &str, seconds: i64, hls: bool) -> Option<i64>;
}

pub struct Ffmpeg;

#[async_trait]
impl Tools for Ffmpeg {
    async fn probe_stream(&self, url: &str, timeout_seconds: i64, hls: bool) -> ProbeResult {
        ffprobe::probe_stream(url, timeout_seconds, hls).await
    }
    async fn detect_black_screen(&self, url: &str, seconds: i64, hls: bool) -> bool {
        ffprobe::detect_black_screen(url, seconds, hls).await
    }
    async fn measure_bitrate(&self, url: &str, seconds: i64, hls: bool) -> Option<i64> {
        ffprobe::measure_bitrate(url, seconds, hls).await
    }
}

/// What a probe run needs: the database and the tools that read streams.
#[derive(Clone)]
pub struct Prober {
    pub db: Db,
    pub tools: Arc<dyn Tools>,
}

impl Prober {
    pub fn new(db: &Db) -> Prober {
        Prober { db: db.clone(), tools: Arc::new(Ffmpeg) }
    }
}

/// A channel to probe. The provider's category goes into failure logs, since
/// that's what you quote when reporting a dead stream.
#[derive(Debug, Clone)]
pub struct Target {
    pub source_id: i64,
    pub id: i64,
    pub stream_id: String,
    pub name: String,
    pub category_name: Option<String>,
}

fn target_from_row(r: &rusqlite::Row) -> rusqlite::Result<Target> {
    Ok(Target { source_id: r.get(0)?, id: r.get(1)?, stream_id: r.get(2)?, name: r.get(3)?, category_name: r.get(4)? })
}

/// The source channels worth probing on a schedule: used by an enabled
/// playlist channel, still available, and not in a disabled category. That's
/// what ends up in output, plus auto-disabled channels so a stream that comes
/// back gets noticed. A channel in several playlists is listed once.
pub fn channels_to_probe(conn: &Connection, source_id: i64) -> Result<Vec<Target>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT sc.source_id, sc.id, sc.stream_id, sc.name, sc.category_name FROM source_channels sc \
         JOIN playlist_channels pc ON pc.source_channel_id = sc.id \
         LEFT JOIN source_categories cat ON cat.source_id = sc.source_id AND cat.name = sc.category_name \
         WHERE sc.source_id = ? AND sc.available = 1 \
           AND (pc.enabled = 1 OR pc.auto_disabled_at IS NOT NULL) \
           AND (cat.id IS NULL OR cat.enabled = 1) ORDER BY sc.id",
    )?;
    Ok(stmt.query_map([source_id], target_from_row)?.collect::<rusqlite::Result<_>>()?)
}

fn quality_summary(r: &ProbeResult, bitrate: Option<i64>) -> String {
    let q = &r.quality;
    let resolution = match (q.width, q.height) {
        (_, Some(h)) if h > 0 => Some(if h >= 4320 {
            "8K".to_string()
        } else if h >= 2160 {
            "4K".to_string()
        } else {
            h.to_string()
        }),
        (Some(w), _) if w > 0 => Some(format!("{w}w")),
        _ => None,
    };
    let fps = q.fps.filter(|f| *f > 0.0).map(|f| format!("{}fps", (f * 100.0).round() / 100.0));
    let bitrate = bitrate.filter(|b| *b > 0).map(|b| {
        if b >= 1000 { format!("{:.1} Mbps", b as f64 / 1000.0) } else { format!("{b} kbps") }
    });
    [resolution, fps, q.video_codec.clone(), q.audio_codec.clone(), bitrate].into_iter().flatten().collect::<Vec<_>>().join(" · ")
}

impl Prober {
    /// Probe one channel and store the result on its source channel. Returns
    /// whether it passed. Every probe path goes through here.
    async fn probe_and_store(&self, source: &Source, ch: &Target) -> Result<bool> {
        let hls = source.output_format == "m3u8";
        let url = build_stream_url(&source.stream_creds(), &ch.stream_id, &source.output_format);
        let id = ch.id;

        // Show the row as probing the moment it starts, not when the run ends.
        self.db
            .call(move |conn| {
                conn.execute("UPDATE source_channels SET probe_status = 'probing' WHERE id = ?", [id])?;
                Ok(())
            })
            .await?;
        bump_source(source.id);

        let timeout = source.probe_timeout_seconds;
        let mut r = self.tools.probe_stream(&url, timeout, hls).await;
        let mut bitrate = r.quality.bitrate;
        if r.status == "ok" && source.probe_measure_bitrate {
            bitrate = self.tools.measure_bitrate(&url, timeout, hls).await.or(bitrate);
        }
        // ffprobe only reads stream metadata, so a valid video track with a black
        // picture still looks fine to it.
        if r.status == "ok" && source.probe_detect_black_screen && self.tools.detect_black_screen(&url, timeout, hls).await {
            r.status = "error";
            r.error = Some("Black screen".into());
        }

        if r.status == "ok" {
            println!("[probe] {}: \"{}\" ok: {}", source.name, ch.name, quality_summary(&r, bitrate));
        } else {
            let category = ch.category_name.as_deref().unwrap_or("Uncategorised");
            eprintln!(
                "[probe] {}: \"{}\" in \"{category}\" {}: {}",
                source.name,
                ch.name,
                r.status,
                r.error.as_deref().unwrap_or("")
            );
        }

        // Only keep measurements for a pass. A black screen arrives with a full
        // set of numbers, and anything that ranks quality would trust them.
        let ok = r.status == "ok";
        let q = if ok { r.quality.clone() } else { Default::default() };
        let bitrate = if ok { bitrate } else { None };
        let (status, error) = (r.status, r.error.clone());
        self.db
            .call(move |conn| {
                conn.execute(
                    "UPDATE source_channels SET probed_at = ?, probe_status = ?, probe_width = ?, probe_height = ?, \
                       probe_fps = ?, probe_video_codec = ?, probe_audio_codec = ?, probe_bitrate = ?, probe_error = ?, \
                       consecutive_probe_failures = CASE WHEN ? THEN 0 ELSE consecutive_probe_failures + 1 END \
                     WHERE id = ?",
                    params![now(), status, q.width, q.height, q.fps, q.video_codec, q.audio_codec, bitrate, error, ok, id],
                )?;
                Ok(())
            })
            .await?;
        Ok(ok)
    }

    /// Probe a fixed list of one source's channels, tracking progress on the
    /// source so the UI can show "42/300".
    async fn probe_channel_list(&self, source: Source, channels: Vec<Target>) -> Result<()> {
        let source_id = source.id;
        let ids: Vec<i64> = channels.iter().map(|c| c.id).collect();
        let total = channels.len() as i64;
        let queued = ids.clone();
        self.db
            .call(move |conn| {
                conn.execute(
                    "UPDATE sources SET probe_status = 'probing', probe_total = ?, probe_done = 0, probe_error = NULL WHERE id = ?",
                    params![total, source_id],
                )?;
                // Show the whole batch as waiting straight away; rows flip to
                // probing and then their result as the pool works through them.
                mark_queued(conn, &queued)
            })
            .await?;
        bump_source(source_id);
        println!("[probe] {}: probing {} channels, concurrency {}", source.name, total, source.probe_concurrency);

        let results = map_pool(channels, source.probe_concurrency.max(1) as usize, |ch| {
            let source = &source;
            async move {
                let ok = self.probe_and_store(source, &ch).await.unwrap_or(false);
                let _ = self
                    .db
                    .call(move |conn| {
                        conn.execute("UPDATE sources SET probe_done = probe_done + 1 WHERE id = ?", [source_id])?;
                        Ok(())
                    })
                    .await;
                bump_source(source_id);
                ok
            }
        })
        .await;
        let ok = results.iter().filter(|r| **r).count();
        println!("[probe] {}: done, {ok} ok, {} failed", source.name, results.len() - ok);

        // Switch off channels whose failure streak just crossed their playlist's
        // limit, and bring back auto-disabled ones that pass again, before the
        // final nudge so the editor shows it all at once.
        self.db
            .call(move |conn| {
                auto_disable_failed_channels(conn, &ids)?;
                revive_recovered_channels(conn, &ids)?;
                conn.execute(
                    "UPDATE sources SET probe_status = 'ok', last_probed_at = ?, probe_error = NULL WHERE id = ?",
                    params![now(), source_id],
                )?;
                Ok(())
            })
            .await?;
        bump_source(source_id);
        Ok(())
    }

    fn spawn_channel_list(&self, source: Source, channels: Vec<Target>) {
        let this = self.clone();
        tokio::spawn(async move {
            let source_id = source.id;
            if let Err(e) = this.probe_channel_list(source, channels).await {
                mark_error(&this.db, source_id, &e.to_string()).await;
            }
        });
    }

    /// Probe one source in the background: its channels used by any playlist,
    /// the same set the scheduler uses.
    pub async fn start_probe(&self, source_id: i64) {
        let _ = self
            .db
            .call(move |conn| {
                conn.execute(
                    "UPDATE sources SET probe_status = 'probing', probe_total = 0, probe_done = 0, probe_error = NULL WHERE id = ?",
                    [source_id],
                )?;
                Ok(())
            })
            .await;
        bump_source(source_id);
        let this = self.clone();
        tokio::spawn(async move {
            if let Err(e) = this.run_probe(source_id).await {
                mark_error(&this.db, source_id, &e.to_string()).await;
            }
        });
    }

    pub async fn run_probe(&self, source_id: i64) -> Result<()> {
        let found = self
            .db
            .call(move |conn| {
                let Some(source) = Source::by_id(conn, source_id)? else { return Ok(None) };
                Ok(Some((source, channels_to_probe(conn, source_id)?)))
            })
            .await?;
        match found {
            Some((source, channels)) => self.probe_channel_list(source, channels).await,
            None => Ok(()),
        }
    }

    /// Probe one channel now, whatever its filters or the source's probe
    /// setting. Waits for the result so the caller can reload afterwards.
    pub async fn probe_single_channel(&self, source_channel_id: i64) -> Result<()> {
        let found = self
            .db
            .call(move |conn| {
                let target = conn
                    .query_row(
                        "SELECT source_id, id, stream_id, name, category_name FROM source_channels WHERE id = ?",
                        [source_channel_id],
                        target_from_row,
                    )
                    .ok();
                let Some(target) = target else { return Ok(None) };
                Ok(Source::by_id(conn, target.source_id)?.map(|s| (s, target)))
            })
            .await?;
        let Some((source, target)) = found else { return Ok(()) };
        self.probe_and_store(&source, &target).await?;
        let id = target.id;
        self.db
            .call(move |conn| {
                auto_disable_failed_channels(conn, &[id])?;
                revive_recovered_channels(conn, &[id])
            })
            .await
    }

    /// Fan targets out across their sources, so each runs at its own
    /// concurrency. Returns how many were queued.
    pub async fn start_probe_targets(&self, targets: Vec<Target>) -> usize {
        let count = targets.len();
        let mut order: Vec<i64> = Vec::new();
        let mut by_source: HashMap<i64, Vec<Target>> = HashMap::new();
        for t in targets {
            if !by_source.contains_key(&t.source_id) {
                order.push(t.source_id);
            }
            by_source.entry(t.source_id).or_default().push(t);
        }
        for source_id in order {
            let Ok(Some(source)) = self.db.call(move |conn| Ok(Source::by_id(conn, source_id)?)).await else { continue };
            self.spawn_channel_list(source, by_source.remove(&source_id).unwrap_or_default());
        }
        count
    }

    pub async fn start_probe_playlist(&self, playlist_id: i64, filter: PlaylistFilter) -> Result<usize> {
        let targets = self.db.call(move |conn| playlist_probe_targets(conn, playlist_id, filter)).await?;
        Ok(self.start_probe_targets(targets).await)
    }

    /// Probe chosen source channels in the order given, skipping switched-off
    /// sources. Returns how many were queued.
    pub async fn start_probe_channels(&self, source_channel_ids: Vec<i64>) -> Result<usize> {
        let targets = self.db.call(move |conn| targets_by_id(conn, &source_channel_ids)).await?;
        Ok(self.start_probe_targets(targets).await)
    }

    /// Probe a whole alternate group, primary first. Its streams often come
    /// from different sources, so this fans out across them.
    pub async fn start_probe_group(&self, playlist_id: i64, primary_id: i64) -> Result<usize> {
        let ids: Vec<i64> = self
            .db
            .call(move |conn| {
                let mut stmt = conn.prepare(
                    "SELECT source_channel_id FROM playlist_channels WHERE playlist_id = ?1 \
                     AND (id = ?2 OR primary_channel_id = ?2) ORDER BY primary_channel_id, alt_position, id",
                )?;
                Ok(stmt.query_map(params![playlist_id, primary_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
            })
            .await?;
        self.start_probe_channels(ids).await
    }

    /// Probe streams just added to a playlist, so their quality shows up without
    /// waiting for the scheduled probe. Adds a few seconds apart share one run.
    pub async fn probe_added_channels(&self, source_channel_ids: Vec<i64>) -> Result<()> {
        let this = self.clone();
        self.queue_added(source_channel_ids, move |batch| async move {
            println!("[probe] probing {} newly added channel(s)", batch.len());
            this.start_probe_targets(batch).await;
        })
        .await
    }

    async fn queue_added<F, Fut>(&self, source_channel_ids: Vec<i64>, run: F) -> Result<()>
    where
        F: FnOnce(Vec<Target>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        if source_channel_ids.is_empty() {
            return Ok(());
        }
        let targets = self
            .db
            .call(move |conn| {
                let targets = channels_to_probe_on_add(conn, &source_channel_ids)?;
                // Mark them waiting before the delay. The editor only listens for
                // live results while something is probing, so rows still reading
                // as unprobed after the add would never update on their own.
                mark_queued(conn, &targets.iter().map(|t| t.id).collect::<Vec<_>>())?;
                Ok(targets)
            })
            .await?;
        if targets.is_empty() {
            return Ok(());
        }
        for source_id in targets.iter().map(|t| t.source_id).collect::<BTreeSet<_>>() {
            bump_source(source_id);
        }
        let mut pending = ADDED_PENDING.lock().unwrap_or_else(|e| e.into_inner());
        for t in targets {
            pending.insert(t.id, t);
        }
        drop(pending);
        ADDED_SOON.call(move || async move {
            let batch: Vec<Target> = ADDED_PENDING.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, t)| t).collect();
            if !batch.is_empty() {
                run(batch).await;
            }
        });
        Ok(())
    }

    /// Probe the sources whose interval has passed, one at a time.
    pub async fn probe_due_sources(&self) -> Result<()> {
        let sources = self.db.call(|conn| Ok(Source::all(conn)?)).await?;
        let t = now();
        let due: Vec<&Source> = sources
            .iter()
            .filter(|s| s.enabled && s.probe_enabled && is_interval_due(s.last_probed_at, s.probe_interval_minutes, t))
            .collect();
        println!("[probe] {} of {} sources due", due.len(), sources.len());
        for s in due {
            if let Err(e) = self.run_probe(s.id).await {
                mark_error(&self.db, s.id, &e.to_string()).await;
            }
        }
        Ok(())
    }
}

// Wait a moment before probing just-added streams, so adding channels one at a
// time still ends up as one probe run.
static ADDED_SOON: Debouncer = Debouncer::new(Duration::from_secs(3));
static ADDED_PENDING: LazyLock<Mutex<HashMap<i64, Target>>> = LazyLock::new(Default::default);

fn mark_queued(conn: &Connection, ids: &[i64]) -> Result<()> {
    for chunk in ids.chunks(ID_CHUNK) {
        conn.execute(
            &format!("UPDATE source_channels SET probe_status = 'queued' WHERE id IN ({})", placeholders(chunk.len())),
            params_from_iter(chunk),
        )?;
    }
    Ok(())
}

async fn mark_error(db: &Db, source_id: i64, message: &str) {
    let message = message.to_string();
    let _ = db
        .call(move |conn| {
            conn.execute(
                "UPDATE sources SET probe_status = 'error', probe_error = ? WHERE id = ?",
                params![message, source_id],
            )?;
            Ok(())
        })
        .await;
    bump_source(source_id);
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PlaylistFilter {
    pub category_id: Option<i64>,
    pub only: Option<Only>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Only {
    Missing,
    Failed,
    AutoDisabled,
}

/// Enabled channels placed in a playlist, in editor order, ignoring the
/// available and category filters so a manual probe covers everything the
/// editor shows. Switched-off sources are always left out: the user turned
/// that provider off, so its streams shouldn't be opened.
pub fn playlist_probe_targets(conn: &Connection, playlist_id: i64, filter: PlaylistFilter) -> Result<Vec<Target>> {
    let mut sql = String::from(
        "SELECT DISTINCT sc.source_id, sc.id, sc.stream_id, sc.name, sc.category_name, \
           cat.position, cat.id, pc.position, pc.id \
         FROM playlist_channels pc \
         JOIN source_channels sc ON pc.source_channel_id = sc.id \
         JOIN playlist_categories cat ON pc.category_id = cat.id \
         JOIN sources s ON sc.source_id = s.id \
         WHERE pc.playlist_id = ? AND s.enabled = 1",
    );
    let mut args: Vec<rusqlite::types::Value> = vec![playlist_id.into()];
    // Auto-disabled channels are switched off, so they're found by their marker.
    if filter.only == Some(Only::AutoDisabled) {
        sql.push_str(" AND pc.auto_disabled_at IS NOT NULL");
    } else {
        sql.push_str(" AND pc.enabled = 1");
    }
    if let Some(c) = filter.category_id {
        sql.push_str(" AND pc.category_id = ?");
        args.push(c.into());
    }
    match filter.only {
        Some(Only::Missing) => sql.push_str(" AND sc.probe_status IS NULL"),
        Some(Only::Failed) => sql.push_str(" AND sc.probe_status IN ('error', 'timeout')"),
        _ => {}
    }
    sql.push_str(" ORDER BY cat.position, cat.id, pc.position, pc.id");
    let mut stmt = conn.prepare(&sql)?;
    Ok(stmt.query_map(params_from_iter(args), target_from_row)?.collect::<rusqlite::Result<_>>()?)
}

fn targets_by_id(conn: &Connection, ids: &[i64]) -> Result<Vec<Target>> {
    let mut rows = Vec::new();
    for chunk in ids.chunks(ID_CHUNK) {
        let mut stmt = conn.prepare(&format!(
            "SELECT sc.source_id, sc.id, sc.stream_id, sc.name, sc.category_name FROM source_channels sc \
             JOIN sources s ON sc.source_id = s.id WHERE sc.id IN ({}) AND s.enabled = 1",
            placeholders(chunk.len())
        ))?;
        rows.extend(stmt.query_map(params_from_iter(chunk), target_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    // Put the rows back in the order they were asked for, so each source's
    // batch probes in that order.
    let order: HashMap<i64, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    rows.sort_by_key(|r| order.get(&r.id).copied().unwrap_or(0));
    Ok(rows)
}

/// Of the channels just added, those worth probing: their source is on with
/// probing switched on, the stream is available, and it has no result yet.
pub fn channels_to_probe_on_add(conn: &Connection, ids: &[i64]) -> Result<Vec<Target>> {
    let mut out = Vec::new();
    for chunk in ids.chunks(ID_CHUNK) {
        let mut stmt = conn.prepare(&format!(
            "SELECT sc.source_id, sc.id, sc.stream_id, sc.name, sc.category_name FROM source_channels sc \
             JOIN sources s ON s.id = sc.source_id WHERE sc.id IN ({}) AND s.enabled = 1 AND s.probe_enabled = 1 \
             AND sc.available = 1 AND sc.probe_status IS NULL",
            placeholders(chunk.len())
        ))?;
        out.extend(stmt.query_map(params_from_iter(chunk), target_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    Ok(out)
}

/// Wipe the probe results for every channel in a playlist so they read as
/// unprobed. Results live on the shared source channel, so this clears them
/// for any other playlist using the same stream too.
pub fn clear_playlist_probes(conn: &Connection, playlist_id: i64) -> Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT sc.id, sc.source_id FROM playlist_channels pc \
         JOIN source_channels sc ON pc.source_channel_id = sc.id WHERE pc.playlist_id = ?",
    )?;
    let rows: Vec<(i64, i64)> = stmt.query_map([playlist_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    let ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
    for chunk in ids.chunks(ID_CHUNK) {
        conn.execute(
            &format!(
                "UPDATE source_channels SET probe_status = NULL, probed_at = NULL, probe_width = NULL, \
                   probe_height = NULL, probe_fps = NULL, probe_video_codec = NULL, probe_audio_codec = NULL, \
                   probe_bitrate = NULL, probe_error = NULL WHERE id IN ({})",
                placeholders(chunk.len())
            ),
            params_from_iter(chunk),
        )?;
    }
    for source_id in rows.iter().map(|r| r.1).collect::<BTreeSet<_>>() {
        bump_source(source_id);
    }
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playlist::mutations::add_channels;
    use crate::test_support;

    struct Fake {
        result: ProbeResult,
        black: bool,
    }

    #[async_trait]
    impl Tools for Fake {
        async fn probe_stream(&self, _: &str, _: i64, _: bool) -> ProbeResult {
            self.result.clone()
        }
        async fn detect_black_screen(&self, _: &str, _: i64, _: bool) -> bool {
            self.black
        }
        async fn measure_bitrate(&self, _: &str, _: i64, _: bool) -> Option<i64> {
            None
        }
    }

    struct Setup {
        db: Db,
        source: i64,
        playlist: i64,
        category: i64,
    }

    fn setup() -> Setup {
        let db = test_support::db();
        let (source, playlist, category) = {
            let conn = db.lock();
            let source = test_support::source(&conn, "Main");
            let playlist = test_support::playlist(&conn, "PL", "tok");
            let category = test_support::category(&conn, playlist, "UK", 0);
            (source, playlist, category)
        };
        Setup { db, source, playlist, category }
    }

    fn add_sc(s: &Setup, stream: &str, category: &str, available: bool) -> i64 {
        let conn = s.db.lock();
        let id = test_support::source_channel(&conn, s.source, stream, &format!("Channel {stream}"), category);
        conn.execute("UPDATE source_channels SET available = ? WHERE id = ?", params![available, id]).unwrap();
        id
    }

    fn streams(t: &[Target]) -> Vec<&str> {
        t.iter().map(|t| t.stream_id.as_str()).collect()
    }

    #[test]
    fn scheduled_probe_targets() {
        let s = setup();
        let used = add_sc(&s, "used", "UK", true);
        add_sc(&s, "unused", "UK", true);
        let conn = s.db.lock();
        add_channels(&conn, s.playlist, s.category, &[used], None).unwrap();
        assert_eq!(streams(&channels_to_probe(&conn, s.source).unwrap()), ["used"]);

        // A channel in two playlists is probed once.
        let pl2 = test_support::playlist(&conn, "PL2", "tok2");
        let cat2 = test_support::category(&conn, pl2, "UK", 0);
        add_channels(&conn, pl2, cat2, &[used], None).unwrap();
        assert_eq!(channels_to_probe(&conn, s.source).unwrap().len(), 1);
    }

    #[test]
    fn scheduled_probe_skips_unavailable_disabled_and_hidden_categories() {
        let s = setup();
        let gone = add_sc(&s, "gone", "UK", false);
        let off = add_sc(&s, "off", "UK", true);
        let dead = add_sc(&s, "dead", "UK", true);
        let adult = add_sc(&s, "adult", "Adult", true);
        let conn = s.db.lock();
        add_channels(&conn, s.playlist, s.category, &[gone, off, dead, adult], None).unwrap();
        conn.execute("UPDATE playlist_channels SET enabled = 0 WHERE source_channel_id = ?", [off]).unwrap();
        conn.execute("UPDATE playlist_channels SET enabled = 0, auto_disabled_at = 1 WHERE source_channel_id = ?", [dead]).unwrap();
        conn.execute("INSERT INTO source_categories (source_id, name, enabled) VALUES (?, 'Adult', 0)", [s.source]).unwrap();
        // Auto-disabled channels stay in, so they can recover.
        assert_eq!(streams(&channels_to_probe(&conn, s.source).unwrap()), ["dead"]);
    }

    #[test]
    fn probe_on_add_targets() {
        let s = setup();
        let one = add_sc(&s, "one", "UK", true);
        let gone = add_sc(&s, "gone", "UK", false);
        let conn = s.db.lock();
        assert!(channels_to_probe_on_add(&conn, &[one]).unwrap().is_empty());
        conn.execute("UPDATE sources SET probe_enabled = 1", []).unwrap();
        assert_eq!(streams(&channels_to_probe_on_add(&conn, &[one, gone]).unwrap()), ["one"]);
        conn.execute("UPDATE source_channels SET probe_status = 'ok' WHERE id = ?", [one]).unwrap();
        assert!(channels_to_probe_on_add(&conn, &[one]).unwrap().is_empty());
        conn.execute("UPDATE source_channels SET probe_status = NULL", []).unwrap();
        conn.execute("UPDATE sources SET enabled = 0", []).unwrap();
        assert!(channels_to_probe_on_add(&conn, &[one]).unwrap().is_empty());
    }

    #[tokio::test]
    async fn menu_probes_skip_a_switched_off_source() {
        let s = setup();
        let a = add_sc(&s, "a", "UK", true);
        {
            let conn = s.db.lock();
            add_channels(&conn, s.playlist, s.category, &[a], None).unwrap();
            conn.execute("UPDATE playlist_channels SET enabled = 0, auto_disabled_at = 1", []).unwrap();
            conn.execute("UPDATE sources SET enabled = 0", []).unwrap();
        }
        let p = Prober::new(&s.db);
        let auto = PlaylistFilter { only: Some(Only::AutoDisabled), ..Default::default() };
        assert_eq!(p.start_probe_playlist(s.playlist, auto).await.unwrap(), 0);
        assert_eq!(p.start_probe_playlist(s.playlist, PlaylistFilter::default()).await.unwrap(), 0);
        assert_eq!(p.start_probe_channels(vec![a]).await.unwrap(), 0);
        let status: Option<String> =
            s.db.lock().query_row("SELECT probe_status FROM source_channels WHERE id = ?", [a], |r| r.get(0)).unwrap();
        assert_eq!(status, None);
    }

    #[tokio::test(start_paused = true)]
    async fn added_channels_are_queued_then_probed_in_one_run() {
        let s = setup();
        s.db.lock().execute("UPDATE sources SET probe_enabled = 1", []).unwrap();
        let a = add_sc(&s, "a", "UK", true);
        let b = add_sc(&s, "b", "UK", true);
        let p = Prober::new(&s.db);
        let runs = Arc::new(Mutex::new(Vec::new()));
        for id in [a, b] {
            let runs = runs.clone();
            p.queue_added(vec![id], move |batch| async move { runs.lock().unwrap().push(batch) }).await.unwrap();
        }
        let status: String =
            s.db.lock().query_row("SELECT probe_status FROM source_channels WHERE id = ?", [a], |r| r.get(0)).unwrap();
        assert_eq!(status, "queued");

        tokio::time::sleep(Duration::from_secs(10)).await;
        for _ in 0..3 {
            tokio::task::yield_now().await;
        }
        let runs = runs.lock().unwrap();
        assert_eq!(runs.len(), 1);
        let mut got: Vec<_> = streams(&runs[0]).into_iter().map(String::from).collect();
        got.sort();
        assert_eq!(got, ["a", "b"]);
    }

    fn passing() -> ProbeResult {
        ProbeResult {
            status: "ok",
            quality: ffprobe::Quality {
                width: Some(3840),
                height: Some(2160),
                fps: Some(50.0),
                video_codec: Some("hevc".into()),
                audio_codec: Some("eac3".into()),
                bitrate: Some(20000),
            },
            error: None,
        }
    }

    #[tokio::test]
    async fn black_screen_keeps_no_quality() {
        let s = setup();
        let id = add_sc(&s, "black", "UK", true);
        let p = Prober { db: s.db.clone(), tools: Arc::new(Fake { result: passing(), black: true }) };
        p.probe_single_channel(id).await.unwrap();
        let row: (String, String, Option<i64>, Option<i64>, Option<f64>, Option<String>, Option<i64>) = s
            .db
            .lock()
            .query_row(
                "SELECT probe_status, probe_error, probe_height, probe_width, probe_fps, probe_video_codec, probe_bitrate \
                 FROM source_channels WHERE id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .unwrap();
        assert_eq!(row, ("error".into(), "Black screen".into(), None, None, None, None, None));
    }

    #[tokio::test]
    async fn passing_probe_stores_quality() {
        let s = setup();
        let id = add_sc(&s, "good", "UK", true);
        let p = Prober { db: s.db.clone(), tools: Arc::new(Fake { result: passing(), black: false }) };
        p.probe_single_channel(id).await.unwrap();
        let (status, height, failures): (String, i64, i64) = s
            .db
            .lock()
            .query_row(
                "SELECT probe_status, probe_height, consecutive_probe_failures FROM source_channels WHERE id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((status.as_str(), height, failures), ("ok", 2160, 0));
    }
}
