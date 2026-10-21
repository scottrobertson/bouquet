//! Queues sync, probe and backup jobs on their cron schedules, in the same
//! process as the web server. The ticks are hourly and only queue what's
//! actually due, so a source's own interval controls the real timing. A job
//! still waiting from the last tick isn't queued twice.

use std::future::Future;
use std::str::FromStr;

use chrono::Local;
use croner::Cron;

use crate::config::config;
use crate::jobs::{Jobs, Trigger, Work};

fn schedule<F, Fut>(label: &'static str, expression: &str, run: F)
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
{
    let cron = match Cron::from_str(expression) {
        Ok(c) => c,
        Err(_) => {
            eprintln!("[cron] invalid {label} cron \"{expression}\", disabled");
            return;
        }
    };
    println!("[cron] scheduled {label}: {expression}");
    tokio::spawn(async move {
        loop {
            let Ok(next) = cron.find_next_occurrence(&Local::now(), false) else { return };
            let wait = (next - Local::now()).to_std().unwrap_or_default();
            tokio::time::sleep(wait).await;
            if let Err(e) = run().await {
                eprintln!("[cron] {label} failed: {e:#}");
            }
        }
    });
}

pub fn start(jobs: &Jobs) {
    let cfg = config();
    if !cfg.run_scheduler {
        return;
    }
    let j = jobs.clone();
    schedule("sync", &cfg.sync_cron, move || {
        let jobs = j.clone();
        async move { crate::sync::sync_due_sources(&jobs).await }
    });
    let j = jobs.clone();
    schedule("probe", &cfg.probe_cron, move || {
        let jobs = j.clone();
        async move { jobs.probe_due_sources().await }
    });
    let j = jobs.clone();
    schedule("backup", &cfg.backup_cron, move || {
        let jobs = j.clone();
        async move { jobs.enqueue(Work::Backup { manual: false }, Trigger::Scheduled).await.map(|_| ()) }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_default_cron_expressions() {
        for e in ["0 * * * *", "0 3 * * *", "0 4 * * *", "*/15 * * * *"] {
            let cron = Cron::from_str(e).unwrap();
            let next = cron.find_next_occurrence(&Local::now(), false).unwrap();
            assert!(next > Local::now(), "{e}");
        }
        assert!(Cron::from_str("not a cron").is_err());
    }

    #[test]
    fn hourly_ticks_land_on_the_hour() {
        use chrono::Timelike;
        let next = Cron::from_str("0 * * * *").unwrap().find_next_occurrence(&Local::now(), false).unwrap();
        assert_eq!((next.minute(), next.second()), (0, 0));
    }
}
