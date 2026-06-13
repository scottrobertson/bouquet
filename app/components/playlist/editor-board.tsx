import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ListVideo, Loader2, Plus, Tv } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "~/components/ui/select";
import { CategoryGroup } from "./category-group";
import { ChannelRowBody } from "./channel-row";
import { SourceBrowser, type AddTarget } from "./source-browser";
import type {
  BrowserChannel,
  EditorCategory,
  EditorChannel,
} from "./types";

type ActiveDrag =
  | { type: "source"; channel: BrowserChannel }
  | { type: "channel"; channel: EditorChannel }
  | { type: "category" }
  | null;

type BrowserData = {
  channels: BrowserChannel[];
  categories: string[];
  total: number;
};

export function EditorBoard({
  playlistId,
  categories,
  channels,
}: {
  playlistId: number;
  categories: EditorCategory[];
  channels: EditorChannel[];
}) {
  const reorderFetcher = useFetcher();
  const reorderCatFetcher = useFetcher();
  const addFetcher = useFetcher();
  const createCatFetcher = useFetcher();
  const bulkFetcher = useFetcher();

  // The source browser loads from its own endpoint (all sources at once),
  // driven by the URL filters, so editing the playlist never reloads it.
  const [searchParams] = useSearchParams();
  const fCategories = searchParams.get("categories") ?? "";
  const fQ = searchParams.get("q") ?? "";
  const browserFetcher = useFetcher<BrowserData>();

  const browserUrl = useMemo(() => {
    const usp = new URLSearchParams();
    if (fCategories) usp.set("categories", fCategories);
    if (fQ) usp.set("q", fQ);
    const qs = usp.toString();
    return `/playlists/${playlistId}/source-channels${qs ? `?${qs}` : ""}`;
  }, [playlistId, fCategories, fQ]);

  useEffect(() => {
    browserFetcher.load(browserUrl);
    // browserFetcher is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserUrl]);

  // Hide just-added channels instantly; cleared when fresh data arrives.
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(new Set());
  useEffect(() => setHiddenIds(new Set()), [browserFetcher.data]);

  // Refetch the browser after an add so the server-side exclude takes over.
  const prevAddState = useRef(addFetcher.state);
  useEffect(() => {
    if (prevAddState.current !== "idle" && addFetcher.state === "idle") {
      browserFetcher.load(browserUrl);
    }
    prevAddState.current = addFetcher.state;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addFetcher.state, browserUrl]);

  const browserResults = (browserFetcher.data?.channels ?? []).filter(
    (c) => !hiddenIds.has(c.id),
  );
  const browserTotal = browserFetcher.data?.total ?? 0;
  const browserCategories = browserFetcher.data?.categories ?? [];
  const browserLoading =
    browserFetcher.state === "loading" || !browserFetcher.data;

  // Optimistic copies so drags feel instant; resync when the loader returns.
  const [items, setItems] = useState(channels);
  useEffect(() => setItems(channels), [channels]);
  const [cats, setCats] = useState(categories);
  useEffect(() => setCats(categories), [categories]);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [active, setActive] = useState<ActiveDrag>(null);
  const [newCategory, setNewCategory] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Pointer-based detection makes dropping a source onto a category reliable,
  // and closestCenter keeps in-list reordering smooth.
  const collisionDetection: CollisionDetection = (args) => {
    const pointer = pointerWithin(args);
    return pointer.length ? pointer : closestCenter(args);
  };

  const byCategory = useMemo(() => {
    const map = new Map<number, EditorChannel[]>();
    for (const cat of cats) map.set(cat.id, []);
    for (const ch of items) map.get(ch.categoryId)?.push(ch);
    return map;
  }, [cats, items]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submitAdd(ids: number[], target: AddTarget) {
    if (ids.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "addChannels");
    for (const id of ids) fd.append("sourceChannelIds", String(id));
    if ("categoryId" in target) fd.set("categoryId", String(target.categoryId));
    else fd.set("newCategoryName", target.newCategoryName);
    addFetcher.submit(fd, { method: "post" });
    setHiddenIds((prev) => new Set([...prev, ...ids]));
    setSelected(new Set());
  }

  // Add a whole source group as a new category named after it.
  function addGroup(sourceId: number, categoryName: string) {
    addFetcher.submit(
      { intent: "addSourceCategory", sourceId: String(sourceId), categoryName },
      { method: "post" },
    );
  }

  // Add every source channel matching the current filter (across all sources).
  function addMatching(target: AddTarget) {
    const fd = new FormData();
    fd.set("intent", "addMatching");
    if (fCategories) fd.set("categories", fCategories);
    if (fQ) fd.set("q", fQ);
    if ("categoryId" in target) fd.set("categoryId", String(target.categoryId));
    else fd.set("newCategoryName", target.newCategoryName);
    addFetcher.submit(fd, { method: "post" });
    setSelected(new Set());
  }

  function categoryFromOver(over: NonNullable<DragEndEvent["over"]>): number | null {
    const d = over.data.current as
      | { type?: string; categoryId?: number; channel?: EditorChannel }
      | undefined;
    if (!d) return null;
    if (d.type === "category" || d.type === "categoryHeader") return Number(d.categoryId);
    if (d.type === "channel" && d.channel) return d.channel.categoryId;
    return null;
  }

  function handleDragStart(e: DragStartEvent) {
    const d = e.active.data.current;
    if (d?.type === "source") setActive({ type: "source", channel: d.channel });
    else if (d?.type === "channel") setActive({ type: "channel", channel: d.channel });
    else if (d?.type === "categoryHeader") setActive({ type: "category" });
  }

  function handleDragEnd(e: DragEndEvent) {
    setActive(null);
    const { active: a, over } = e;
    if (!over) return;
    const type = a.data.current?.type;

    if (type === "source") {
      const sc = a.data.current?.channel as BrowserChannel;
      const categoryId = categoryFromOver(over);
      if (categoryId == null) return;
      const ids = selected.has(sc.id) ? Array.from(selected) : [sc.id];
      submitAdd(ids, { categoryId });
      return;
    }
    if (type === "categoryHeader") {
      reorderCats(a.id, over.id);
      return;
    }
    if (type === "channel") {
      reorderChannels(Number(a.id), over);
    }
  }

  function reorderCats(activeId: string | number, overId: string | number) {
    const from = cats.findIndex((c) => `cat-${c.id}` === String(activeId));
    const to = cats.findIndex((c) => `cat-${c.id}` === String(overId));
    if (from < 0 || to < 0 || from === to) return;
    const next = arrayMove(cats, from, to);
    setCats(next);
    const fd = new FormData();
    fd.set("intent", "reorderCategories");
    for (const c of next) fd.append("categoryIds", String(c.id));
    reorderCatFetcher.submit(fd, { method: "post" });
  }

  function reorderChannels(
    activeId: number,
    over: NonNullable<DragEndEvent["over"]>,
  ) {
    const moved = items.find((c) => c.id === activeId);
    if (!moved) return;

    const overData = over.data.current as
      | { type?: string; channel?: EditorChannel; categoryId?: number }
      | undefined;
    const overChannel = overData?.type === "channel" ? overData.channel : undefined;
    const toCategoryId =
      overData?.type === "category" || overData?.type === "categoryHeader"
        ? Number(overData.categoryId)
        : (overChannel?.categoryId ?? moved.categoryId);

    const next = items.map((c) => ({ ...c }));
    const movedRef = next.find((c) => c.id === activeId)!;
    const fromCategoryId = movedRef.categoryId;
    const without = next.filter((c) => c.id !== activeId);
    movedRef.categoryId = toCategoryId;

    let insertAt: number;
    if (overChannel && overChannel.id !== activeId) {
      insertAt = without.findIndex((c) => c.id === overChannel.id);
      if (insertAt < 0) insertAt = without.length;
    } else {
      const lastIdx = without.map((c) => c.categoryId).lastIndexOf(toCategoryId);
      insertAt = lastIdx < 0 ? without.length : lastIdx + 1;
    }
    without.splice(insertAt, 0, movedRef);

    if (fromCategoryId === toCategoryId) {
      const before = items.filter((c) => c.categoryId === toCategoryId).map((c) => c.id);
      const after = without.filter((c) => c.categoryId === toCategoryId).map((c) => c.id);
      if (before.join(",") === after.join(",")) return;
    }

    setItems(without);

    const order: Record<string, number[]> = {};
    order[toCategoryId] = without
      .filter((c) => c.categoryId === toCategoryId)
      .map((c) => c.id);
    if (fromCategoryId !== toCategoryId) {
      order[fromCategoryId] = without
        .filter((c) => c.categoryId === fromCategoryId)
        .map((c) => c.id);
    }

    reorderFetcher.submit(
      {
        intent: "reorder",
        movedId: activeId,
        toCategoryId,
        order: JSON.stringify(order),
      },
      { method: "post" },
    );
  }

  // Reset the new-category box once the create settles.
  const creatingCat = createCatFetcher.state !== "idle";
  const wasCreating = useRef(false);
  useEffect(() => {
    if (creatingCat) wasCreating.current = true;
    else if (wasCreating.current) {
      wasCreating.current = false;
      setNewCategory("");
    }
  }, [creatingCat]);

  function createCategory() {
    const name = newCategory.trim();
    if (!name) return;
    createCatFetcher.submit(
      { intent: "createCategory", name },
      { method: "post" },
    );
  }

  const adding = addFetcher.state !== "idle";

  // Collapsing categories keeps the DOM small for big playlists.
  const [collapsedCats, setCollapsedCats] = useState<Set<number>>(new Set());
  function toggleCatCollapse(id: number) {
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const allCollapsed = cats.length > 0 && cats.every((c) => collapsedCats.has(c.id));

  // Multi-select of playlist channels for bulk actions.
  const [selectedPl, setSelectedPl] = useState<Set<number>>(new Set());
  const [lastClicked, setLastClicked] = useState<number | null>(null);
  const orderedIds = useMemo(
    () => cats.flatMap((c) => (byCategory.get(c.id) ?? []).map((ch) => ch.id)),
    [cats, byCategory],
  );

  // Drop selections for channels that no longer exist (e.g. after bulk remove).
  useEffect(() => {
    setSelectedPl((prev) => {
      const live = new Set(items.map((i) => i.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  function selectPl(id: number, shiftKey: boolean) {
    if (shiftKey && lastClicked != null) {
      const a = orderedIds.indexOf(lastClicked);
      const b = orderedIds.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = orderedIds.slice(lo, hi + 1);
        setSelectedPl((prev) => new Set([...prev, ...range]));
      }
    } else {
      setSelectedPl((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }
    setLastClicked(id);
  }

  function bulkSubmit(intent: string, extra?: Record<string, string>) {
    if (selectedPl.size === 0) return;
    const fd = new FormData();
    fd.set("intent", intent);
    for (const id of selectedPl) fd.append("channelIds", String(id));
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
    bulkFetcher.submit(fd, { method: "post" });
    setSelectedPl(new Set());
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="grid h-full grid-cols-[minmax(320px,2fr)_3fr] overflow-hidden">
        <div className="min-h-0 border-r border-border">
          <SourceBrowser
            categories={browserCategories}
            results={browserResults}
            total={browserTotal}
            loading={browserLoading}
            playlistCategories={cats}
            selected={selected}
            onToggle={toggle}
            onAdd={submitAdd}
            onAddGroup={addGroup}
            onAddMatching={addMatching}
            adding={adding}
          />
        </div>

        <div className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Playlist
              {adding ? (
                <span className="flex items-center gap-1 normal-case tracking-normal text-primary">
                  <Loader2 className="size-3 animate-spin" />
                  adding
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              {cats.length > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    setCollapsedCats(
                      allCollapsed ? new Set() : new Set(cats.map((c) => c.id)),
                    )
                  }
                  className="cursor-pointer text-[11px] font-medium normal-case tracking-normal text-muted-foreground hover:text-foreground"
                >
                  {allCollapsed ? "Expand all" : "Collapse all"}
                </button>
              ) : null}
              <span className="text-xs tabular-nums text-muted-foreground">
                {cats.length} categories · {items.length} channels
              </span>
            </div>
          </div>

          {selectedPl.size > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2 text-[13px]">
              <span className="text-muted-foreground">
                {selectedPl.size} selected
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => bulkSubmit("bulkToggle", { enabled: "true" })}
              >
                Enable
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => bulkSubmit("bulkToggle", { enabled: "false" })}
              >
                Disable
              </Button>
              <Select
                value=""
                onValueChange={(v) => bulkSubmit("bulkMove", { toCategoryId: v })}
              >
                <SelectTrigger size="sm" className="w-36">
                  <span className="text-muted-foreground">Move to…</span>
                </SelectTrigger>
                <SelectContent>
                  {cats.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => bulkSubmit("bulkResetEpg")}
              >
                Reset EPG
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                  >
                    Remove
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Remove {selectedPl.size} channels?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      They are removed from this playlist. The source catalog is
                      not affected.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => bulkSubmit("bulkRemove")}
                      className="bg-destructive text-white hover:bg-destructive/90"
                    >
                      Remove
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setSelectedPl(new Set())}
              >
                Clear
              </Button>
            </div>
          ) : null}

          <div className="flex-1 overflow-y-auto">
            {cats.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                  <ListVideo className="size-5" />
                </div>
                <p className="text-[13px] text-muted-foreground">
                  Add a category below, then drag channels in from the left.
                </p>
              </div>
            ) : (
              <SortableContext
                items={cats.map((c) => `cat-${c.id}`)}
                strategy={verticalListSortingStrategy}
              >
                {cats.map((cat) => (
                  <CategoryGroup
                    key={cat.id}
                    category={cat}
                    channels={byCategory.get(cat.id) ?? []}
                    playlistId={playlistId}
                    collapsed={collapsedCats.has(cat.id)}
                    onToggleCollapse={() => toggleCatCollapse(cat.id)}
                    selectedChannels={selectedPl}
                    onSelectChannel={selectPl}
                  />
                ))}
              </SortableContext>
            )}
          </div>

          <div className="border-t border-border px-4 py-3">
            <div className="flex gap-2">
              <Input
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    createCategory();
                  }
                }}
                placeholder="New category name"
                className="h-8"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={createCategory}
                disabled={!newCategory.trim() || creatingCat}
              >
                <Plus className="size-4" />
                Add
              </Button>
            </div>
          </div>
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {active?.type === "source" ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-1.5 text-[13px] shadow-lg shadow-black/40">
            <Tv className="size-4 text-muted-foreground" />
            <span className="max-w-[200px] truncate">{active.channel.name}</span>
            {selected.size > 1 && selected.has(active.channel.id) ? (
              <Badge className="bg-primary/15 text-primary">+{selected.size - 1}</Badge>
            ) : null}
          </div>
        ) : active?.type === "channel" ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-1.5 shadow-lg shadow-black/40">
            <ChannelRowBody channel={active.channel} overlay />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
