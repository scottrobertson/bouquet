import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";

// Revalidate the current route's loaders when the server says a source changed,
// instead of polling on a timer. Pass `active` true while a background sync or
// probe is running; the SSE connection only stays open during that window.

// Coalesce bursts (a probe fires one event per channel) into one revalidate.
const THROTTLE_MS = 700;
// Backstop poll in case SSE never connects (some reverse proxies buffer it), so
// we never get stuck showing a stale "syncing"/"probing" forever.
const BACKSTOP_MS = 15_000;

export function useLiveRevalidate(active: boolean): void {
  const revalidator = useRevalidator();

  // Hold the revalidator in a ref so the effect only re-runs (and reconnects the
  // stream) when `active` flips, not on every revalidation state change.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  useEffect(() => {
    if (!active) return;

    let lastRun = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;

    const run = () => {
      const r = revalidatorRef.current;
      // Busy with an earlier revalidation, so retry soon instead of dropping
      // this trigger. Otherwise the final "done" event in a burst can be lost.
      if (r.state !== "idle") {
        if (!pending) {
          pending = setTimeout(() => {
            pending = undefined;
            run();
          }, 200);
        }
        return;
      }
      lastRun = Date.now();
      r.revalidate();
    };

    // Run now if we're past the throttle window, otherwise schedule the trailing
    // edge so the final event in a burst still lands.
    const trigger = () => {
      const wait = lastRun + THROTTLE_MS - Date.now();
      if (wait <= 0) {
        run();
      } else if (!pending) {
        pending = setTimeout(() => {
          pending = undefined;
          run();
        }, wait);
      }
    };

    const es = new EventSource("/events");
    es.onmessage = trigger;
    const backstop = setInterval(trigger, BACKSTOP_MS);

    return () => {
      es.close();
      clearInterval(backstop);
      if (pending) clearTimeout(pending);
    };
  }, [active]);
}
