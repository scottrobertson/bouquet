import { useEffect, useRef, useState } from "react";
import type { JobDetailData } from "~/api/types/JobDetailData";
import type { JobLogLine } from "~/api/types/JobLogLine";
import { cn } from "~/lib/utils";

// A running job's log is re-read at most this often while it moves.
const REFRESH_MS = 1500;

/** A job's log, line by line. Pass `version` (anything that changes as the job
    moves, like its progress) to keep it following a running job. */
export function JobLog({ jobId, version }: { jobId: number; version?: unknown }) {
  const [lines, setLines] = useState<JobLogLine[] | null>(null);
  const [failed, setFailed] = useState(false);
  const lastLoad = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      lastLoad.current = Date.now();
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (!res.ok) throw new Error(res.statusText);
        const data = (await res.json()) as JobDetailData;
        if (!cancelled) {
          setLines(data.logs);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    const wait = lastLoad.current + REFRESH_MS - Date.now();
    const t = setTimeout(() => void load(), Math.max(0, wait));
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [jobId, version]);

  // Keep the newest line in view as a running job adds to the log.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines?.length]);

  if (failed && !lines) {
    return <p className="text-xs text-destructive">Couldn't load the log.</p>;
  }
  if (!lines) {
    return <p className="text-xs text-muted-foreground">Loading the log…</p>;
  }
  if (lines.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing logged yet.</p>;
  }

  return (
    <div
      ref={box}
      className="max-h-80 overflow-y-auto rounded-md border border-white/5 bg-black/20 py-2 font-mono text-[11.5px] leading-relaxed"
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            "flex gap-3 px-3",
            line.level === "warn" && "bg-warning/[0.06] text-warning",
            line.level === "error" && "bg-destructive/[0.08] text-destructive",
          )}
        >
          <span className="shrink-0 tabular-nums text-muted-foreground/70">
            {new Date(line.at).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-words">
            {line.message}
          </span>
        </div>
      ))}
    </div>
  );
}
