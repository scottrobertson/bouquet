//! Runs sync, probe and backup on their cron schedules, in the same process
//! as the web server. The ticks are hourly and each job only acts on what's
//! actually due, so a source's own interval controls the real timing.

use std::future::Future;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Local;
use croner::Cron;

use crate::config::config;
use crate::db::Db;
use crate::probe::Prober;

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
    // A run can outlast the tick, so a tick is skipped while the last run is
    // still going.
    let running = Arc::new(AtomicBool::new(false));
    tokio::spawn(async move {
        loop {
            let Ok(next) = cron.find_next_occurrence(&Local::now(), false) else { return };
            let wait = (next - Local::now()).to_std().unwrap_or_default();
            tokio::time::sleep(wait).await;
            if running.swap(true, Ordering::SeqCst) {
                eprintln!("[cron] {label} still running, skipping this tick");
                continue;
            }
            let fut = run();
            let running = running.clone();
            tokio::spawn(async move {
                match fut.await {
                    Ok(()) => println!("[cron] {label} done"),
                    Err(e) => eprintln!("[cron] {label} failed: {e:#}"),
                }
                running.store(false, Ordering::SeqCst);
            });
        }
    });
}

pub fn start(db: &Db) {
    let cfg = config();
    if !cfg.run_scheduler {
        return;
    }
    let sync_db = db.clone();
    schedule("sync", &cfg.sync_cron, move || {
        let db = sync_db.clone();
        async move { crate::sync::sync_due_sources(&db).await }
    });
    let prober = Prober::new(db);
    schedule("probe", &cfg.probe_cron, move || {
        let prober = prober.clone();
        async move { prober.probe_due_sources().await }
    });
    let backup_db = db.clone();
    schedule("backup", &cfg.backup_cron, move || {
        let db = backup_db.clone();
        async move { crate::backup::auto_backup(&db).await }
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
