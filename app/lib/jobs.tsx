import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useRevalidator } from "react-router";
import { toast } from "sonner";
import type { JobView } from "~/api/types/JobView";
import type { JobsData } from "~/api/types/JobsData";
import type { ServerEvent } from "~/api/types/ServerEvent";
import type { SourceProbeStatus } from "~/api/types/SourceProbeStatus";
import type { SyncStatus } from "~/api/types/SyncStatus";

// Coalesce bursts (a probe nudges once per channel) into one page reload.
const THROTTLE_MS = 700;
// Some reverse proxies buffer SSE, so we also re-read the job list now and
// then. Otherwise a stuck stream would leave a job showing as running forever,
// or never show one at all.
const BACKSTOP_MS = 15_000;

export function isActive(job: Pick<JobView, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

type JobsContextValue = {
  active: JobView[];
  // False until the first list arrives, so pages can use their own loader
  // data until then.
  ready: boolean;
};

const JobsContext = createContext<JobsContextValue>({ active: [], ready: false });

/** Follows every queued and running job over the server's event stream, so
    any page can show live progress, and reloads the page's data whenever a job
    starts or finishes or something it touched changes. */
export function JobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Map<number, JobView>>(new Map());
  const [ready, setReady] = useState(false);
  const revalidate = useThrottledRevalidate();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    let closed = false;
    // The live list, kept outside React state so events and list reads always
    // see the latest version, even between renders.
    let store = new Map<number, JobView>();
    // Jobs we've seen finish. Ids are never reused, so once a job is in here
    // nothing can bring it back as running.
    const finished = new Set<number>();
    // Counts events, so a list read can tell which jobs changed while it was
    // in flight.
    let eventCount = 0;
    const lastEvent = new Map<number, number>();

    const publish = (next: Map<number, JobView>) => {
      store = next;
      setJobs(next);
    };

    const load = async () => {
      const startedAt = eventCount;
      try {
        const res = await fetch("/api/jobs");
        if (!res.ok || closed) return;
        const data = (await res.json()) as JobsData;
        if (closed) return;
        const next = new Map<number, JobView>();
        for (const job of data.active) {
          if (!finished.has(job.id)) next.set(job.id, job);
        }
        // An event that arrived after this request went out is newer than the
        // list, so it wins. Without this, a list read just before a job
        // finished would put the job back as running.
        for (const [id, at] of lastEvent) {
          if (at <= startedAt) continue;
          const live = store.get(id);
          if (live) next.set(id, live);
          else next.delete(id);
        }
        // A job started or finished without an event reaching us, so the
        // page's data is behind too.
        const key = (list: Iterable<JobView>) =>
          [...list].map((j) => `${j.id}:${j.status}`).sort().join(",");
        if (key(next.values()) !== key(store.values())) revalidate();
        publish(next);
        setReady(true);
      } catch {
        // The next event or backstop tick tries again.
      }
    };

    const onJob = (job: JobView) => {
      // A progress update that was overtaken by the job finishing.
      if (finished.has(job.id)) return;
      lastEvent.set(job.id, ++eventCount);
      const before = store.get(job.id);
      // Progress ticks only move the bar. A job starting or finishing changes
      // what pages show, so those reload the page.
      if (!before || before.status !== job.status) revalidate();
      const next = new Map(store);
      if (isActive(job)) {
        next.set(job.id, job);
      } else {
        finished.add(job.id);
        next.delete(job.id);
        announce(job, (to) => navigateRef.current(to));
      }
      publish(next);
    };

    const es = new EventSource("/events");
    // Also fires on reconnect, which is when we may have missed events.
    es.onopen = () => void load();
    es.onmessage = (e) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(e.data) as ServerEvent;
      } catch {
        return;
      }
      if (event.type === "job") onJob(event.job);
      else revalidate();
    };

    es.onerror = () => void load();
    const backstop = setInterval(() => void load(), BACKSTOP_MS);

    void load();
    return () => {
      closed = true;
      es.close();
      clearInterval(backstop);
    };
  }, [revalidate]);

  const value = useMemo(() => {
    // Running first, then the queue in the order it'll run.
    const active = [...jobs.values()].sort(
      (a, b) =>
        Number(b.status === "running") - Number(a.status === "running") ||
        a.id - b.id,
    );
    return { active, ready };
  }, [jobs, ready]);

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

/** Toast a finished job. Background jobs only speak up when they fail, so the
    schedule doesn't bury the user in notifications. */
function announce(job: JobView, navigate: (to: string) => void) {
  const details = {
    label: "Details",
    onClick: () => navigate(`/jobs?job=${job.id}`),
  };
  if (job.status === "failed") {
    toast.error(`${job.title} failed`, {
      description: job.error ?? undefined,
      action: details,
    });
  } else if (job.trigger === "manual" && job.status === "succeeded") {
    const description = [
      job.summary,
      job.warnings > 0
        ? `${job.warnings} warning${job.warnings === 1 ? "" : "s"}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const show = job.warnings > 0 ? toast.warning : toast.success;
    show(job.title, { description: description || undefined, action: details });
  }
}

function useThrottledRevalidate() {
  const revalidator = useRevalidator();
  // Held in a ref so the event stream doesn't reconnect on every revalidation
  // state change.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  const [trigger] = useState(() => {
    let lastRun = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;

    const run = () => {
      const r = revalidatorRef.current;
      // Busy with an earlier reload, so retry soon instead of dropping this
      // one. Otherwise the final change in a burst can be lost.
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
      void r.revalidate();
    };

    // Run now if we're past the throttle window, otherwise on the trailing
    // edge so the last change in a burst still lands.
    return () => {
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
  });
  return trigger;
}

export function useJobs(): JobsContextValue {
  return useContext(JobsContext);
}

/** Queued and running jobs for one source, playlist or upload destination. */
export function useActiveJobsFor(filter: {
  sourceId?: number;
  playlistId?: number;
  destinationId?: number;
  kind?: JobView["kind"];
}): JobView[] {
  const { active } = useJobs();
  return active.filter(
    (j) =>
      (filter.sourceId == null || j.sourceId === filter.sourceId) &&
      (filter.playlistId == null || j.playlistId === filter.playlistId) &&
      (filter.destinationId == null ||
        j.destinationId === filter.destinationId) &&
      (filter.kind == null || j.kind === filter.kind),
  );
}

/** A source's sync and probe status, with live progress from its jobs. The
    page's own data says the same thing, but only updates when a job starts or
    finishes. */
export function useLiveSourceStatus(source: {
  id: number;
  syncStatus: SyncStatus;
  probeStatus: SourceProbeStatus;
  probeDone: number;
  probeTotal: number;
}) {
  const jobs = useActiveJobsFor({ sourceId: source.id });
  const pick = (kind: JobView["kind"]) =>
    jobs.find((j) => j.kind === kind && j.status === "running") ??
    jobs.find((j) => j.kind === kind);
  const syncJob = pick("sync");
  const probeJob = pick("probe");
  return {
    sync: {
      job: syncJob,
      status: (syncJob
        ? syncJob.status === "running"
          ? "syncing"
          : "queued"
        : source.syncStatus) as SyncStatus,
    },
    probe: {
      job: probeJob,
      status: (probeJob
        ? probeJob.status === "running"
          ? "probing"
          : "queued"
        : source.probeStatus) as SourceProbeStatus,
      done: probeJob?.status === "running" ? (probeJob.done ?? 0) : source.probeDone,
      total: probeJob?.status === "running" ? (probeJob.total ?? 0) : source.probeTotal,
    },
  };
}

/** The current time, updated every `ms`, for elapsed timers. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
