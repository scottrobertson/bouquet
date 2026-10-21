//! The jobs page: what's queued and running, recent history, and each job's
//! log.

use axum::Router;
use axum::extract::{Path, State};
use axum::routing::get;
use serde::Serialize;
use ts_rs::TS;

use super::AppState;
use super::api::{ApiResult, found, ok};
use crate::jobs::{JobLogLine, JobView, active_jobs, finished_jobs, job_by_id, job_logs};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/jobs", get(list)).route("/api/jobs/{id}", get(detail))
}

// The history is pruned anyway, so this is just enough for the page.
const HISTORY_LIMIT: i64 = 200;

#[derive(Serialize, TS)]
#[ts(export)]
pub struct JobsData {
    pub active: Vec<JobView>,
    pub finished: Vec<JobView>,
}

async fn list(State(state): State<AppState>) -> ApiResult {
    let data = state
        .db
        .call(|conn| Ok(JobsData { active: active_jobs(conn)?, finished: finished_jobs(conn, HISTORY_LIMIT)? }))
        .await?;
    ok(data)
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct JobDetailData {
    pub job: JobView,
    pub logs: Vec<JobLogLine>,
}

async fn detail(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult {
    let data = state
        .db
        .call(move |conn| {
            let Some(job) = job_by_id(conn, id)? else { return Ok(None) };
            Ok(Some(JobDetailData { job, logs: job_logs(conn, id)? }))
        })
        .await?;
    ok(found(data)?)
}
