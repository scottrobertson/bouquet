//! The job runner. Every background task (sync, probe, upload, backup) is
//! queued here, so there's one place that knows what's waiting and running,
//! and open tabs can follow along live. Jobs for the same source run one at a
//! time, so a probe never competes with a sync for the provider's connections,
//! while different sources run side by side.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::db::Db;
use crate::events::send_job;
use crate::pool::now;
use crate::probe::Prober;
use crate::routes::api::{iso, iso_opt, kinds};

/// What a job does. Stored as the job's params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Work {
    Sync {
        source_id: i64,
    },
    /// Without a channel list it probes what the scheduled probe covers. The
    /// playlist is only there so the job can link back to the editor.
    Probe {
        source_id: i64,
        channels: Option<Vec<i64>>,
        playlist_id: Option<i64>,
    },
    Upload {
        destination_id: i64,
    },
    /// Scheduled backups are pruned to the newest few, manual ones are kept.
    Backup {
        manual: bool,
    },
    #[cfg(test)]
    Test {
        key: i64,
        millis: u64,
        fail: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Lock {
    Source(i64),
    Destination(i64),
    Free,
}

impl Work {
    pub fn kind(&self) -> &'static str {
        match self {
            Work::Sync { .. } => "sync",
            Work::Probe { .. } => "probe",
            Work::Upload { .. } => "upload",
            Work::Backup { .. } => "backup",
            #[cfg(test)]
            Work::Test { .. } => "test",
        }
    }

    fn lock(&self) -> Lock {
        match self {
            Work::Sync { source_id } | Work::Probe { source_id, .. } => Lock::Source(*source_id),
            Work::Upload { destination_id } => Lock::Destination(*destination_id),
            Work::Backup { .. } => Lock::Free,
            #[cfg(test)]
            Work::Test { key, .. } => Lock::Source(*key),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Trigger {
    Manual,
    Scheduled,
    Automatic,
}

impl Trigger {
    fn as_str(self) -> &'static str {
        match self {
            Trigger::Manual => "manual",
            Trigger::Scheduled => "scheduled",
            Trigger::Automatic => "automatic",
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JobView {
    pub id: i64,
    #[ts(as = "kinds::JobKind")]
    pub kind: String,
    #[ts(as = "kinds::JobTrigger")]
    pub trigger: String,
    #[ts(as = "kinds::JobStatus")]
    pub status: String,
    pub title: String,
    pub source_id: Option<i64>,
    pub playlist_id: Option<i64>,
    pub destination_id: Option<i64>,
    pub step: Option<String>,
    pub done: Option<i64>,
    pub total: Option<i64>,
    pub summary: Option<String>,
    pub error: Option<String>,
    // Log lines at warn or error level.
    pub warnings: i64,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

impl JobView {
    pub fn is_active(&self) -> bool {
        self.status == "queued" || self.status == "running"
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JobLogLine {
    pub at: String,
    #[ts(as = "kinds::JobLogLevel")]
    pub level: String,
    pub message: String,
}

const VIEW_COLUMNS: &str = "id, kind, trigger, status, title, source_id, playlist_id, destination_id, step, done, total, \
    summary, error, (SELECT count(*) FROM job_logs l WHERE l.job_id = jobs.id AND l.level != 'info'), \
    created_at, started_at, finished_at";

fn view_from_row(r: &rusqlite::Row) -> rusqlite::Result<JobView> {
    Ok(JobView {
        id: r.get(0)?,
        kind: r.get(1)?,
        trigger: r.get(2)?,
        status: r.get(3)?,
        title: r.get(4)?,
        source_id: r.get(5)?,
        playlist_id: r.get(6)?,
        destination_id: r.get(7)?,
        step: r.get(8)?,
        done: r.get(9)?,
        total: r.get(10)?,
        summary: r.get(11)?,
        error: r.get(12)?,
        warnings: r.get(13)?,
        created_at: iso(r.get(14)?),
        started_at: iso_opt(r.get(15)?),
        finished_at: iso_opt(r.get(16)?),
    })
}

pub fn job_by_id(conn: &Connection, id: i64) -> Result<Option<JobView>> {
    Ok(conn.query_row(&format!("SELECT {VIEW_COLUMNS} FROM jobs WHERE id = ?"), [id], view_from_row).optional()?)
}

/// Queued and running jobs, oldest first, so the list reads in the order
/// they'll finish.
pub fn active_jobs(conn: &Connection) -> Result<Vec<JobView>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {VIEW_COLUMNS} FROM jobs WHERE status IN ('queued', 'running') ORDER BY id"
    ))?;
    Ok(stmt.query_map([], view_from_row)?.collect::<rusqlite::Result<_>>()?)
}

/// Finished jobs, newest first.
pub fn finished_jobs(conn: &Connection, limit: i64) -> Result<Vec<JobView>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {VIEW_COLUMNS} FROM jobs WHERE status NOT IN ('queued', 'running') ORDER BY id DESC LIMIT ?"
    ))?;
    Ok(stmt.query_map([limit], view_from_row)?.collect::<rusqlite::Result<_>>()?)
}

pub fn job_logs(conn: &Connection, id: i64) -> Result<Vec<JobLogLine>> {
    let mut stmt = conn.prepare("SELECT at, level, message FROM job_logs WHERE job_id = ? ORDER BY id")?;
    Ok(stmt
        .query_map([id], |r| Ok(JobLogLine { at: iso(r.get(0)?), level: r.get(1)?, message: r.get(2)? }))?
        .collect::<rusqlite::Result<_>>()?)
}

/// Each source's queued and running jobs, for pages that show a source's
/// status.
pub fn active_by_source(conn: &Connection) -> Result<HashMap<i64, Vec<JobView>>> {
    let mut out: HashMap<i64, Vec<JobView>> = HashMap::new();
    for job in active_jobs(conn)? {
        if let Some(id) = job.source_id {
            out.entry(id).or_default().push(job);
        }
    }
    Ok(out)
}

/// A source's sync or probe status as pages show it: the running word while a
/// job runs, "queued" while one waits, otherwise the last result.
pub fn live_status(active: &[JobView], kind: &str, running: &str, last: &str) -> String {
    let jobs: Vec<&JobView> = active.iter().filter(|j| j.kind == kind).collect();
    if jobs.iter().any(|j| j.status == "running") {
        running.to_string()
    } else if !jobs.is_empty() {
        "queued".to_string()
    } else {
        last.to_string()
    }
}

/// The running probe's progress, for the "42/300" on source pages.
pub fn probe_progress(active: &[JobView]) -> (i64, i64) {
    active
        .iter()
        .find(|j| j.kind == "probe" && j.status == "running")
        .map(|j| (j.done.unwrap_or(0), j.total.unwrap_or(0)))
        .unwrap_or((0, 0))
}

struct Described {
    title: String,
    source_id: Option<i64>,
    playlist_id: Option<i64>,
    destination_id: Option<i64>,
    total: Option<i64>,
}

fn describe(conn: &Connection, work: &Work) -> Result<Described> {
    let source_name = |id: i64| -> Result<String> {
        Ok(conn
            .query_row("SELECT name FROM sources WHERE id = ?", [id], |r| r.get(0))
            .optional()?
            .unwrap_or_else(|| "a deleted source".to_string()))
    };
    let plain = |title: String| Described { title, source_id: None, playlist_id: None, destination_id: None, total: None };
    Ok(match work {
        Work::Sync { source_id } => Described { source_id: Some(*source_id), ..plain(format!("Sync {}", source_name(*source_id)?)) },
        Work::Probe { source_id, channels, playlist_id } => {
            let source = source_name(*source_id)?;
            let title = match channels.as_deref() {
                None => format!("Probe {source}"),
                Some([one]) => {
                    let name: Option<String> =
                        conn.query_row("SELECT name FROM source_channels WHERE id = ?", [one], |r| r.get(0)).optional()?;
                    format!("Probe {} on {source}", name.unwrap_or_else(|| "1 channel".into()))
                }
                Some(ids) => format!("Probe {} channels on {source}", ids.len()),
            };
            Described {
                source_id: Some(*source_id),
                playlist_id: *playlist_id,
                total: channels.as_ref().map(|c| c.len() as i64),
                ..plain(title)
            }
        }
        Work::Upload { destination_id } => {
            let found: Option<(String, i64, String)> = conn
                .query_row(
                    "SELECT d.name, d.playlist_id, p.name FROM upload_destinations d JOIN playlists p ON p.id = d.playlist_id \
                     WHERE d.id = ?",
                    [destination_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            match found {
                Some((dest, playlist_id, playlist)) => Described {
                    playlist_id: Some(playlist_id),
                    destination_id: Some(*destination_id),
                    ..plain(format!("Upload {playlist} to {dest}"))
                },
                None => plain("Upload to a deleted destination".into()),
            }
        }
        Work::Backup { .. } => plain("Back up the database".into()),
        #[cfg(test)]
        Work::Test { key, .. } => plain(format!("Test {key}")),
    })
}

fn insert_job(conn: &Connection, work: &Work, trigger: Trigger) -> Result<JobView> {
    let d = describe(conn, work)?;
    conn.execute(
        "INSERT INTO jobs (kind, trigger, title, source_id, playlist_id, destination_id, params, total, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            work.kind(),
            trigger.as_str(),
            d.title,
            d.source_id,
            d.playlist_id,
            d.destination_id,
            serde_json::to_string(work)?,
            d.total,
            now()
        ],
    )?;
    job_by_id(conn, conn.last_insert_rowid())?.ok_or_else(|| anyhow!("job vanished"))
}

// Finished jobs are kept this long, and never more than KEEP_MAX of them, so
// automatic probes after every edit don't pile up forever.
const KEEP_DAYS: i64 = 14;
const KEEP_MAX: i64 = 1000;

fn prune(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM jobs WHERE status NOT IN ('queued', 'running') \
           AND (finished_at < ? OR id NOT IN (SELECT id FROM jobs ORDER BY id DESC LIMIT ?))",
        params![now() - KEEP_DAYS * 86_400, KEEP_MAX],
    )?;
    Ok(())
}

#[derive(Default)]
struct State {
    queue: Vec<(i64, Work)>,
    running: HashMap<i64, Work>,
    // Set while a restore replaces the database, so nothing new starts.
    paused: bool,
}

#[derive(Clone)]
pub struct Jobs(Arc<Inner>);

struct Inner {
    prober: Prober,
    state: Mutex<State>,
}

impl Jobs {
    pub fn new(db: &Db) -> Jobs {
        Jobs::with_prober(Prober::new(db))
    }

    pub fn with_prober(prober: Prober) -> Jobs {
        Jobs(Arc::new(Inner { prober, state: Mutex::new(State::default()) }))
    }

    pub fn db(&self) -> &Db {
        &self.0.prober.db
    }

    pub fn prober(&self) -> &Prober {
        &self.0.prober
    }

    /// Queue a job and start it as soon as its source is free. Asking for
    /// something that's already waiting returns that job instead of adding a
    /// second one.
    pub async fn enqueue(&self, work: Work, trigger: Trigger) -> Result<i64> {
        let mut state = self.0.state.lock().await;
        if let Some(id) = self.join_existing(&mut state, &work).await? {
            return Ok(id);
        }
        let w = work.clone();
        let view = self.db().call(move |conn| insert_job(conn, &w, trigger)).await?;
        let id = view.id;
        println!("[jobs] #{id} queued: {}", view.title);
        send_job(view);
        state.queue.push((id, work));
        self.pump(&mut state);
        Ok(id)
    }

    async fn join_existing(&self, state: &mut State, work: &Work) -> Result<Option<i64>> {
        let queued = state.queue.iter_mut().find(|(_, w)| w.kind() == work.kind() && w.lock() == work.lock());
        match (work, queued) {
            // Probing a list of channels while another list waits for the same
            // source folds the new channels into the waiting job.
            (
                Work::Probe { channels: Some(new), .. },
                Some((id, Work::Probe { source_id, channels: Some(existing), playlist_id })),
            ) => {
                let seen: HashSet<i64> = existing.iter().copied().collect();
                existing.extend(new.iter().filter(|c| !seen.contains(c)));
                let id = *id;
                let merged =
                    Work::Probe { source_id: *source_id, channels: Some(existing.clone()), playlist_id: *playlist_id };
                let view = self
                    .db()
                    .call(move |conn| {
                        let d = describe(conn, &merged)?;
                        conn.execute(
                            "UPDATE jobs SET title = ?, total = ?, params = ? WHERE id = ?",
                            params![d.title, d.total, serde_json::to_string(&merged)?, id],
                        )?;
                        job_by_id(conn, id)
                    })
                    .await?;
                if let Some(view) = view {
                    send_job(view);
                }
                Ok(Some(id))
            }
            (_, Some((id, existing))) if *existing == *work => Ok(Some(*id)),
            // A sync or full probe that's already running covers this request
            // too. An upload doesn't, since what it uploads may have changed
            // since it started.
            (Work::Sync { .. } | Work::Probe { channels: None, .. }, _) => {
                Ok(state.running.iter().find(|(_, w)| **w == *work).map(|(id, _)| *id))
            }
            _ => Ok(None),
        }
    }

    /// Start every queued job whose source is free, oldest first.
    fn pump(&self, state: &mut State) {
        if state.paused {
            return;
        }
        let mut taken: HashSet<Lock> = state.running.values().map(Work::lock).collect();
        let mut i = 0;
        while i < state.queue.len() {
            let lock = state.queue[i].1.lock();
            if lock != Lock::Free && !taken.insert(lock) {
                i += 1;
                continue;
            }
            let (id, work) = state.queue.remove(i);
            state.running.insert(id, work.clone());
            self.spawn(id, work);
        }
    }

    fn spawn(&self, id: i64, work: Work) {
        let jobs = self.clone();
        tokio::spawn(async move {
            let ctx = JobCtx::start(&jobs, id).await;
            let outcome = match ctx {
                Ok(ctx) => {
                    let run = {
                        let (jobs, ctx) = (jobs.clone(), ctx.clone());
                        tokio::spawn(async move { jobs.run(work, &ctx).await })
                    };
                    // Run it as its own task so a panic fails the job rather
                    // than leaving it running forever.
                    let outcome = run.await.unwrap_or_else(|_| Err(anyhow!("The job crashed")));
                    Some((ctx, outcome))
                }
                Err(e) => {
                    eprintln!("[jobs] #{id} could not start: {e:#}");
                    None
                }
            };
            if let Some((ctx, outcome)) = outcome {
                jobs.finish(id, &ctx, outcome).await;
            }
            let mut state = jobs.0.state.lock().await;
            state.running.remove(&id);
            jobs.pump(&mut state);
        });
    }

    async fn run(&self, work: Work, ctx: &JobCtx) -> Result<()> {
        match work {
            Work::Sync { source_id } => crate::sync::run_sync(self.db(), source_id, ctx).await,
            Work::Probe { source_id, channels, .. } => self.prober().run_probe(source_id, channels, ctx).await,
            Work::Upload { destination_id } => crate::upload::upload_destination(self.db(), destination_id, ctx).await,
            Work::Backup { manual } => crate::backup::run_backup(manual, ctx).await,
            #[cfg(test)]
            Work::Test { millis, fail, .. } => {
                ctx.step("Working").await;
                tokio::time::sleep(Duration::from_millis(millis)).await;
                if fail {
                    bail!("it broke");
                }
                ctx.summary("all good");
                Ok(())
            }
        }
    }

    async fn finish(&self, id: i64, ctx: &JobCtx, outcome: Result<()>) {
        let (status, error) = match &outcome {
            Ok(()) => ("succeeded", None),
            Err(e) => ("failed", Some(format!("{e:#}"))),
        };
        if let Some(e) = &error {
            ctx.log("error", e).await;
        }
        let summary = ctx.0.as_ref().and_then(|c| c.view.lock().unwrap_or_else(|e| e.into_inner()).summary.clone());
        let view = self
            .db()
            .call(move |conn| {
                conn.execute(
                    "UPDATE jobs SET status = ?, error = ?, summary = ?, finished_at = ? WHERE id = ?",
                    params![status, error, summary, now(), id],
                )?;
                prune(conn)?;
                job_by_id(conn, id)
            })
            .await;
        match view {
            Ok(Some(view)) => {
                println!("[jobs] #{id} {status}: {}", view.title);
                send_job(view);
            }
            Ok(None) => {}
            Err(e) => eprintln!("[jobs] #{id} could not be closed off: {e:#}"),
        }
    }

    /// Run something that needs the database to itself, like a restore. Refuses
    /// while any job is queued or running, and holds new jobs back until done.
    pub async fn run_exclusive<R, F, Fut>(&self, f: F) -> Result<R>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<R>>,
    {
        {
            let mut state = self.0.state.lock().await;
            if !state.running.is_empty() || !state.queue.is_empty() {
                bail!("Wait for the running jobs to finish first");
            }
            state.paused = true;
        }
        let result = f().await;
        let mut state = self.0.state.lock().await;
        state.paused = false;
        self.pump(&mut state);
        result
    }
}

// How often a job's progress goes out to the database and open tabs. Probes
// and guide fetches can tick many times a second.
const PROGRESS_EVERY: Duration = Duration::from_millis(300);

/// What a running job uses to report its step, progress and log. A detached
/// one only prints, for code run outside the queue like tests.
#[derive(Clone)]
pub struct JobCtx(Option<Arc<CtxInner>>);

struct CtxInner {
    jobs: Jobs,
    view: StdMutex<JobView>,
    flushed_at: StdMutex<Option<Instant>>,
}

impl JobCtx {
    pub fn detached() -> JobCtx {
        JobCtx(None)
    }

    async fn start(jobs: &Jobs, id: i64) -> Result<JobCtx> {
        let view = jobs
            .db()
            .call(move |conn| {
                conn.execute("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?", params![now(), id])?;
                job_by_id(conn, id)
            })
            .await?
            .ok_or_else(|| anyhow!("job {id} not found"))?;
        println!("[jobs] #{id} started: {}", view.title);
        send_job(view.clone());
        Ok(JobCtx(Some(Arc::new(CtxInner { jobs: jobs.clone(), view: StdMutex::new(view), flushed_at: StdMutex::new(None) }))))
    }

    /// The queue this job runs on, for starting follow on jobs.
    pub fn jobs(&self) -> Option<&Jobs> {
        self.0.as_ref().map(|c| &c.jobs)
    }

    fn update(&self, f: impl FnOnce(&mut JobView)) {
        if let Some(c) = &self.0 {
            f(&mut c.view.lock().unwrap_or_else(|e| e.into_inner()));
        }
    }

    async fn flush(&self, force: bool) {
        let Some(c) = &self.0 else { return };
        let view = {
            let mut at = c.flushed_at.lock().unwrap_or_else(|e| e.into_inner());
            if !force && at.is_some_and(|t| t.elapsed() < PROGRESS_EVERY) {
                return;
            }
            *at = Some(Instant::now());
            c.view.lock().unwrap_or_else(|e| e.into_inner()).clone()
        };
        let (id, step, done, total) = (view.id, view.step.clone(), view.done, view.total);
        let _ = c
            .jobs
            .db()
            .call(move |conn| {
                conn.execute("UPDATE jobs SET step = ?, done = ?, total = ? WHERE id = ?", params![step, done, total, id])?;
                Ok(())
            })
            .await;
        send_job(view);
    }

    /// Move on to a new stage, like "Fetching guide". Clears the progress count.
    pub async fn step(&self, step: &str) {
        self.update(|v| {
            v.step = Some(step.to_string());
            v.done = None;
            v.total = None;
        });
        self.flush(true).await;
    }

    pub async fn set_total(&self, total: i64) {
        self.update(|v| {
            v.done = Some(0);
            v.total = Some(total);
        });
        self.flush(true).await;
    }

    /// One more item done out of the total.
    pub async fn tick(&self) {
        let mut last = false;
        self.update(|v| {
            let done = v.done.unwrap_or(0) + 1;
            v.done = Some(done);
            last = v.total.is_some_and(|t| done >= t);
        });
        self.flush(last).await;
    }

    /// The one line result shown once the job succeeds.
    pub fn summary(&self, summary: impl Into<String>) {
        let summary = summary.into();
        println!("{} {summary}", self.prefix());
        self.update(|v| v.summary = Some(summary));
    }

    pub async fn info(&self, message: impl AsRef<str>) {
        self.log("info", message.as_ref()).await;
    }

    pub async fn warn(&self, message: impl AsRef<str>) {
        self.log("warn", message.as_ref()).await;
    }

    fn prefix(&self) -> String {
        match &self.0 {
            Some(c) => {
                let v = c.view.lock().unwrap_or_else(|e| e.into_inner());
                format!("[{} #{}]", v.kind, v.id)
            }
            None => "[job]".to_string(),
        }
    }

    async fn log(&self, level: &'static str, message: &str) {
        if level == "info" {
            println!("{} {message}", self.prefix());
        } else {
            eprintln!("{} {message}", self.prefix());
        }
        let Some(c) = &self.0 else { return };
        if level != "info" {
            self.update(|v| v.warnings += 1);
        }
        let id = c.view.lock().unwrap_or_else(|e| e.into_inner()).id;
        let message = message.to_string();
        let _ = c
            .jobs
            .db()
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO job_logs (job_id, at, level, message) VALUES (?, ?, ?, ?)",
                    params![id, now(), level, message],
                )?;
                Ok(())
            })
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;

    fn jobs() -> Jobs {
        Jobs::new(&test_support::db())
    }

    fn test(key: i64, millis: u64) -> Work {
        Work::Test { key, millis, fail: false }
    }

    fn status(jobs: &Jobs, id: i64) -> String {
        job_by_id(&jobs.db().lock(), id).unwrap().unwrap().status
    }

    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn runs_a_job_and_records_the_result() {
        let jobs = jobs();
        let id = jobs.enqueue(test(1, 0), Trigger::Manual).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let job = job_by_id(&jobs.db().lock(), id).unwrap().unwrap();
        assert_eq!(job.status, "succeeded");
        assert_eq!(job.summary.as_deref(), Some("all good"));
        assert_eq!(job.trigger, "manual");
        assert!(job.started_at.is_some() && job.finished_at.is_some());
    }

    #[tokio::test]
    async fn a_failure_is_recorded_with_its_error_and_log_line() {
        let jobs = jobs();
        let id = jobs.enqueue(Work::Test { key: 1, millis: 0, fail: true }, Trigger::Scheduled).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let job = job_by_id(&jobs.db().lock(), id).unwrap().unwrap();
        assert_eq!((job.status.as_str(), job.error.as_deref(), job.warnings), ("failed", Some("it broke"), 1));
        let logs = job_logs(&jobs.db().lock(), id).unwrap();
        assert_eq!(logs.last().map(|l| l.level.as_str()), Some("error"));
    }

    #[tokio::test]
    async fn jobs_on_the_same_source_wait_their_turn() {
        let jobs = jobs();
        let first = jobs.enqueue(test(1, 300), Trigger::Manual).await.unwrap();
        let second = jobs.enqueue(Work::Test { key: 1, millis: 0, fail: true }, Trigger::Manual).await.unwrap();
        let other = jobs.enqueue(test(2, 300), Trigger::Manual).await.unwrap();
        settle().await;
        assert_eq!(status(&jobs, first), "running");
        assert_eq!(status(&jobs, second), "queued");
        assert_eq!(status(&jobs, other), "running");
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(status(&jobs, second), "failed");
    }

    #[tokio::test]
    async fn the_same_job_twice_is_only_queued_once() {
        let jobs = jobs();
        let blocker = jobs.enqueue(test(1, 300), Trigger::Manual).await.unwrap();
        let a = jobs.enqueue(test(1, 0), Trigger::Manual).await.unwrap();
        let b = jobs.enqueue(test(1, 0), Trigger::Scheduled).await.unwrap();
        assert_ne!(blocker, a);
        assert_eq!(a, b);
    }

    #[tokio::test]
    async fn waiting_channel_probes_merge() {
        let db = test_support::db();
        let source = test_support::source(&db.lock(), "Main");
        let jobs = Jobs::new(&db);
        let probe = |ids: Vec<i64>| Work::Probe { source_id: source, channels: Some(ids), playlist_id: None };
        // Hold the source with a long job so the probes stay queued.
        jobs.enqueue(test(source, 500), Trigger::Manual).await.unwrap();
        let a = jobs.enqueue(probe(vec![1, 2]), Trigger::Automatic).await.unwrap();
        let b = jobs.enqueue(probe(vec![2, 3]), Trigger::Automatic).await.unwrap();
        assert_eq!(a, b);
        let job = job_by_id(&db.lock(), a).unwrap().unwrap();
        assert_eq!((job.total, job.title.as_str()), (Some(3), "Probe 3 channels on Main"));
    }

    #[tokio::test]
    async fn exclusive_work_waits_for_an_idle_queue() {
        let jobs = jobs();
        jobs.enqueue(test(1, 300), Trigger::Manual).await.unwrap();
        assert!(jobs.run_exclusive(|| async { Ok(()) }).await.is_err());
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(jobs.run_exclusive(|| async { Ok(()) }).await.is_ok());
    }

    #[test]
    fn live_status_prefers_running_then_queued() {
        let view = |kind: &str, status: &str| JobView {
            id: 1,
            kind: kind.into(),
            trigger: "manual".into(),
            status: status.into(),
            title: String::new(),
            source_id: Some(1),
            playlist_id: None,
            destination_id: None,
            step: None,
            done: Some(4),
            total: Some(10),
            summary: None,
            error: None,
            warnings: 0,
            created_at: String::new(),
            started_at: None,
            finished_at: None,
        };
        assert_eq!(live_status(&[], "sync", "syncing", "ok"), "ok");
        assert_eq!(live_status(&[view("sync", "queued")], "sync", "syncing", "ok"), "queued");
        assert_eq!(live_status(&[view("sync", "queued"), view("sync", "running")], "sync", "syncing", "ok"), "syncing");
        assert_eq!(live_status(&[view("probe", "running")], "sync", "syncing", "error"), "error");
        assert_eq!(probe_progress(&[view("probe", "running")]), (4, 10));
    }
}
