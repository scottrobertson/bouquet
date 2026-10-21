import { CircleAlert, CircleCheck, History, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { ProbeHistory } from "~/api/types/ProbeHistory";
import type { ProbeHistorySample } from "~/api/types/ProbeHistorySample";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  bitrateLabel,
  cleanProbeError,
  fpsLabel,
  resolutionLabel,
} from "~/lib/quality";
import { cn } from "~/lib/utils";
import type { EditorChannel } from "./types";

function when(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function sampleQuality(s: ProbeHistorySample): string {
  if (s.status !== "ok") {
    const label = s.status === "timeout" ? "Timed out" : "Failed";
    const detail = cleanProbeError(s.error)?.trim();
    return detail && detail !== "Probe timed out" ? `${label}: ${detail}` : label;
  }
  return (
    [
      resolutionLabel(s.width, s.height),
      fpsLabel(s.fps),
      s.videoCodec,
      bitrateLabel(s.bitrate),
    ]
      .filter(Boolean)
      .join(" · ") || "Passed"
  );
}

type Kind = "counted" | "ignored" | "failed";

function kindOf(s: ProbeHistorySample): Kind {
  if (s.status !== "ok") return "failed";
  return s.ignored ? "ignored" : "counted";
}

const BAR_CLASS: Record<Kind, string> = {
  counted: "bg-primary",
  ignored: "bg-muted-foreground/35",
  failed: "bg-destructive",
};

const LEGEND: Record<Kind, string> = {
  counted: "Counted",
  ignored: "Ignored, likely a slate",
  failed: "Failed",
};

const CHART_HEIGHT = 56;
// Probes with no bitrate reading get a short stub so they stay visible
// without looking like a high reading.
const STUB_HEIGHT = 6;

/** One bar per probe, oldest on the left. Hovering a bar shows that probe in
    the line under the chart, which shows the latest probe otherwise. */
function BitrateChart({
  samples,
  typical,
}: {
  samples: ProbeHistorySample[];
  typical: number | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...samples.map((s) => s.bitrate ?? 0));
  const hasBitrate = max > 0;
  const shown = samples[hover ?? samples.length - 1];
  const kinds = (["counted", "ignored", "failed"] as Kind[]).filter((k) =>
    samples.some((s) => kindOf(s) === k),
  );

  const heightOf = (s: ProbeHistorySample) => {
    if (s.status !== "ok") return STUB_HEIGHT;
    // With no bitrate on any probe the chart is just a pass and fail strip.
    if (!hasBitrate) return CHART_HEIGHT;
    if (!s.bitrate) return STUB_HEIGHT;
    return Math.max(STUB_HEIGHT, (s.bitrate / max) * CHART_HEIGHT);
  };

  return (
    <div className="space-y-1.5">
      <div
        className="relative flex items-end gap-0.5"
        style={{ height: CHART_HEIGHT }}
        onMouseLeave={() => setHover(null)}
      >
        {hasBitrate && typical ? (
          <div
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-foreground/30"
            style={{ bottom: (typical / max) * CHART_HEIGHT }}
          />
        ) : null}
        {samples.map((s, i) => (
          <button
            key={i}
            type="button"
            aria-label={`${when(s.probedAt)}: ${sampleQuality(s)}`}
            className="flex h-full min-w-0 max-w-6 flex-1 cursor-default items-end"
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          >
            <span
              className={cn(
                "w-full rounded-t-[4px] transition-opacity",
                BAR_CLASS[kindOf(s)],
                hover != null && hover !== i && "opacity-50",
              )}
              style={{ height: heightOf(s) }}
            />
          </button>
        ))}
      </div>
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-[11px]">
        <span className="min-w-0 truncate text-foreground">
          {sampleQuality(shown)}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {when(shown.probedAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        {kinds.map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className={cn("size-2 rounded-[2px]", BAR_CLASS[k])} />
            {LEGEND[k]}
          </span>
        ))}
        {hasBitrate && typical ? (
          <span className="flex items-center gap-1">
            <span className="w-3 border-t border-dashed border-foreground/40" />
            Typical
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Summary({
  channel,
  history,
}: {
  channel: EditorChannel;
  history: ProbeHistory;
}) {
  const ignored = history.samples.filter((s) => s.ignored).length;
  const typical = [
    resolutionLabel(channel.probeWidth, channel.probeHeight),
    fpsLabel(channel.probeFps),
    bitrateLabel(channel.probeBitrate),
  ]
    .filter(Boolean)
    .join(" · ");
  const days = history.days === 1 ? "day" : `${history.days} days`;
  return (
    <div className="space-y-0.5 text-[12px] text-muted-foreground">
      {typical ? (
        <p>
          Typical over the last {days}:{" "}
          <span className="text-foreground">{typical}</span>
        </p>
      ) : null}
      <p>
        {channel.probePasses} of {channel.probeAttempts}{" "}
        {channel.probeAttempts === 1 ? "probe" : "probes"} passed.
        {ignored > 0
          ? ignored === 1
            ? " 1 low reading was ignored as a likely slate."
            : ` ${ignored} low readings were ignored as likely slates.`
          : ""}
      </p>
    </div>
  );
}

/** The stream's recent probes: what the editor's quality line is a summary of.
    Loaded each time the dialog opens, so it includes any probe that just
    finished. */
function HistoryBody({
  channel,
  playlistId,
}: {
  channel: EditorChannel;
  playlistId: number;
}) {
  const fetcher = useFetcher<ProbeHistory>();
  const load = fetcher.load;
  useEffect(() => {
    load(
      `/playlists/${playlistId}/probe-history?sourceChannelId=${channel.sourceChannelId}`,
    );
  }, [load, playlistId, channel.sourceChannelId]);

  const history = fetcher.data;
  if (!history) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Loading probe history…
      </div>
    );
  }
  if (history.samples.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">
        No probes in the last {history.days} days.
      </p>
    );
  }

  const newestFirst = [...history.samples].reverse();
  return (
    <div className="space-y-3">
      <Summary channel={channel} history={history} />
      <BitrateChart samples={history.samples} typical={channel.probeBitrate} />
      <div className="max-h-48 overflow-y-auto rounded-md border border-border">
        {newestFirst.map((s, i) => (
          <div
            key={i}
            className="flex items-start gap-2 border-b border-border px-2.5 py-1.5 text-[11px] last:border-b-0"
          >
            {s.status === "ok" ? (
              <CircleCheck className="mt-px size-3 shrink-0 text-success" />
            ) : (
              <CircleAlert className="mt-px size-3 shrink-0 text-destructive" />
            )}
            <span
              className={cn(
                "min-w-0 flex-1",
                s.ignored && "text-muted-foreground",
              )}
            >
              {sampleQuality(s)}
              {s.ignored ? (
                <span className="text-muted-foreground/70"> · ignored</span>
              ) : null}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {when(s.probedAt)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A stream's probe history, opened from the row's menu. */
export function ProbeHistoryDialog({
  channel,
  playlistId,
  open,
  onOpenChange,
}: {
  channel: EditorChannel;
  playlistId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4 text-primary" />
            Probe history
          </DialogTitle>
          <DialogDescription>
            {channel.sourceName} · {channel.sourceProviderName}
          </DialogDescription>
        </DialogHeader>
        {open ? <HistoryBody channel={channel} playlistId={playlistId} /> : null}
      </DialogContent>
    </Dialog>
  );
}
