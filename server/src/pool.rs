use std::future::Future;

use futures::StreamExt;

/// Run `f` over `items` with at most `limit` in flight at once. Results come
/// back in the same order as `items`.
pub async fn map_pool<T, R, F, Fut>(items: Vec<T>, limit: usize, f: F) -> Vec<R>
where
    F: FnMut(T) -> Fut,
    Fut: Future<Output = R>,
{
    futures::stream::iter(items).map(f).buffered(limit.max(1)).collect().await
}

/// Has a source's interval passed since it last ran? An interval of 0 means
/// manual only, so the scheduler never picks it.
pub fn is_interval_due(last_at: Option<i64>, interval_minutes: i64, now: i64) -> bool {
    if interval_minutes <= 0 {
        return false;
    }
    match last_at {
        None => true,
        Some(last) => now - last >= interval_minutes * 60,
    }
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn keeps_input_order_and_limits_concurrency() {
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let out = map_pool((0..10u64).collect(), 3, |i| {
            let (running, peak) = (running.clone(), peak.clone());
            async move {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(10 - i)).await;
                running.fetch_sub(1, Ordering::SeqCst);
                i * 2
            }
        })
        .await;
        assert_eq!(out, (0..10).map(|i| i * 2).collect::<Vec<_>>());
        assert!(peak.load(Ordering::SeqCst) <= 3);
    }

    #[tokio::test]
    async fn handles_an_empty_list_and_a_zero_limit() {
        let out: Vec<i32> = map_pool(vec![], 0, |i: i32| async move { i }).await;
        assert!(out.is_empty());
        assert_eq!(map_pool(vec![1, 2], 0, |i| async move { i }).await, vec![1, 2]);
    }

    #[test]
    fn interval_due() {
        let now = 1_705_320_000;
        assert!(!is_interval_due(None, 0, now));
        assert!(!is_interval_due(Some(now - 999 * 86_400), 0, now));
        assert!(is_interval_due(None, 1440, now));
        assert!(is_interval_due(Some(now - 61 * 60), 60, now));
        assert!(!is_interval_due(Some(now - 59 * 60), 60, now));
        assert!(is_interval_due(Some(now - 60 * 60), 60, now));
    }
}
