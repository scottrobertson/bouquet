import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  ListFilter,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Tv,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "~/components/ui/select";
import { logoSrc } from "~/lib/logo";
import { cn } from "~/lib/utils";
import type { MatchTarget } from "~/services/playlist/channel-match";
import { PrimaryPicker } from "./primary-picker";
import type { BrowserChannel, EditorCategory } from "./types";

const UNCATEGORISED = "Uncategorised";

export type AddTarget = { categoryId: number };

type PrimaryOption = {
  id: number;
  name: string;
  names?: string[];
  epgChannelId?: string | null;
  hint?: string;
};

type CatGroup = { name: string; channels: BrowserChannel[] };
type SourceGroup = {
  sourceId: number;
  sourceName: string;
  enabled: boolean;
  cats: CatGroup[];
};

type FlatRow =
  | {
      kind: "source";
      sourceId: number;
      name: string;
      count: number;
      enabled: boolean;
      expanded: boolean;
    }
  | { kind: "category"; sourceId: number; name: string; count: number }
  | { kind: "channel"; channel: BrowserChannel };

export function SourceBrowser({
  categories,
  results,
  total,
  alreadyAdded,
  loading,
  playlistCategories,
  primaries,
  picked,
  selected,
  onSelect,
  onAdd,
  onAddGroup,
  onAutoSync,
  onAddMatching,
  onAddAlternateOf,
  onShowAlreadyAdded,
  adding,
}: {
  categories: string[];
  results: BrowserChannel[];
  total: number;
  // Matching channels the playlist already covers, which are hidden from these
  // results.
  alreadyAdded: number;
  loading: boolean;
  playlistCategories: EditorCategory[];
  primaries: PrimaryOption[];
  // The selected source channels, which the alternate picker suggests a group
  // from.
  picked: MatchTarget[];
  selected: Set<number>;
  onSelect: (id: number, shiftKey: boolean, orderedIds: number[]) => void;
  onAdd: (ids: number[], target: AddTarget) => void;
  onAddGroup: (sourceId: number, categoryName: string) => void;
  onAutoSync: (sourceId: number, categoryName: string, name: string) => void;
  onAddMatching: (target: AddTarget) => void;
  onAddAlternateOf: (primaryId: number) => void;
  // Points the playlist pane's filter at the current search, so the channels
  // hidden from these results can be found on the other side.
  onShowAlreadyAdded: (query: string) => void;
  adding: boolean;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const categoriesParam = searchParams.get("categories") ?? "";
  const selectedCategories = categoriesParam.split(",").filter(Boolean);
  const q = searchParams.get("q") ?? "";
  const hasFilter = q.trim().length > 0 || selectedCategories.length > 0;

  // What's in the box, which only reaches the URL after a short pause in typing.
  const [searchInput, setSearchInput] = useState(q);
  const pushedToUrl = useRef(q);
  useEffect(() => {
    if (searchInput === pushedToUrl.current) return;
    const t = setTimeout(() => {
      pushedToUrl.current = searchInput;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (searchInput) next.set("q", searchInput);
          else next.delete("q");
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    }, 200);
    return () => clearTimeout(t);
  }, [searchInput, setSearchParams]);

  // Follow the URL when something else changes it, like the back button. Our own
  // write is ignored, otherwise typing "abc" slowly puts "a" back in the box the
  // moment the search for "a" lands.
  useEffect(() => {
    if (q === pushedToUrl.current) return;
    pushedToUrl.current = q;
    setSearchInput(q);
  }, [q]);

  // Auto-sync categories are read-only, so they can't be add targets.
  const addTargets = playlistCategories.filter((c) => !c.auto);

  const [target, setTarget] = useState<string>(
    addTargets[0] ? String(addTargets[0].id) : "",
  );
  useEffect(() => {
    if (!addTargets.some((c) => String(c.id) === target)) {
      setTarget(addTargets[0] ? String(addTargets[0].id) : "");
    }
  }, [playlistCategories, target]);

  // Group results by source, then category. Results arrive ordered by source
  // name then provider order, so insertion order is the display order.
  const sourceGroups = useMemo<SourceGroup[]>(() => {
    const map = new Map<
      number,
      {
        sourceName: string;
        enabled: boolean;
        cats: Map<string, BrowserChannel[]>;
      }
    >();
    for (const r of results) {
      let s = map.get(r.sourceId);
      if (!s) {
        s = { sourceName: r.sourceName, enabled: r.sourceEnabled, cats: new Map() };
        map.set(r.sourceId, s);
      }
      const key = r.categoryName ?? UNCATEGORISED;
      const list = s.cats.get(key);
      if (list) list.push(r);
      else s.cats.set(key, [r]);
    }
    return [...map].map(([sourceId, v]) => ({
      sourceId,
      sourceName: v.sourceName,
      enabled: v.enabled,
      cats: [...v.cats].map(([name, channels]) => ({ name, channels })),
    }));
  }, [results]);

  const multiSource = sourceGroups.length > 1;
  const anyDisabledSource = sourceGroups.some((s) => !s.enabled);
  // A single source doesn't need a header row of its own, unless it's disabled,
  // where the header is what says so and lets you open it back up.
  const showSourceRows = multiSource || anyDisabledSource;
  const categoryCount = sourceGroups.reduce((n, s) => n + s.cats.length, 0);

  // Enabled sources are open by default and disabled ones closed. Clicking a
  // source header records a choice here, which then wins.
  const catKey = (sourceId: number, name: string) => `${sourceId}::${name}`;
  const [openedSources, setOpenedSources] = useState<Map<number, boolean>>(
    new Map(),
  );
  // Groups you've opened or closed by hand. Everything else follows the default
  // below.
  const [catOverrides, setCatOverrides] = useState<Map<string, boolean>>(
    new Map(),
  );
  // Browsing 900 channels is easier with the groups shut. A search is the
  // opposite: you asked for those channels, so showing four closed group names
  // and no channel is just a second thing to click.
  const catIsExpanded = (sourceId: number, name: string) =>
    catOverrides.get(catKey(sourceId, name)) ?? hasFilter;

  // Each new search starts fresh, so a group you closed while looking for one
  // thing isn't still closed when you go looking for the next.
  useEffect(() => {
    setCatOverrides(new Map());
  }, [q, categoriesParam]);

  function toggleSource(id: number, expanded: boolean) {
    setOpenedSources((prev) => new Map(prev).set(id, !expanded));
  }
  function toggleCat(sourceId: number, name: string) {
    const open = catIsExpanded(sourceId, name);
    setCatOverrides((prev) =>
      new Map(prev).set(catKey(sourceId, name), !open),
    );
  }

  const allExpanded =
    sourceGroups.length > 0 &&
    sourceGroups.every((s) =>
      s.cats.every((c) => catIsExpanded(s.sourceId, c.name)),
    );

  // The all-toggle opens every source and category group, including the
  // disabled sources that start closed.
  function toggleAll() {
    const next = new Map<string, boolean>();
    for (const s of sourceGroups) {
      for (const c of s.cats) next.set(catKey(s.sourceId, c.name), !allExpanded);
    }
    setCatOverrides(next);
    if (!allExpanded) {
      setOpenedSources(new Map(sourceGroups.map((s) => [s.sourceId, true])));
    }
  }

  const flatRows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    for (const s of sourceGroups) {
      if (showSourceRows) {
        const count = s.cats.reduce((n, c) => n + c.channels.length, 0);
        const expanded = openedSources.get(s.sourceId) ?? s.enabled;
        out.push({
          kind: "source",
          sourceId: s.sourceId,
          name: s.sourceName,
          count,
          enabled: s.enabled,
          expanded,
        });
        if (!expanded) continue;
      }
      for (const cat of s.cats) {
        out.push({
          kind: "category",
          sourceId: s.sourceId,
          name: cat.name,
          count: cat.channels.length,
        });
        if (catIsExpanded(s.sourceId, cat.name)) {
          for (const ch of cat.channels) out.push({ kind: "channel", channel: ch });
        }
      }
    }
    return out;
  }, [sourceGroups, showSourceRows, openedSources, catOverrides, hasFilter]);

  // The visible channel rows in display order, so a shift+click range only spans
  // what's actually on screen (collapsed groups aren't included).
  const orderedChannelIds = useMemo(
    () =>
      flatRows.flatMap((r) => (r.kind === "channel" ? [r.channel.id] : [])),
    [flatRows],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (flatRows[i].kind === "channel" ? 40 : 32),
    overscan: 12,
  });

  function setParam(key: string, value: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }
  function toggleCategoryFilter(name: string) {
    const set = new Set(selectedCategories);
    if (set.has(name)) set.delete(name);
    else set.add(name);
    setParam("categories", Array.from(set).join(","));
  }

  const capped = total > results.length;
  const mode: "selected" | "matching" | null =
    selected.size > 0 ? "selected" : hasFilter && total > 0 ? "matching" : null;
  const canAdd = mode !== null && target !== "";

  function add() {
    const t: AddTarget = { categoryId: Number(target) };
    if (mode === "selected") onAdd(Array.from(selected), t);
    else if (mode === "matching") onAddMatching(t);
  }

  // Row the arrow keys are sitting on, as an index into flatRows.
  const [cursor, setCursor] = useState<number | null>(null);
  useEffect(() => setCursor(null), [results]);

  const searchRef = useRef<HTMLInputElement>(null);
  // "/" jumps to the search box from anywhere on the page.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      )
        return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function moveCursor(dir: 1 | -1) {
    const channelRows: number[] = [];
    flatRows.forEach((r, i) => {
      if (r.kind === "channel") channelRows.push(i);
    });
    if (!channelRows.length) return;
    const at = cursor == null ? -1 : channelRows.indexOf(cursor);
    const next =
      at < 0
        ? dir === 1
          ? 0
          : channelRows.length - 1
        : Math.min(Math.max(at + dir, 0), channelRows.length - 1);
    const index = channelRows[next];
    setCursor(index);
    rowVirtualizer.scrollToIndex(index, { align: "auto" });
  }

  // Arrows walk the results and Enter adds, so a search can be finished without
  // reaching for the mouse.
  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveCursor(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveCursor(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = cursor == null ? null : flatRows[cursor];
      if (row?.kind === "channel" && target) {
        onAdd([row.channel.id], { categoryId: Number(target) });
      } else if (canAdd) {
        add();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (searchInput) setSearchInput("");
      else searchRef.current?.blur();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Source channels
          </div>
          {results.length > 0 ? (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={toggleAll}
                className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                {allExpanded ? "Collapse all" : "Expand all"}
              </button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {multiSource
                  ? `${sourceGroups.length} sources · ${total.toLocaleString()} channels`
                  : `${categoryCount} categories · ${total.toLocaleString()} channels`}
              </span>
            </div>
          ) : null}
        </div>
        <div className="flex gap-2">
          <CategoryFilter
            categories={categories}
            selected={selectedCategories}
            onToggle={toggleCategoryFilter}
            onClear={() => setParam("categories", "")}
          />
          <div className="relative w-1/2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search all sources..."
              className="h-8 px-8"
            />
            {searchInput ? null : (
              <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground">
                /
              </kbd>
            )}
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {results.length === 0 ? (
          <div className="space-y-3 px-4 py-12 text-center text-[13px] text-muted-foreground">
            {loading ? (
              "Loading..."
            ) : !hasFilter ? (
              "No channels available. Add a source and sync, or enable some categories."
            ) : alreadyAdded > 0 ? (
              // The browser hides channels the playlist already has, so without
              // saying this the search just looks like the channel doesn't exist.
              <>
                <p>
                  Nothing left to add.{" "}
                  {alreadyAdded === 1
                    ? "The 1 matching channel is"
                    : `All ${alreadyAdded.toLocaleString()} matching channels are`}{" "}
                  already in this playlist.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onShowAlreadyAdded(q)}
                >
                  Search the playlist
                </Button>
              </>
            ) : (
              "No channels match your filters."
            )}
          </div>
        ) : (
          <div
            className={cn("relative w-full", loading && "opacity-60")}
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            {rowVirtualizer.getVirtualItems().map((vi) => {
              const row = flatRows[vi.index];
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={rowVirtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  {row.kind === "source" ? (
                    <button
                      type="button"
                      onClick={() => toggleSource(row.sourceId, row.expanded)}
                      className="flex w-full cursor-pointer items-center gap-1.5 border-b border-border bg-secondary px-3 py-3 text-left md:py-2"
                    >
                      {row.expanded ? (
                        <ChevronDown className="size-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3.5 text-muted-foreground" />
                      )}
                      <Radio className="size-3.5 shrink-0 text-muted-foreground" />
                      <span
                        className={cn(
                          "truncate text-[13px] font-semibold",
                          !row.enabled && "text-muted-foreground",
                        )}
                      >
                        {row.name}
                      </span>
                      {!row.enabled ? (
                        <Badge className="shrink-0 border-transparent bg-muted px-1.5 py-0 text-[11px] font-medium text-muted-foreground">
                          Source off
                        </Badge>
                      ) : null}
                      <span className="ml-auto rounded-full bg-white/[0.06] px-1.5 text-[11px] tabular-nums text-muted-foreground">
                        {row.count.toLocaleString()}
                      </span>
                    </button>
                  ) : row.kind === "category" ? (
                    <div
                      className={cn(
                        "group/grp flex w-full items-center gap-1.5 border-b border-white/5 bg-card px-3 py-3.5 md:py-1.5",
                        showSourceRows && "pl-4",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => toggleCat(row.sourceId, row.name)}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                      >
                        {catIsExpanded(row.sourceId, row.name) ? (
                          <ChevronDown className="size-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3.5 text-muted-foreground" />
                        )}
                        <span className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                          {row.name}
                        </span>
                        <span className="rounded-full bg-white/[0.06] px-1.5 text-[11px] tabular-nums text-muted-foreground">
                          {row.count}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onAddGroup(row.sourceId, row.name)}
                        title="Add this whole group as a category"
                        className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-primary md:py-0.5 md:opacity-0 md:group-hover/grp:opacity-100"
                      >
                        <Plus className="size-3" />
                        Add all
                      </button>
                      <AutoSyncButton
                        sourceId={row.sourceId}
                        categoryName={row.name}
                        onAutoSync={onAutoSync}
                      />
                    </div>
                  ) : (
                    <SourceRow
                      channel={row.channel}
                      checked={selected.has(row.channel.id)}
                      highlighted={vi.index === cursor}
                      onSelect={(shiftKey) =>
                        onSelect(row.channel.id, shiftKey, orderedChannelIds)
                      }
                      indented={showSourceRows}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {capped ? (
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Showing the first {results.length.toLocaleString()} of{" "}
          {total.toLocaleString()}. Refine filters to narrow the list.
        </div>
      ) : null}

      {hasFilter && results.length > 0 && alreadyAdded > 0 ? (
        <div className="flex items-center gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>
            {alreadyAdded.toLocaleString()} more{" "}
            {alreadyAdded === 1 ? "match is" : "matches are"} already in this
            playlist.
          </span>
          <button
            type="button"
            onClick={() => onShowAlreadyAdded(q)}
            className="cursor-pointer font-medium text-primary hover:underline"
          >
            Search the playlist
          </button>
        </div>
      ) : null}

      {mode ? (
        <div className="space-y-2 border-t border-border bg-card px-4 py-3">
          <p className="text-[11px] text-muted-foreground">
            {mode === "selected"
              ? `Add ${selected.size} selected to:`
              : `Add all ${total.toLocaleString()} matching channels to:`}
          </p>
          <div className="flex items-center gap-2">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger size="sm" className="flex-1">
                <span className="truncate">
                  {addTargets.find((c) => String(c.id) === target)?.name ??
                    "Target category"}
                </span>
              </SelectTrigger>
              <SelectContent>
                {addTargets.map((cat) => (
                  <SelectItem key={cat.id} value={String(cat.id)}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={add} disabled={!canAdd || adding}>
              <Plus className="size-4" />
              {adding
                ? "Adding..."
                : mode === "selected"
                  ? `Add ${selected.size}`
                  : "Add all"}
            </Button>
          </div>
          {mode === "selected" && primaries.length > 0 ? (
            <div className="flex items-center gap-2 border-t border-border pt-2">
              <span className="text-[11px] text-muted-foreground">or</span>
              <PrimaryPicker
                primaries={primaries}
                picked={picked}
                onPick={onAddAlternateOf}
                label="Add as alternate of…"
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CategoryFilter({
  categories,
  selected,
  onToggle,
  onClear,
}: {
  categories: string[];
  selected: string[];
  onToggle: (name: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const label =
    selected.length === 0
      ? "All categories"
      : `${selected.length} categor${selected.length === 1 ? "y" : "ies"}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="w-1/2 cursor-pointer justify-between font-normal"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <ListFilter className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Filter categories..." />
          <CommandList>
            <CommandEmpty>No categories.</CommandEmpty>
            {selected.length > 0 ? (
              <CommandGroup>
                <CommandItem value="__clear__" onSelect={onClear}>
                  Clear filter ({selected.length})
                </CommandItem>
              </CommandGroup>
            ) : null}
            <CommandGroup>
              {categories.map((c) => (
                <CommandItem key={c} value={c} onSelect={() => onToggle(c)}>
                  <Checkbox
                    checked={selected.includes(c)}
                    className="pointer-events-none"
                  />
                  <span className="truncate">{c}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Turns a provider category into an auto-sync playlist group. Asks for the
    group name (prefilled with the category name) before creating. */
function AutoSyncButton({
  sourceId,
  categoryName,
  onAutoSync,
}: {
  sourceId: number;
  categoryName: string;
  onAutoSync: (sourceId: number, categoryName: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(categoryName);

  function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onAutoSync(sourceId, categoryName, trimmed);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setName(categoryName);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Auto-sync this group: keeps a playlist group in step with this category"
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-primary md:py-0.5 md:opacity-0 md:group-hover/grp:opacity-100"
        >
          <RefreshCw className="size-3" />
          Auto-sync
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-2 p-3">
        <p className="text-[11px] text-muted-foreground">
          Creates a read-only group that tracks this category as the provider adds
          and removes channels.
        </p>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              create();
            }
          }}
          placeholder="Playlist group name"
          className="h-8"
        />
        <Button size="sm" className="w-full" onClick={create} disabled={!name.trim()}>
          <RefreshCw className="size-4" />
          Create auto-sync group
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** A source channel row. Tapping anywhere selects it; adding to the playlist
    happens from the action bar below. */
function SourceRow({
  channel,
  checked,
  highlighted,
  onSelect,
  indented,
}: {
  channel: BrowserChannel;
  checked: boolean;
  // The row the arrow keys are on. Enter adds it.
  highlighted?: boolean;
  onSelect: (shiftKey: boolean) => void;
  indented?: boolean;
}) {
  return (
    <div
      onClick={(e) => onSelect(e.shiftKey)}
      className={cn(
        "flex cursor-pointer items-center gap-2 px-3 py-3.5 transition-colors hover:bg-white/[0.02] md:py-1.5",
        indented && "pl-4",
        checked && "bg-primary/5",
        highlighted && "bg-primary/10 ring-1 ring-inset ring-primary/40",
      )}
    >
      <Checkbox checked={checked} className="pointer-events-none" />
      {channel.logo ? (
        <img
          src={logoSrc(channel.logo)}
          alt=""
          loading="lazy"
          onError={(e) => {
            e.currentTarget.style.visibility = "hidden";
          }}
          className="hidden size-6 shrink-0 rounded object-contain md:block"
        />
      ) : (
        <div className="hidden size-6 shrink-0 items-center justify-center rounded bg-secondary text-muted-foreground md:flex">
          <Tv className="size-3.5" />
        </div>
      )}
      <span className="min-w-0 flex-1 truncate text-[13px]">
        {channel.name}
        {!channel.available ? (
          <span className="ml-1 text-[11px] text-warning">· unavailable</span>
        ) : null}
      </span>
    </div>
  );
}
