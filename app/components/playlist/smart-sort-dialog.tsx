import { ArrowDown, ArrowUp, Crown, Info, Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { qualityMeta } from "~/lib/quality";
import {
  CODEC_EFFICIENCY_TABLE,
  type SmartSortConfig,
  type SmartSortFactors,
} from "~/services/playlist/smart-sort";

type PreviewStream = {
  id: number;
  sourceName: string;
  providerName: string;
  categoryName: string | null;
  currentlyPrimary: boolean;
  currentPosition: number;
  probeStatus: "queued" | "probing" | "ok" | "error" | "timeout" | null;
  probeWidth: number | null;
  probeHeight: number | null;
  probeFps: number | null;
  probeVideoCodec: string | null;
  probeAudioCodec: string | null;
  probeBitrate: number | null;
  factors: SmartSortFactors;
};

type PreviewData = {
  ok: boolean;
  intent?: string;
  config?: SmartSortConfig;
  streams?: PreviewStream[];
};

/** Short, scannable summary of the rules the sort used, from the playlist config.
    The bitrate rule carries a flag so we can hang the "how" popover off it. */
function ruleItems(config: SmartSortConfig): { text: string; bitrate?: boolean }[] {
  const order =
    config.prefer === "bitrate"
      ? "bitrate, then resolution, then frame rate"
      : "resolution, then frame rate, then bitrate";
  const items: { text: string; bitrate?: boolean }[] = [
    { text: `Ranked by ${order}` },
    { text: "Bitrate normalised per codec", bitrate: true },
  ];
  if (config.audio)
    items.push({ text: "Ties broken by audio (surround over stereo)" });
  if (config.availableFirst)
    items.push({
      text: "Working streams first, then unprobed, failed, source off, then auto-disabled",
    });
  return items;
}

/** The "show your working" popover: why bitrate is normalised and the per-codec
    multipliers it uses, read straight from the sort's own table. */
function BitrateExplainer() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex cursor-pointer text-muted-foreground/60 hover:text-foreground"
          aria-label="How bitrate is normalised"
        >
          <Info className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2.5">
        <p className="text-[12px] text-muted-foreground">
          Newer codecs fit the same picture into fewer bits, so comparing raw
          bitrates would punish them. We scale each stream's bitrate up to a
          rough H.264 equivalent first, then compare that.
        </p>
        <div className="rounded-md border border-border">
          {CODEC_EFFICIENCY_TABLE.map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5 text-[12px] last:border-b-0"
            >
              <span>{row.label}</span>
              <span className="tabular-nums text-muted-foreground">
                × {row.factor}
              </span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground/70">
          So HEVC at 4 Mbps counts as ~6.8 Mbps of H.264. The result is bucketed
          to the nearest 0.5 Mbps, so tiny differences read as a tie.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function mbps(kbps: number | null): string | null {
  if (!kbps || kbps <= 0) return null;
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
}

const STATUS_LABEL: Record<SmartSortFactors["liveness"], string | null> = {
  working: null,
  unprobed: "Not probed",
  failed: "Probe failed",
  unavailable: "Unavailable",
  sourceOff: "Source off",
  autoDisabled: "Auto-disabled",
};

function StatusBadge({ factors }: { factors: SmartSortFactors }) {
  const label = STATUS_LABEL[factors.liveness];
  if (!label) return null;
  return (
    <Badge
      className={
        // Muted like the editor's Source off badge; the rest warn in amber.
        factors.liveness === "sourceOff"
          ? "border-transparent bg-muted text-muted-foreground"
          : "border-transparent bg-warning/10 text-warning"
      }
    >
      {label}
    </Badge>
  );
}

/** One row of the proposed order: its new rank, the stream, the data behind it,
    and how far it moved. */
function PreviewRow({ stream, index }: { stream: PreviewStream; index: number }) {
  const meta = qualityMeta(stream);
  const moved = index - stream.currentPosition;
  const wasPrimary = stream.currentlyPrimary && index !== 0;
  const f = stream.factors;
  const bitrate = mbps(f.rawBitrateKbps);

  return (
    <div className="flex items-start gap-3 border-b border-white/5 px-1 py-2.5 last:border-b-0">
      <div className="w-5 shrink-0 pt-0.5 text-center text-sm font-medium tabular-nums text-muted-foreground">
        {index + 1}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-medium">{stream.sourceName}</span>
          {index === 0 ? (
            <Badge className="border-transparent bg-primary/15 text-primary">
              <Crown className="size-3" />
              Primary
            </Badge>
          ) : null}
          {wasPrimary ? (
            <Badge className="border-transparent bg-muted text-muted-foreground">
              Was primary
            </Badge>
          ) : null}
          <StatusBadge factors={f} />
        </div>
        <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span className="shrink-0">{stream.providerName}</span>
          <span className="text-muted-foreground/50">·</span>
          <span className="min-w-0 truncate">
            {stream.categoryName ?? "Uncategorised"}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          {meta ? (
            <>
              {meta.resolution ? <span>{meta.resolution.label}</span> : null}
              {meta.details.map((d) => (
                <span key={d} className="flex items-center gap-1">
                  <span className="text-muted-foreground/50">·</span>
                  {d}
                </span>
              ))}
              {bitrate ? (
                <span className="flex items-center gap-1">
                  <span className="text-muted-foreground/50">·</span>
                  {bitrate}
                  {f.codecAdjusted && f.normalisedBitrateKbps ? (
                    <span className="text-muted-foreground/60">
                      (~{mbps(f.normalisedBitrateKbps)} h264)
                    </span>
                  ) : null}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground/60">No probe data</span>
          )}
        </div>
      </div>
      <div className="shrink-0 pt-0.5">
        {moved === 0 ? (
          <span className="text-[11px] text-muted-foreground/40">—</span>
        ) : moved < 0 ? (
          <span className="flex items-center gap-0.5 text-[11px] text-success">
            <ArrowUp className="size-3" />
            {Math.abs(moved)}
          </span>
        ) : (
          <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
            <ArrowDown className="size-3" />
            {moved}
          </span>
        )}
      </div>
    </div>
  );
}

/** Previews a smart sort for one group, explains the order, and applies it on
    confirm. Reordering can change which stream is primary, so it's gated behind
    this rather than firing on click. */
export function SmartSortDialog({
  primaryId,
  open,
  onOpenChange,
}: {
  primaryId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = useFetcher<PreviewData>();
  const apply = useFetcher();

  // Refetch each time it opens, so the preview reflects any probe that landed
  // since last time.
  const submitPreview = preview.submit;
  useEffect(() => {
    if (!open) return;
    submitPreview(
      { intent: "previewSmartSort", primaryId },
      { method: "post" },
    );
  }, [open, primaryId, submitPreview]);

  // Close once the apply has gone through.
  const applied = useRef(false);
  useEffect(() => {
    if (apply.state === "submitting") applied.current = true;
    if (applied.current && apply.state === "idle") {
      applied.current = false;
      onOpenChange(false);
    }
  }, [apply.state, onOpenChange]);

  const data = preview.data;
  const streams = data?.streams ?? [];
  const config = data?.config;
  const loading = preview.state !== "idle" || !data;
  const primaryChanges = streams.length > 0 && !streams[0].currentlyPrimary;
  const noChange =
    streams.length > 0 && streams.every((s, i) => s.currentPosition === i);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Smart sort preview
          </DialogTitle>
          <DialogDescription>
            The order this would put the group in, best stream first. Nothing
            changes until you apply it.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Working out the order…
          </div>
        ) : (
          <div className="space-y-3">
            {config ? (
              <div className="rounded-md bg-secondary/50 px-3 py-2">
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                  How this was ranked
                </p>
                <ul className="space-y-0.5 text-[12px] text-muted-foreground">
                  {ruleItems(config).map((r) => (
                    <li key={r.text} className="flex items-center gap-1.5">
                      <span className="text-muted-foreground/40">•</span>
                      <span>{r.text}</span>
                      {r.bitrate ? <BitrateExplainer /> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {primaryChanges ? (
              <p className="rounded-md bg-primary/10 px-3 py-2 text-[12px] text-primary">
                This makes <strong>{streams[0].sourceName}</strong> the new
                primary. The channel name and guide stay the same.
              </p>
            ) : noChange ? (
              <p className="rounded-md bg-secondary/50 px-3 py-2 text-[12px] text-muted-foreground">
                The group is already in this order, so applying does nothing.
              </p>
            ) : null}

            <div className="max-h-[50vh] overflow-y-auto">
              {streams.map((s, i) => (
                <PreviewRow key={s.id} stream={s} index={i} />
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={loading || noChange || apply.state !== "idle"}
            onClick={() =>
              apply.submit(
                { intent: "smartSortGroup", primaryId },
                { method: "post" },
              )
            }
          >
            {apply.state !== "idle" ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Applying…
              </>
            ) : (
              "Apply order"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
