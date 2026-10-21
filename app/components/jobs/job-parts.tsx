import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  DatabaseBackup,
  Gauge,
  Loader2,
  RefreshCw,
  Upload,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { JobView } from "~/api/types/JobView";
import type { JobKind } from "~/api/types/JobKind";
import type { JobTrigger } from "~/api/types/JobTrigger";
import { cn } from "~/lib/utils";

export const KIND_ICONS: Record<JobKind, LucideIcon> = {
  sync: RefreshCw,
  probe: Gauge,
  upload: Upload,
  backup: DatabaseBackup,
};

export const KIND_LABELS: Record<JobKind, string> = {
  sync: "Sync",
  probe: "Probe",
  upload: "Upload",
  backup: "Backup",
};

export const TRIGGER_LABELS: Record<JobTrigger, string> = {
  manual: "Started by you",
  scheduled: "Scheduled",
  automatic: "Automatic",
};

/** Where a job's subject lives in the app, if it still exists. */
export function jobLink(job: JobView): string | null {
  if (job.kind === "upload" && job.playlistId != null) {
    return `/playlists/${job.playlistId}/settings`;
  }
  if (job.playlistId != null) return `/playlists/${job.playlistId}`;
  if (job.sourceId != null) return `/sources/${job.sourceId}`;
  if (job.kind === "backup") return "/settings";
  return null;
}

/** A short duration like "4s", "2m 05s" or "1h 12m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** How long a job ran, or has been running so far. */
export function jobDuration(job: JobView, now: number): string | null {
  if (!job.startedAt) return null;
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : now;
  return formatDuration(end - new Date(job.startedAt).getTime());
}

export function JobStatusIcon({
  job,
  className,
}: {
  job: Pick<JobView, "status" | "warnings">;
  className?: string;
}) {
  const base = cn("size-4 shrink-0", className);
  switch (job.status) {
    case "running":
      return <Loader2 className={cn(base, "animate-spin text-primary")} />;
    case "queued":
      return <Clock className={cn(base, "text-muted-foreground")} />;
    case "failed":
      return <XCircle className={cn(base, "text-destructive")} />;
    case "interrupted":
      return <Ban className={cn(base, "text-muted-foreground")} />;
    case "succeeded":
      return job.warnings > 0 ? (
        <AlertTriangle className={cn(base, "text-warning")} />
      ) : (
        <CheckCircle2 className={cn(base, "text-success")} />
      );
  }
}

/** The job's current step with a progress bar. Without a count to go on the
    bar pulses instead, so it still reads as working. */
export function JobProgress({
  job,
  className,
}: {
  job: JobView;
  className?: string;
}) {
  const hasCount = job.total != null && job.total > 0;
  const percent = hasCount
    ? Math.min(100, Math.round(((job.done ?? 0) / job.total!) * 100))
    : null;
  const queued = job.status === "queued";

  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate text-muted-foreground">
          {queued ? "Waiting for its turn" : (job.step ?? "Starting")}
        </span>
        {hasCount && !queued ? (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {(job.done ?? 0).toLocaleString()} / {job.total!.toLocaleString()}
          </span>
        ) : null}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
        {queued ? null : percent != null ? (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
        )}
      </div>
    </div>
  );
}
