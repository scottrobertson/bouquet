use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use tokio::task::JoinHandle;

/// Runs a job once things go quiet: each call pushes the run back, so a burst
/// of calls inside the window collapses into a single run.
pub struct Debouncer {
    delay: Duration,
    pending: Mutex<Option<JoinHandle<()>>>,
}

impl Debouncer {
    pub const fn new(delay: Duration) -> Debouncer {
        Debouncer { delay, pending: Mutex::new(None) }
    }

    pub fn call<F, Fut>(&'static self, job: F)
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = pending.take() {
            old.abort();
        }
        let delay = self.delay;
        *pending = Some(tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            // Detach the job from this handle so a later call can't abort it
            // once it has started.
            tokio::spawn(job());
        }));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn collapses_repeated_calls_into_one_run() {
        static DEBOUNCER: Debouncer = Debouncer::new(Duration::from_secs(5));
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        for _ in 0..3 {
            DEBOUNCER.call(|| async {
                RUNS.fetch_add(1, Ordering::SeqCst);
            });
        }
        tokio::time::sleep(Duration::from_secs(6)).await;
        tokio::task::yield_now().await;
        assert_eq!(RUNS.load(Ordering::SeqCst), 1);
    }
}
