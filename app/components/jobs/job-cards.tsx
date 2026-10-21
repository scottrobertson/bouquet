import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { JobView } from "~/api/types/JobView";
import { relativeTime } from "~/components/sources/source-shared";
import { useJobs, useNow } from "~/lib/jobs";
import { cn } from "~/lib/utils";
import { JobLog } from "./job-log";
import {
  JobProgress,
  JobStatusIcon,
  KIND_ICONS,
  TRIGGER_LABELS,
  jobDuration,
  jobLink,
} from "./job-parts";

/** A queued or running job with its live progress and an optional log. */
export function ActiveJobCard({
  job,
  showLink = true,
}: {
  job: JobView;
  showLink?: boolean;
}) {
  const now = useNow();
  const [open, setOpen] = useState(false);
  const link = showLink ? jobLink(job) : null;

  return (
    <div className="space-y-2.5 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2.5">
        <JobStatusIcon job={job} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {link ? (
            <Link to={link} className="hover:text-primary">
              {job.title}
            </Link>
          ) : (
            job.title
          )}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {job.status === "running"
            ? jobDuration(job, now)
            : `Queued ${relativeTime(job.createdAt)}`}
        </span>
      </div>
      <JobProgress job={job} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{TRIGGER_LABELS[job.trigger]}</span>
        {job.warnings > 0 ? (
          <span className="text-warning">
            {job.warnings} warning{job.warnings === 1 ? "" : "s"}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
          />
          {open ? "Hide log" : "Show log"}
        </button>
      </div>
      {open ? (
        <JobLog
          jobId={job.id}
          version={`${job.status}:${job.step}:${job.done}:${job.warnings}`}
        />
      ) : null}
    </div>
  );
}

// The sidebar has room for a few; the rest are a click away on the jobs page.
const TRAY_LIMIT = 3;

/** What's running right now, pinned to the bottom of the sidebar. Hidden
    while nothing is. */
export function JobsTray({ onNavigate }: { onNavigate?: () => void }) {
  const { active } = useJobs();
  if (active.length === 0) return null;

  const running = active.filter((j) => j.status === "running").length;
  const queued = active.length - running;
  const shown = active.slice(0, TRAY_LIMIT);
  const more = active.length - shown.length;

  return (
    <Link
      to="/jobs"
      onClick={onNavigate}
      className="mx-2 mb-2 block space-y-3 rounded-lg border border-border bg-card/60 px-3 py-2.5 transition-colors hover:bg-white/[0.03]"
    >
      <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <span>
          {running > 0 ? `${running} running` : "Waiting"}
          {queued > 0 ? ` · ${queued} queued` : ""}
        </span>
        <ChevronRight className="size-3.5" />
      </div>
      {shown.map((job) => {
        const Icon = KIND_ICONS[job.kind];
        return (
          <div key={job.id} className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <Icon
                className={cn(
                  "size-3.5 shrink-0",
                  job.status === "running" ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="truncate font-medium">{job.title}</span>
            </div>
            <JobProgress job={job} />
          </div>
        );
      })}
      {more > 0 ? (
        <div className="text-xs text-muted-foreground">and {more} more</div>
      ) : null}
    </Link>
  );
}
