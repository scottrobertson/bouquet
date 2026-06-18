import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, MoreVertical, Play, RotateCcw, Tv } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigation, useSearchParams } from "react-router";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { logoSrc } from "~/lib/logo";
import { cn } from "~/lib/utils";
import { ALL_GROUPS, GuideToolbar } from "./guide-toolbar";
import {
  CHANNEL_COL_W,
  fmtTime,
  halfHourTicks,
  HEADER_H,
  MIN_BLOCK_W,
  ROW_H,
  widthForMs,
  xForMs,
} from "./layout";
import type { CategoryView, ChannelView, ProgrammeView } from "./types";

interface Row extends ChannelView {
  group: string;
}

interface Selected {
  channelName: string;
  programme: ProgrammeView;
  catchupSource: string;
}

export function GuideGrid({
  categories,
  fromMs,
  toMs,
  atMs,
  initialNowMs,
  needsSync,
}: {
  playlistId: number;
  categories: CategoryView[];
  fromMs: number;
  toMs: number;
  atMs: number;
  initialNowMs: number;
  needsSync: boolean;
}) {
  const [group, setGroup] = useState(ALL_GROUPS);
  const [nowMs, setNowMs] = useState(initialNowMs);
  const [selected, setSelected] = useState<Selected | null>(null);
  // The grid formats times in the browser's locale and timezone, so it can't be
  // server-rendered without a hydration mismatch. It's a client-only view.
  const [mounted, setMounted] = useState(false);
  const [, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const loading = navigation.state === "loading";

  const scrollRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => categories.map((c) => c.name), [categories]);
  const rows = useMemo<Row[]>(() => {
    const all = categories.flatMap((c) =>
      c.channels.map((ch) => ({ ...ch, group: c.name })),
    );
    return group === ALL_GROUPS ? all : all.filter((r) => r.group === group);
  }, [categories, group]);

  const windowWidth = widthForMs(fromMs, toMs);
  const totalWidth = CHANNEL_COL_W + windowWidth;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  useEffect(() => setMounted(true), []);

  // Tick the now line every 30s. Only the line moves, not the layout.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // On load (and when the window changes via day navigation), put "now" about a
  // quarter in from the left if it's in view, otherwise start at the left edge.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (initialNowMs >= fromMs && initialNowMs <= toMs) {
      // Centre "now" so recent history is on screen, not just the future.
      const x = CHANNEL_COL_W + xForMs(initialNowMs, fromMs) - el.clientWidth * 0.5;
      el.scrollLeft = Math.max(0, x);
    } else {
      el.scrollLeft = 0;
    }
  }, [mounted, fromMs, toMs, initialNowMs]);

  function handleNow() {
    if (nowMs < fromMs || nowMs > toMs) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("at");
          return next;
        },
        { preventScrollReset: true },
      );
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const x = CHANNEL_COL_W + xForMs(nowMs, fromMs) - el.clientWidth * 0.25;
    el.scrollTo({ left: Math.max(0, x), behavior: "smooth" });
  }

  const ticks = useMemo(() => halfHourTicks(fromMs, toMs), [fromMs, toMs]);
  const nowVisible = nowMs >= fromMs && nowMs <= toMs;

  if (!mounted) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        Loading guide…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <GuideToolbar
        groups={groups}
        group={group}
        onGroupChange={setGroup}
        atMs={atMs}
        onNow={handleNow}
        needsSync={needsSync}
      />

      <div
        ref={scrollRef}
        className={cn(
          "relative min-h-0 flex-1 overflow-auto overscroll-contain bg-background transition-opacity",
          loading && "opacity-60",
        )}
      >
        <div style={{ width: totalWidth }}>
          {/* Time axis. Sticky to the top; the corner cell sticks to the left. */}
          <div
            className="sticky top-0 z-30 flex"
            style={{ height: HEADER_H, width: totalWidth }}
          >
            <div
              className="sticky left-0 z-10 shrink-0 border-r border-b border-border bg-card"
              style={{ width: CHANNEL_COL_W, height: HEADER_H }}
            />
            <div
              className="relative shrink-0 border-b border-border bg-card"
              style={{ width: windowWidth, height: HEADER_H }}
            >
              {ticks.map((t) => (
                <div
                  key={t}
                  className="absolute top-0 bottom-0 border-l border-border/60 pl-1 text-[11px] text-muted-foreground tabular-nums"
                  style={{ left: xForMs(t, fromMs) }}
                >
                  {fmtTime(t)}
                </div>
              ))}
            </div>
          </div>

          {/* Rows. */}
          <div
            className="relative"
            style={{ height: virtualizer.getTotalSize(), width: totalWidth }}
          >
            {virtualizer.getVirtualItems().map((vi) => (
              <ChannelRow
                key={vi.key}
                row={rows[vi.index]}
                top={vi.start}
                windowWidth={windowWidth}
                fromMs={fromMs}
                nowMs={nowMs}
                onSelect={setSelected}
              />
            ))}

            {nowVisible ? (
              <div
                className="pointer-events-none absolute top-0 z-10 w-0.5 bg-primary"
                style={{
                  left: CHANNEL_COL_W + xForMs(nowMs, fromMs),
                  height: virtualizer.getTotalSize(),
                }}
              />
            ) : null}
          </div>
        </div>
      </div>

      <ProgrammeDialog selected={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

/** Per-channel actions in the guide: play the provider's stream in VLC or copy
    its URL. Mirrors the playlist editor's row menu. */
function ChannelMenu({ streamUrl }: { streamUrl: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
        >
          <MoreVertical className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <a href={`vlc://${streamUrl}`}>
            <Play className="size-4" />
            Play in VLC
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigator.clipboard.writeText(streamUrl)}>
          <Copy className="size-4" />
          Copy stream URL
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ChannelRow = memo(function ChannelRow({
  row,
  top,
  windowWidth,
  fromMs,
  nowMs,
  onSelect,
}: {
  row: Row;
  top: number;
  windowWidth: number;
  fromMs: number;
  nowMs: number;
  onSelect: (s: Selected) => void;
}) {
  const logo = logoSrc(row.logo);
  return (
    <div
      className="absolute left-0 flex"
      style={{ top, height: ROW_H, width: CHANNEL_COL_W + windowWidth }}
    >
      <div
        className="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-b border-border bg-card px-2"
        style={{ width: CHANNEL_COL_W, height: ROW_H }}
      >
        {logo ? (
          <img
            src={logo}
            alt=""
            loading="lazy"
            className="size-7 shrink-0 rounded object-contain"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        ) : (
          <div className="flex size-7 shrink-0 items-center justify-center rounded bg-secondary text-muted-foreground">
            <Tv className="size-3.5" />
          </div>
        )}
        <span className="flex-1 truncate text-[13px]">{row.displayName}</span>
        {row.catchupDays > 0 ? (
          <RotateCcw
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label={`${row.catchupDays} day catchup`}
          />
        ) : null}
        <ChannelMenu streamUrl={row.streamUrl} />
      </div>

      <div
        className="relative shrink-0 border-b border-border"
        style={{ width: windowWidth, height: ROW_H }}
      >
        {row.programmes.length === 0 ? (
          <div className="absolute inset-y-1.5 left-0 flex w-56 items-center rounded-sm border border-dashed border-border/60 px-2 text-[11px] text-muted-foreground">
            No guide data
          </div>
        ) : (
          row.programmes.map((p, i) => (
            <ProgrammeBlock
              key={i}
              programme={p}
              fromMs={fromMs}
              windowWidth={windowWidth}
              nowMs={nowMs}
              onSelect={() =>
                onSelect({
                  channelName: row.displayName,
                  programme: p,
                  catchupSource: row.catchupSource,
                })
              }
            />
          ))
        )}
      </div>
    </div>
  );
});

function ProgrammeBlock({
  programme: p,
  fromMs,
  windowWidth,
  nowMs,
  onSelect,
}: {
  programme: ProgrammeView;
  fromMs: number;
  windowWidth: number;
  nowMs: number;
  onSelect: () => void;
}) {
  const left = xForMs(p.startMs, fromMs);
  const rawWidth = Math.max(MIN_BLOCK_W, widthForMs(p.startMs, p.stopMs)) - 2;
  // Clamp so a programme running past the window's end doesn't overflow now that
  // the row no longer clips.
  const width = Math.min(rawWidth, windowWidth - left);
  const past = p.stopMs <= nowMs;
  const airing = p.startMs <= nowMs && nowMs < p.stopMs;
  const showTime = width > 64;

  return (
    <button
      type="button"
      onClick={onSelect}
      title={`${p.title ?? ""}\n${fmtTime(p.startMs)} – ${fmtTime(p.stopMs)}${
        p.description ? `\n\n${p.description}` : ""
      }`}
      className={cn(
        "absolute top-1.5 bottom-1.5 block rounded-sm border border-border bg-card text-left hover:bg-white/[0.03]",
        past && "opacity-50",
        airing && "border-primary/40 bg-primary/10 hover:bg-primary/15",
      )}
      style={{ left, width }}
    >
      {/* Sticky so the title stays visible while a long programme is scrolled
          past; it slides along but is clamped to the block. */}
      <span
        className="sticky flex h-full w-fit max-w-full flex-col justify-center px-2"
        style={{ left: CHANNEL_COL_W }}
      >
        <span className="flex min-w-0 items-center gap-1">
          {past && p.catchup ? (
            <RotateCcw className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="truncate text-[12px] font-medium">
            {p.title ?? "Unknown"}
          </span>
        </span>
        {showTime ? (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {fmtTime(p.startMs)}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** Fill the channel's timeshift template for one programme. Times are formatted
    in UTC, matching the unix timestamps we store from the provider's EPG. */
function catchupUrl(template: string, startMs: number, stopMs: number): string {
  const d = new Date(startMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return template
    .replace("{duration}", String(Math.round((stopMs - startMs) / 60000)))
    .replace("{Y}", String(d.getUTCFullYear()))
    .replace("{m}", pad(d.getUTCMonth() + 1))
    .replace("{d}", pad(d.getUTCDate()))
    .replace("{H}", pad(d.getUTCHours()))
    .replace("{M}", pad(d.getUTCMinutes()));
}

function ProgrammeDialog({
  selected,
  onClose,
}: {
  selected: Selected | null;
  onClose: () => void;
}) {
  const p = selected?.programme;
  const replayUrl =
    p?.catchup && selected?.catchupSource
      ? catchupUrl(selected.catchupSource, p.startMs, p.stopMs)
      : null;
  return (
    <Dialog open={!!selected} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{p?.title ?? "Programme"}</DialogTitle>
          <DialogDescription>
            {selected?.channelName}
            {p ? ` · ${fmtTime(p.startMs)} – ${fmtTime(p.stopMs)}` : ""}
          </DialogDescription>
        </DialogHeader>
        {p?.subTitle ? (
          <p className="text-[13px] font-medium">{p.subTitle}</p>
        ) : null}
        {p?.description ? (
          <p className="text-[13px] text-muted-foreground">{p.description}</p>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            No description available.
          </p>
        )}
        {p?.catchup ? (
          <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <RotateCcw className="size-3.5" />
            Available to replay from your provider's catchup.
          </p>
        ) : null}
        {replayUrl ? (
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="secondary">
              <a href={`vlc://${replayUrl}`}>
                <Play className="size-4" />
                Play catchup in VLC
              </a>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => navigator.clipboard.writeText(replayUrl)}
            >
              <Copy className="size-4" />
              Copy catchup URL
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
