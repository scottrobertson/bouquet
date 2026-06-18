import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, MoreVertical, Play, RotateCcw, Tv } from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  fmtDay,
  fmtTime,
  halfHourTicks,
  HEADER_H,
  MIN_BLOCK_W,
  PX_PER_MS,
  ROW_H,
  widthForMs,
  xForMs,
} from "./layout";
import type { CategoryView, ChannelView, ProgrammeView } from "./types";

/** Local midnight of the day containing `ms`, in the browser's timezone. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface Row extends ChannelView {
  group: string;
}

interface Selected {
  channelName: string;
  programme: ProgrammeView;
  catchupDays: number;
  catchupSource: string;
}

export function GuideGrid({
  categories,
  loadedFromMs,
  loadedToMs,
  atMs,
  initialNowMs,
  needsSync,
}: {
  playlistId: number;
  categories: CategoryView[];
  // The range of programme data the loader fetched. Days inside it can be shown
  // without a refetch.
  loadedFromMs: number;
  loadedToMs: number;
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
  // The day the left edge is currently showing, for the date label. Tracked from
  // the scroll position so it updates as you scroll across midnights.
  const [viewDayMs, setViewDayMs] = useState(() => startOfDay(atMs));
  const [, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const loading = navigation.state === "loading";

  const scrollRef = useRef<HTMLDivElement>(null);
  // After a refetch moves the loaded range, where to put the scroll: a time to
  // sit at the left edge, or "now" to centre on the current time.
  const pendingScroll = useRef<number | "now" | null>(null);

  const groups = useMemo(() => categories.map((c) => c.name), [categories]);
  const rows = useMemo<Row[]>(() => {
    const all = categories.flatMap((c) =>
      c.channels.map((ch) => ({ ...ch, group: c.name })),
    );
    return group === ALL_GROUPS ? all : all.filter((r) => r.group === group);
  }, [categories, group]);

  // One continuous timeline across the whole loaded range, so scrolling moves
  // through time (and across midnights) with no day-by-day paging.
  const windowWidth = widthForMs(loadedFromMs, loadedToMs);
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

  // Position the scroll on first render and whenever a refetch shifts the loaded
  // range. Keyed on the range, so plain scrolling never repositions.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const p = pendingScroll.current;
    if (typeof p === "number") {
      el.scrollLeft = Math.max(0, xForMs(p, loadedFromMs));
    } else if (p === "now") {
      el.scrollLeft = scrollForCentre(el, nowMs, 0.25);
    } else {
      // Initial: same position as the "Now" button, the anchor a quarter in.
      el.scrollLeft = scrollForCentre(el, atMs, 0.25);
    }
    pendingScroll.current = null;
  }, [mounted, loadedFromMs, loadedToMs]);

  function scrollForCentre(el: HTMLDivElement, ms: number, fromLeft: number) {
    return Math.max(
      0,
      CHANNEL_COL_W + xForMs(ms, loadedFromMs) - el.clientWidth * fromLeft,
    );
  }

  // Keep the date label in step with what's at the left of the timeline.
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const leftTime = loadedFromMs + el.scrollLeft / PX_PER_MS;
    const day = startOfDay(leftTime);
    setViewDayMs((prev) => (prev === day ? prev : day));
  }

  // Fetch more data when scrolling off either end, re-centring the window and
  // restoring the scroll one screen further on so the motion stays continuous.
  function extend(dir: -1 | 1) {
    const el = scrollRef.current;
    if (!el) return;
    const screenMs = (el.clientWidth - CHANNEL_COL_W) / PX_PER_MS;
    const leftTime = loadedFromMs + el.scrollLeft / PX_PER_MS;
    pendingScroll.current = leftTime + dir * screenMs;
    const newAt = dir < 0 ? loadedFromMs : loadedToMs;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("at", String(newAt));
        return next;
      },
      { preventScrollReset: true },
    );
  }

  // Scroll the timeline by about a screen; at the very edge, fetch more.
  function handlePan(dir: -1 | 1) {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    if (dir < 0 && el.scrollLeft <= 0) return extend(-1);
    if (dir > 0 && el.scrollLeft >= maxScroll - 1) return extend(1);
    const step = Math.max(0, el.clientWidth - CHANNEL_COL_W) * 0.9;
    const target = Math.max(0, Math.min(maxScroll, el.scrollLeft + dir * step));
    el.scrollTo({ left: target, behavior: "smooth" });
  }

  function handleNow() {
    const el = scrollRef.current;
    if (!el) return;
    if (nowMs < loadedFromMs || nowMs > loadedToMs) {
      pendingScroll.current = "now";
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
    el.scrollTo({ left: scrollForCentre(el, nowMs, 0.25), behavior: "smooth" });
  }

  const ticks = useMemo(
    () => halfHourTicks(loadedFromMs, loadedToMs),
    [loadedFromMs, loadedToMs],
  );
  const nowVisible = nowMs >= loadedFromMs && nowMs <= loadedToMs;

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
        dayMs={viewDayMs}
        onPan={handlePan}
        onNow={handleNow}
        needsSync={needsSync}
      />

      <div
        ref={scrollRef}
        onScroll={handleScroll}
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
              {ticks.map((t) => {
                const midnight = startOfDay(t) === t;
                return (
                  <div
                    key={t}
                    className={cn(
                      "absolute top-0 bottom-0 pl-1 text-[11px] tabular-nums",
                      midnight
                        ? "border-l border-border font-medium text-foreground"
                        : "border-l border-border/60 text-muted-foreground",
                    )}
                    style={{ left: xForMs(t, loadedFromMs) }}
                  >
                    {midnight ? fmtDay(t) : fmtTime(t)}
                  </div>
                );
              })}
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
                fromMs={loadedFromMs}
                nowMs={nowMs}
                onSelect={setSelected}
              />
            ))}

            {nowVisible ? (
              <div
                className="pointer-events-none absolute top-0 z-10 w-0.5 bg-primary"
                style={{
                  left: CHANNEL_COL_W + xForMs(nowMs, loadedFromMs),
                  height: virtualizer.getTotalSize(),
                }}
              />
            ) : null}
          </div>
        </div>
      </div>

      <ProgrammeDialog
        selected={selected}
        nowMs={nowMs}
        onClose={() => setSelected(null)}
      />
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
        <DropdownMenuItem
          onClick={() => navigator.clipboard.writeText(streamUrl)}
        >
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
  const programmes = row.programmes;
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
        {programmes.length === 0 ? (
          <div className="absolute inset-y-1.5 left-0 flex w-56 items-center rounded-sm border border-dashed border-border/60 px-2 text-[11px] text-muted-foreground">
            No guide data
          </div>
        ) : (
          programmes.map((p, i) => (
            <ProgrammeBlock
              key={i}
              programme={p}
              fromMs={fromMs}
              windowWidth={windowWidth}
              nowMs={nowMs}
              catchupDays={row.catchupDays}
              onSelect={() =>
                onSelect({
                  channelName: row.displayName,
                  programme: p,
                  catchupDays: row.catchupDays,
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
  catchupDays,
  onSelect,
}: {
  programme: ProgrammeView;
  fromMs: number;
  windowWidth: number;
  nowMs: number;
  catchupDays: number;
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
          {isReplayable(p.startMs, p.stopMs, nowMs, catchupDays) ? (
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

/** A past programme can be replayed when the channel keeps an archive and the
    programme aired within that archive window. We go off the channel's own
    archive days, not the EPG's per-programme flag, so alternates that carry the
    primary's shared EPG still reflect their own stream's catchup. */
function isReplayable(
  startMs: number,
  stopMs: number,
  nowMs: number,
  catchupDays: number,
): boolean {
  return (
    catchupDays > 0 &&
    stopMs <= nowMs &&
    startMs >= nowMs - catchupDays * 86_400_000
  );
}

/** Fill the channel's timeshift template for one programme. The provider's
    timeshift endpoint wants the start time as local wall-clock time, the same
    time the guide shows, not UTC. */
function catchupUrl(template: string, startMs: number, stopMs: number): string {
  const d = new Date(startMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return template
    .replace("{duration}", String(Math.round((stopMs - startMs) / 60000)))
    .replace("{Y}", String(d.getFullYear()))
    .replace("{m}", pad(d.getMonth() + 1))
    .replace("{d}", pad(d.getDate()))
    .replace("{H}", pad(d.getHours()))
    .replace("{M}", pad(d.getMinutes()));
}

function ProgrammeDialog({
  selected,
  nowMs,
  onClose,
}: {
  selected: Selected | null;
  nowMs: number;
  onClose: () => void;
}) {
  const p = selected?.programme;
  const replayUrl =
    p &&
    selected?.catchupSource &&
    isReplayable(p.startMs, p.stopMs, nowMs, selected.catchupDays)
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
        {replayUrl ? (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <RotateCcw className="size-3.5" />
              Available to replay from your provider's catchup.
            </p>
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
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
