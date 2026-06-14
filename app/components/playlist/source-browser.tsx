import { useDraggable } from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  ListFilter,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Tv,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
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
import type { BrowserChannel, EditorCategory } from "./types";

const NEW_CATEGORY = "__new__";
const UNCATEGORISED = "Uncategorised";

export type AddTarget = { categoryId: number } | { newCategoryName: string };

type CatGroup = { name: string; channels: BrowserChannel[] };
type SourceGroup = { sourceId: number; sourceName: string; cats: CatGroup[] };

type FlatRow =
  | { kind: "source"; sourceId: number; name: string; count: number }
  | { kind: "category"; sourceId: number; name: string; count: number }
  | { kind: "channel"; channel: BrowserChannel };

export function SourceBrowser({
  categories,
  results,
  total,
  loading,
  playlistCategories,
  selected,
  onSelect,
  onAdd,
  onAddGroup,
  onAutoSync,
  onAddMatching,
  adding,
}: {
  categories: string[];
  results: BrowserChannel[];
  total: number;
  loading: boolean;
  playlistCategories: EditorCategory[];
  selected: Set<number>;
  onSelect: (id: number, shiftKey: boolean, orderedIds: number[]) => void;
  onAdd: (ids: number[], target: AddTarget) => void;
  onAddGroup: (sourceId: number, categoryName: string) => void;
  onAutoSync: (sourceId: number, categoryName: string, name: string) => void;
  onAddMatching: (target: AddTarget) => void;
  adding: boolean;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedCategories = (searchParams.get("categories") ?? "")
    .split(",")
    .filter(Boolean);
  const q = searchParams.get("q") ?? "";

  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => setSearchInput(q), [q]);
  useEffect(() => {
    if (searchInput === q) return;
    const t = setTimeout(() => {
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
  }, [searchInput, q, setSearchParams]);

  // Auto-sync categories are read-only, so they can't be add targets.
  const addTargets = playlistCategories.filter((c) => !c.auto);

  const [target, setTarget] = useState<string>(
    addTargets[0] ? String(addTargets[0].id) : NEW_CATEGORY,
  );
  const [newName, setNewName] = useState("");
  useEffect(() => {
    if (target === NEW_CATEGORY) return;
    if (!addTargets.some((c) => String(c.id) === target)) {
      setTarget(addTargets[0] ? String(addTargets[0].id) : NEW_CATEGORY);
    }
  }, [playlistCategories, target]);

  // Group results by source, then category. Results arrive ordered by source
  // name then provider order, so insertion order is the display order.
  const sourceGroups = useMemo<SourceGroup[]>(() => {
    const map = new Map<
      number,
      { sourceName: string; cats: Map<string, BrowserChannel[]> }
    >();
    for (const r of results) {
      let s = map.get(r.sourceId);
      if (!s) {
        s = { sourceName: r.sourceName, cats: new Map() };
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
      cats: [...v.cats].map(([name, channels]) => ({ name, channels })),
    }));
  }, [results]);

  const multiSource = sourceGroups.length > 1;
  const categoryCount = sourceGroups.reduce((n, s) => n + s.cats.length, 0);

  // Sources are open by default (track the collapsed ones); category groups are
  // closed by default (track the expanded ones).
  const catKey = (sourceId: number, name: string) => `${sourceId}::${name}`;
  const [collapsedSources, setCollapsedSources] = useState<Set<number>>(new Set());
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const sourceExpanded = (id: number) =>
    !multiSource || !collapsedSources.has(id);
  const catIsExpanded = (sourceId: number, name: string) =>
    expandedCats.has(catKey(sourceId, name));

  function toggleSource(id: number) {
    setCollapsedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleCat(sourceId: number, name: string) {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      const k = catKey(sourceId, name);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // The all-toggle opens/closes the category groups (sources stay as set).
  const anyCatExpanded = expandedCats.size > 0;
  function toggleAll() {
    if (anyCatExpanded) {
      setExpandedCats(new Set());
    } else {
      setCollapsedSources(new Set());
      setExpandedCats(
        new Set(
          sourceGroups.flatMap((s) => s.cats.map((c) => catKey(s.sourceId, c.name))),
        ),
      );
    }
  }

  const flatRows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    for (const s of sourceGroups) {
      if (multiSource) {
        const count = s.cats.reduce((n, c) => n + c.channels.length, 0);
        out.push({ kind: "source", sourceId: s.sourceId, name: s.sourceName, count });
        if (!sourceExpanded(s.sourceId)) continue;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceGroups, multiSource, collapsedSources, expandedCats]);

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
  const hasFilter = q.trim().length > 0 || selectedCategories.length > 0;
  const mode: "selected" | "matching" | null =
    selected.size > 0 ? "selected" : hasFilter && total > 0 ? "matching" : null;
  const targetValid = target !== NEW_CATEGORY || newName.trim().length > 0;
  const canAdd = mode !== null && targetValid;

  function add() {
    const t: AddTarget =
      target === NEW_CATEGORY
        ? { newCategoryName: newName.trim() }
        : { categoryId: Number(target) };
    if (mode === "selected") onAdd(Array.from(selected), t);
    else if (mode === "matching") onAddMatching(t);
    setNewName("");
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
                {anyCatExpanded ? "Collapse all" : "Expand all"}
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
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search all sources..."
              className="h-8 pl-8"
            />
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {results.length === 0 ? (
          <div className="px-4 py-12 text-center text-[13px] text-muted-foreground">
            {loading
              ? "Loading..."
              : hasFilter
                ? "No channels match your filters."
                : "No channels available. Add a source and sync, or enable some categories."}
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
                      onClick={() => toggleSource(row.sourceId)}
                      className="flex w-full cursor-pointer items-center gap-1.5 border-b border-border bg-secondary px-3 py-3 text-left md:py-2"
                    >
                      {collapsedSources.has(row.sourceId) ? (
                        <ChevronRight className="size-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="size-3.5 text-muted-foreground" />
                      )}
                      <Radio className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate text-[13px] font-semibold">
                        {row.name}
                      </span>
                      <span className="ml-auto rounded-full bg-white/[0.06] px-1.5 text-[11px] tabular-nums text-muted-foreground">
                        {row.count.toLocaleString()}
                      </span>
                    </button>
                  ) : row.kind === "category" ? (
                    <div
                      className={cn(
                        "group/grp flex w-full items-center gap-1.5 border-b border-white/5 bg-card px-3 py-3.5 md:py-1.5",
                        multiSource && "pl-4",
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
                    <DraggableSourceRow
                      channel={row.channel}
                      checked={selected.has(row.channel.id)}
                      onSelect={(shiftKey) =>
                        onSelect(row.channel.id, shiftKey, orderedChannelIds)
                      }
                      indented={multiSource}
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

      {mode ? (
        <div className="space-y-2 border-t border-border bg-card px-4 py-3">
          <p className="text-[11px] text-muted-foreground">
            {mode === "selected"
              ? `Drag a channel into a category, or add ${selected.size} selected to:`
              : `Add all ${total.toLocaleString()} matching channels to:`}
          </p>
          <div className="flex items-center gap-2">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger size="sm" className="flex-1">
                <span className="truncate">
                  {target === NEW_CATEGORY
                    ? "+ New category"
                    : (addTargets.find((c) => String(c.id) === target)?.name ??
                      "Target category")}
                </span>
              </SelectTrigger>
              <SelectContent>
                {addTargets.map((cat) => (
                  <SelectItem key={cat.id} value={String(cat.id)}>
                    {cat.name}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_CATEGORY}>+ New category</SelectItem>
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
          {target === NEW_CATEGORY ? (
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New category name"
              className="h-8"
            />
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

function DraggableSourceRow({
  channel,
  checked,
  onSelect,
  indented,
}: {
  channel: BrowserChannel;
  checked: boolean;
  onSelect: (shiftKey: boolean) => void;
  indented?: boolean;
}) {
  // Drag-to-add only makes sense on desktop, where both panes are visible. On
  // mobile the panes are separate, so we drop the drag and let a tap anywhere on
  // the row toggle its checkbox instead.
  const isMobile = useIsMobile();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `src-${channel.id}`,
    data: { type: "source", channel },
    disabled: isMobile,
  });

  return (
    // Desktop: the whole row is the drag handle, the checkbox selects. Mobile:
    // the whole row selects.
    <div
      ref={setNodeRef}
      title={isMobile ? undefined : "Drag into a category"}
      onClick={isMobile ? (e) => onSelect(e.shiftKey) : undefined}
      className={cn(
        "flex items-center gap-2 px-3 py-3.5 transition-colors hover:bg-white/[0.02] md:py-1.5",
        isMobile ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
        indented && "pl-4",
        checked && "bg-primary/5",
        isDragging && "opacity-40",
      )}
      {...(isMobile ? {} : attributes)}
      {...(isMobile ? {} : listeners)}
    >
      <GripVertical className="hidden size-4 shrink-0 text-muted-foreground/40 md:block" />
      {isMobile ? (
        <Checkbox checked={checked} className="pointer-events-none" />
      ) : (
        <span
          onClick={(e) => {
            e.preventDefault();
            onSelect(e.shiftKey);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex cursor-pointer items-center"
        >
          <Checkbox checked={checked} className="pointer-events-none" />
        </span>
      )}
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

// True below the md breakpoint, where the editor shows one pane at a time.
// Starts false and updates after mount so it matches the server's desktop render
// and avoids a hydration mismatch.
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}
