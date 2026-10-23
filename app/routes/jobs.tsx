import { Activity, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { JobKind } from "~/api/types/JobKind";
import type { JobView } from "~/api/types/JobView";
import type { JobsData } from "~/api/types/JobsData";
import { EmptyState } from "~/components/empty-state";
import { JobLog } from "~/components/jobs/job-log";
import {
  JobProgress,
  JobStatusIcon,
  KIND_LABELS,
  TRIGGER_LABELS,
  jobDuration,
  jobLink,
} from "~/components/jobs/job-parts";
import { PageHeader } from "~/components/page-header";
import { relativeTime } from "~/components/sources/source-shared";
import { apiLoad } from "~/lib/api";
import { useJobs, useNow } from "~/lib/jobs";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/jobs";

export function meta() {
  return [{ title: "Jobs · Bouquet" }];
}

export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return apiLoad<JobsData>(request);
}

type Filter = "all" | "problems" | JobKind;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "problems", label: "Problems" },
  { value: "sync", label: KIND_LABELS.sync },
  { value: "probe", label: KIND_LABELS.probe },
  { value: "upload", label: KIND_LABELS.upload },
  { value: "backup", label: KIND_LABELS.backup },
];

function matches(job: JobView, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "problems") {
    return job.status === "failed" || job.status === "interrupted" || job.warnings > 0;
  }
  return job.kind === filter;
}

export default function Jobs({ loaderData }: Route.ComponentProps) {
  const live = useJobs();
  // The live list is fresher, but the loader has it on the very first render.
  const active = live.ready ? live.active : loaderData.active;
  const [params, setParams] = useSearchParams();
  const filter = (params.get("filter") as Filter | null) ?? "all";
  const openId = Number(params.get("job")) || null;

  const setFilter = (value: Filter) =>
    setParams(
      (p) => {
        if (value === "all") p.delete("filter");
        else p.set("filter", value);
        return p;
      },
      { replace: true },
    );

  const finished = useMemo(
    () => loaderData.finished.filter((j) => matches(j, filter)),
    [loaderData.finished, filter],
  );

  return (
    <div>
      <PageHeader
        title="Jobs"
        description="Everything Bouquet does in the background: syncs, probes, uploads and backups."
      />
      <div className="space-y-8 px-4 py-5 md:px-8 md:py-6">
        <section className="space-y-3">
          <h2 className="text-[13px] font-medium text-muted-foreground">
            Running and queued
          </h2>
          {active.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
              Nothing is running right now.
            </div>
          ) : (
            <div className="-mx-4 divide-y divide-white/5 border-y border-border bg-card md:mx-0 md:rounded-lg md:border">
              {active.map((job) => (
                <ActiveRow key={job.id} job={job} />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[13px] font-medium text-muted-foreground">
              History
            </h2>
            {/* One row that swipes sideways on a phone, so the filters don't
                wrap onto a second line. */}
            <div className="-mx-4 flex w-[calc(100%+2rem)] gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:w-auto sm:flex-wrap sm:px-0">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(f.value)}
                  className={cn(
                    "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground",
                    filter === f.value && "bg-white/[0.07] text-foreground",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          {loaderData.finished.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No jobs yet"
              description="Syncs, probes, uploads and backups show up here once they've run."
            />
          ) : finished.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
              No jobs match this filter.
            </div>
          ) : (
            <div className="-mx-4 divide-y divide-white/5 border-y border-border bg-card md:mx-0 md:rounded-lg md:border">
              {finished.map((job) => (
                <HistoryRow key={job.id} job={job} startOpen={job.id === openId} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ActiveRow({ job }: { job: JobView }) {
  const [open, setOpen] = useState(false);
  const now = useNow();
  const link = jobLink(job);

  return (
    <div className={cn(open && "bg-white/[0.015]")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
      >
        <JobStatusIcon job={job} className="mt-0.5" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="truncate text-[13px] font-medium">{job.title}</div>
          <JobProgress job={job} className="max-w-xl" />
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground sm:flex">
          <span className="tabular-nums">
            {job.status === "running"
              ? `Running for ${jobDuration(job, now)}`
              : `Queued ${relativeTime(job.createdAt)}`}
          </span>
          <span>
            {[
              TRIGGER_LABELS[job.trigger],
              job.warnings > 0
                ? `${job.warnings} warning${job.warnings === 1 ? "" : "s"}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <ChevronRight
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <div className="space-y-2.5 px-4 pb-4 sm:pl-11">
          {link ? (
            <Link to={link} className="text-xs text-primary hover:underline">
              Open
            </Link>
          ) : null}
          <JobLog
            jobId={job.id}
            version={`${job.status}:${job.step}:${job.done}:${job.warnings}`}
          />
        </div>
      ) : null}
    </div>
  );
}

function HistoryRow({ job, startOpen }: { job: JobView; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const row = useRef<HTMLDivElement>(null);
  const now = useNow(60_000);
  const link = jobLink(job);
  const duration = jobDuration(job, now);
  const detail =
    job.status === "failed" || job.status === "interrupted" ? job.error : job.summary;

  // Arriving from a toast's "Details" link, so bring that job into view.
  useEffect(() => {
    if (!startOpen) return;
    setOpen(true);
    row.current?.scrollIntoView({ block: "center" });
  }, [startOpen]);

  return (
    <div ref={row} className={cn(open && "bg-white/[0.015]")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
      >
        <JobStatusIcon job={job} className="mt-0.5" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="truncate text-[13px] font-medium">{job.title}</div>
          {detail ? (
            <div
              className={cn(
                "truncate text-xs",
                job.status === "failed" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {detail}
            </div>
          ) : null}
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground sm:flex">
          <span>{relativeTime(job.finishedAt ?? job.createdAt)}</span>
          <span className="tabular-nums">
            {[TRIGGER_LABELS[job.trigger], duration].filter(Boolean).join(" · ")}
          </span>
        </div>
        <ChevronRight
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <div className="space-y-2.5 px-4 pb-4 sm:pl-11">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{TRIGGER_LABELS[job.trigger]}</span>
            {job.startedAt ? (
              <span>Started {new Date(job.startedAt).toLocaleString()}</span>
            ) : null}
            {duration ? <span>Took {duration}</span> : null}
            {job.warnings > 0 ? (
              <span className="text-warning">
                {job.warnings} warning{job.warnings === 1 ? "" : "s"}
              </span>
            ) : null}
            {link ? (
              <Link to={link} className="text-primary hover:underline">
                Open
              </Link>
            ) : null}
          </div>
          <JobLog jobId={job.id} />
        </div>
      ) : null}
    </div>
  );
}
