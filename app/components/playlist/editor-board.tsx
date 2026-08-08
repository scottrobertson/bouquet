import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SafePointerSensor } from "~/lib/dnd-sensors";
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from "@tanstack/react-virtual";
import {
  ListVideo,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import { toast } from "sonner";
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
import { cn } from "~/lib/utils";
import {
  needsSmartSort,
  type SmartSortConfig,
} from "~/services/playlist/smart-sort";
import { buildBoardRows, estimateRowHeight } from "./board-rows";
import {
  AutoChannelRow,
  CategoryHeaderRow,
  EmptyCategoryRow,
  SortableAlternateRow,
  SortablePrimaryRow,
  type GroupApi,
} from "./category-group";
import { ChannelRowBody } from "./channel-row";
import { ChannelTools } from "./channel-tools";
import { PrimaryPicker, suggestedPrimaries } from "./primary-picker";
import { SourceBrowser, type AddTarget } from "./source-browser";
import type {
  AutoChannelView,
  BrowserChannel,
  EditorCategory,
  EditorChannel,
} from "./types";

type ActiveDrag =
  | { type: "channel"; channel: EditorChannel }
  | { type: "category" }
  | null;

type BrowserData = {
  channels: BrowserChannel[];
  categories: string[];
  total: number;
  alreadyAdded: number;
};

// Stand-in for "nothing collapsed", so the filtered view doesn't build a new
// empty Set on every render and re-run the row builder.
const EMPTY_COLLAPSED: Set<number> = new Set();

export function EditorBoard({
  playlistId,
  categories,
  channels,
  autoChannels,
  smartSort,
}: {
  playlistId: number;
  categories: EditorCategory[];
  channels: EditorChannel[];
  autoChannels: Record<number, AutoChannelView[]>;
  smartSort: SmartSortConfig;
}) {
  const reorderFetcher = useFetcher();
  const reorderCatFetcher = useFetcher();
  const addFetcher = useFetcher();
  const createCatFetcher = useFetcher();
  const bulkFetcher = useFetcher();

  // Row callbacks have to keep the same identity across renders or every row
  // re-renders on each keystroke, so they read their fetchers through refs.
  const bulkRef = useRef(bulkFetcher);
  bulkRef.current = bulkFetcher;
  const reorderRef = useRef(reorderFetcher);
  reorderRef.current = reorderFetcher;

  // Confirm the batch actions, which otherwise only show via the save status.
  useFetcherToast(addFetcher, (d) => {
    if (d.intent === "createAutoCategory") return "Auto-sync group created";
    const n = Number(d.added ?? 0);
    if (d.intent === "addAlternates") {
      return n > 0
        ? `Added ${n} alternate${n === 1 ? "" : "s"}`
        : "Those channels are already in this category";
    }
    return n > 0
      ? `Added ${n} channel${n === 1 ? "" : "s"}`
      : "Those channels are already in the playlist";
  });
  useFetcherToast(createCatFetcher, () => "Category created");
  useFetcherToast(bulkFetcher, (d) => BULK_TOAST[d.intent as string] ?? "Done");

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

  // Refetch the browser whenever what the playlist covers changes, so newly
  // covered channels drop out of the source list and removed ones come back.
  // That's the set of added channels plus the auto-sync categories (which cover
  // a whole source category without creating channel rows). Renames and
  // reorders don't change either, so they don't trigger a refetch.
  const channelKey = channels
    .map((c) => c.sourceChannelId)
    .sort((a, b) => a - b)
    .join(",");
  const autoKey = categories
    .filter((c) => c.auto)
    .map((c) => `${c.auto!.sourceId}:${c.auto!.categoryName}`)
    .sort()
    .join(",");
  const coverageKey = `${channelKey}|${autoKey}`;
  const prevCoverageKey = useRef(coverageKey);
  useEffect(() => {
    if (prevCoverageKey.current !== coverageKey) {
      prevCoverageKey.current = coverageKey;
      browserFetcher.load(browserUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverageKey, browserUrl]);

  const browserResults = (browserFetcher.data?.channels ?? []).filter(
    (c) => !hiddenIds.has(c.id),
  );
  const browserTotal = browserFetcher.data?.total ?? 0;
  const browserAlreadyAdded = browserFetcher.data?.alreadyAdded ?? 0;
  const browserCategories = browserFetcher.data?.categories ?? [];
  const browserLoading =
    browserFetcher.state === "loading" || !browserFetcher.data;

  // Optimistic copies so drags feel instant. Resync to fresh loader data during
  // render, not in an effect, so a saved rename or reorder doesn't flash the old
  // value for a frame while the copy catches up.
  const [items, setItems] = useState(channels);
  const [cats, setCats] = useState(categories);
  const [synced, setSynced] = useState({ channels, categories });
  if (synced.channels !== channels || synced.categories !== categories) {
    setSynced({ channels, categories });
    setItems(channels);
    setCats(categories);
  }

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [active, setActive] = useState<ActiveDrag>(null);
  const [newCategory, setNewCategory] = useState("");
  // Which pane shows on mobile. Desktop shows both side by side regardless.
  const [view, setView] = useState<"source" | "playlist">("playlist");

  const sensors = useSensors(
    useSensor(SafePointerSensor, { activationConstraint: { distance: 4 } }),
  );

  // Dropping a playlist channel here removes it from the playlist.
  const removeZone = useDroppable({ id: "remove-zone", data: { type: "removeZone" } });

  // Use the pointer's actual target, falling back to the closest item.
  const collisionDetection: CollisionDetection = (args) => {
    const pointer = pointerWithin(args);
    if (pointer.length) return pointer;
    return closestCenter(args);
  };

  // Only primaries (and standalone channels) sit in a category's draggable
  // list. Alternates render as their own rows below their primary, matched by
  // id, so they follow the primary even mid-drag before the server catches up.
  const byCategory = useMemo(() => {
    const map = new Map<number, EditorChannel[]>();
    for (const cat of cats) map.set(cat.id, []);
    for (const ch of items) {
      if (ch.primaryChannelId == null) map.get(ch.categoryId)?.push(ch);
    }
    return map;
  }, [cats, items]);

  const alternatesByPrimary = useMemo(() => {
    const map = new Map<number, EditorChannel[]>();
    for (const ch of items) {
      if (ch.primaryChannelId == null) continue;
      const list = map.get(ch.primaryChannelId);
      if (list) list.push(ch);
      else map.set(ch.primaryChannelId, [ch]);
    }
    for (const list of map.values())
      list.sort((a, b) => a.altPosition - b.altPosition);
    return map;
  }, [items]);
  const alternatesRef = useRef(alternatesByPrimary);
  alternatesRef.current = alternatesByPrimary;

  // Primaries whose group smart sort would put in a different order, so the row
  // can say so without anyone opening the preview. Everything the sort reads is
  // already on the row, and a group is only a handful of streams, so this is
  // cheap enough to redo on every edit.
  const needsSort = useMemo(() => {
    const flagged = new Set<number>();
    for (const primary of items) {
      if (primary.primaryChannelId != null) continue;
      const alts = alternatesByPrimary.get(primary.id);
      if (!alts?.length) continue;
      const members = [primary, ...alts].map((c) => ({
        ...c,
        available: c.sourceAvailable,
      }));
      if (needsSmartSort(members, smartSort)) flagged.add(primary.id);
    }
    return flagged;
  }, [items, alternatesByPrimary, smartSort]);

  // Auto-sync categories are read-only: nothing can be dropped into them.
  const autoIds = useMemo(
    () => new Set(cats.filter((c) => c.auto).map((c) => c.id)),
    [cats],
  );

  // Source channel selection. Shift+click extends from the last click across the
  // visible rows, matching the playlist side. The browser passes the rows it's
  // showing, in order, so the range only covers what you can see.
  const [lastClickedSrc, setLastClickedSrc] = useState<number | null>(null);
  function selectSource(id: number, shiftKey: boolean, orderedIds: number[]) {
    if (shiftKey && lastClickedSrc != null) {
      const a = orderedIds.indexOf(lastClickedSrc);
      const b = orderedIds.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = orderedIds.slice(lo, hi + 1);
        setSelected((prev) => new Set([...prev, ...range]));
        setLastClickedSrc(id);
        return;
      }
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastClickedSrc(id);
  }

  function submitAdd(ids: number[], target: AddTarget, insertIndex?: number) {
    if (ids.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "addChannels");
    for (const id of ids) fd.append("sourceChannelIds", String(id));
    fd.set("categoryId", String(target.categoryId));
    if (insertIndex != null) fd.set("index", String(insertIndex));
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

  // Create an auto-sync category that mirrors a source category live.
  function addAuto(sourceId: number, categoryName: string, name: string) {
    addFetcher.submit(
      { intent: "createAutoCategory", sourceId: String(sourceId), categoryName, name },
      { method: "post" },
    );
  }

  // Add every source channel matching the current filter (across all sources).
  function addMatching(target: AddTarget) {
    const fd = new FormData();
    fd.set("intent", "addMatching");
    if (fCategories) fd.set("categories", fCategories);
    if (fQ) fd.set("q", fQ);
    fd.set("categoryId", String(target.categoryId));
    addFetcher.submit(fd, { method: "post" });
    setSelected(new Set());
  }

  function handleDragStart(e: DragStartEvent) {
    const d = e.active.data.current;
    if (d?.type === "channel") setActive({ type: "channel", channel: d.channel });
    else if (d?.type === "categoryHeader") setActive({ type: "category" });
  }

  // After a reorder the rows shift under a stationary cursor, but the browser
  // only re-evaluates CSS :hover on pointer movement, so the highlight sticks to
  // the row that used to be there. Briefly dropping pointer-events forces it to
  // re-hit-test the real cursor position.
  const listRef = useRef<HTMLDivElement>(null);
  function clearStuckHover() {
    const el = listRef.current;
    if (!el) return;
    el.style.pointerEvents = "none";
    setTimeout(() => {
      if (listRef.current) listRef.current.style.pointerEvents = "";
    }, 0);
  }

  function handleDragEnd(e: DragEndEvent) {
    setActive(null);
    const { active: a, over } = e;
    if (!over) return;
    const type = a.data.current?.type;

    if (type === "categoryHeader") {
      reorderCats(a.id, over);
      clearStuckHover();
      return;
    }
    if (type === "channel") {
      if (over.data.current?.type === "removeZone") {
        removeFromPlaylist(Number(a.id));
        clearStuckHover();
        return;
      }
      reorderChannels(Number(a.id), over);
      clearStuckHover();
    }
  }

  // Dragged out of the playlist onto the source pane: remove it.
  function removeFromPlaylist(channelId: number) {
    setItems((prev) => prev.filter((c) => c.id !== channelId));
    bulkFetcher.submit(
      { intent: "removeChannel", channelId },
      { method: "post" },
    );
  }

  // Which category a drop landed on, whether you aimed at its header, its empty
  // placeholder, or one of its channels.
  function categoryIdFromOver(over: NonNullable<DragEndEvent["over"]>) {
    const d = over.data.current as
      | { type?: string; channel?: EditorChannel; categoryId?: number }
      | undefined;
    if (d?.type === "category" || d?.type === "categoryHeader")
      return Number(d.categoryId);
    if (d?.type === "channel") return d.channel?.categoryId;
    return undefined;
  }

  function reorderCats(
    activeId: string | number,
    over: NonNullable<DragEndEvent["over"]>,
  ) {
    const from = cats.findIndex((c) => `cat-${c.id}` === String(activeId));
    const overCatId = categoryIdFromOver(over);
    const to = cats.findIndex((c) => c.id === overCatId);
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

    // Drag the whole selection when the grabbed row is part of it, keeping the
    // selected channels in their current order as one block. Only primaries
    // reorder; an alternate follows its primary, so we drop alternates from the
    // moving set.
    const sel =
      selectedPl.has(activeId) && selectedPl.size > 1
        ? new Set(selectedPl)
        : new Set([activeId]);
    const movingIds = items
      .filter((c) => sel.has(c.id) && c.primaryChannelId == null)
      .map((c) => c.id);
    if (!movingIds.length) return;
    const movingSet = new Set(movingIds);

    const overData = over.data.current as
      | { type?: string; channel?: EditorChannel; categoryId?: number }
      | undefined;
    const overChannel = overData?.type === "channel" ? overData.channel : undefined;
    // Dropping onto one of the rows being dragged is a no-op.
    if (overChannel && movingSet.has(overChannel.id)) return;
    const toCategoryId = categoryIdFromOver(over) ?? moved.categoryId;
    // Can't move channels into a read-only auto-sync category.
    if (autoIds.has(toCategoryId)) return;

    // Destination order with the moving channels pulled out, then the block
    // spliced back in at the drop point.
    const destBase = items
      .filter(
        (c) =>
          c.categoryId === toCategoryId &&
          c.primaryChannelId == null &&
          !movingSet.has(c.id),
      )
      .map((c) => c.id);

    let at: number;
    if (overChannel) {
      const overPos = destBase.indexOf(overChannel.id);
      // Direction matters for a same-category move: dnd-kit shows the gap below
      // the row when dragging down, so the block lands after it. (Inserting at
      // the over row's index would put a downward move right back above it.)
      const sameCatList = items
        .filter((c) => c.categoryId === toCategoryId && c.primaryChannelId == null)
        .map((c) => c.id);
      const movingDown =
        moved.categoryId === toCategoryId &&
        sameCatList.indexOf(activeId) < sameCatList.indexOf(overChannel.id);
      at = overPos < 0 ? destBase.length : movingDown ? overPos + 1 : overPos;
    } else {
      at = destBase.length;
    }
    const destOrder = [...destBase.slice(0, at), ...movingIds, ...destBase.slice(at)];

    // Categories the moving channels came from, so we renumber them too.
    const sourceCats = new Set(
      items.filter((c) => movingSet.has(c.id)).map((c) => c.categoryId),
    );

    const order: Record<string, number[]> = { [toCategoryId]: destOrder };
    for (const catId of sourceCats) {
      if (catId === toCategoryId) continue;
      order[catId] = items
        .filter(
          (c) =>
            c.categoryId === catId &&
            c.primaryChannelId == null &&
            !movingSet.has(c.id),
        )
        .map((c) => c.id);
    }

    // Bail if nothing actually moved (same category, same order).
    if (sourceCats.size === 1 && sourceCats.has(toCategoryId)) {
      const before = items
        .filter((c) => c.categoryId === toCategoryId && c.primaryChannelId == null)
        .map((c) => c.id);
      if (before.join(",") === destOrder.join(",")) return;
    }

    // Rebuild the flat list category by category so each bucket matches the
    // order above.
    const byId = new Map(
      items.map((c) => [
        c.id,
        movingSet.has(c.id) ? { ...c, categoryId: toCategoryId } : c,
      ]),
    );
    const next: EditorChannel[] = [];
    for (const cat of cats) {
      const ids = order[cat.id];
      if (ids) {
        for (const id of ids) next.push(byId.get(id)!);
      } else {
        for (const c of items) {
          if (
            c.categoryId === cat.id &&
            c.primaryChannelId == null &&
            !movingSet.has(c.id)
          )
            next.push(c);
        }
      }
    }
    // Alternates aren't in the order map; keep them so they stay nested.
    for (const c of items) if (c.primaryChannelId != null) next.push(c);

    setItems(next);

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

  // Auto-sync categories start collapsed, since they're read-only mirrors of a
  // source.
  const [collapsedCats, setCollapsedCats] = useState<Set<number>>(
    () => new Set(categories.filter((c) => c.auto).map((c) => c.id)),
  );
  const toggleCatCollapse = useCallback((id: number) => {
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const allCollapsed = cats.length > 0 && cats.every((c) => collapsedCats.has(c.id));

  // Alternates are collapsed by default to keep the list compact; track which
  // groups the user has opened. Adding to a group opens it so the result shows.
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const toggleGroup = useCallback((primaryId: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(primaryId)) next.delete(primaryId);
      else next.add(primaryId);
      return next;
    });
  }, []);
  function expandGroup(primaryId: number) {
    setExpandedGroups((prev) =>
      prev.has(primaryId) ? prev : new Set([...prev, primaryId]),
    );
  }

  // Narrows the list to groups smart sort would reorder, so they can be worked
  // through one at a time. Turns itself off once none are left.
  const [onlyNeedsSort, setOnlyNeedsSort] = useState(false);
  const filtering = onlyNeedsSort && needsSort.size > 0;
  useEffect(() => {
    if (needsSort.size === 0) setOnlyNeedsSort(false);
  }, [needsSort]);

  // Turning the filter on opens what it leaves behind. Filtering down to four
  // rows and still having to click each one open would defeat the point.
  function toggleNeedsSortFilter() {
    if (!onlyNeedsSort) {
      setExpandedGroups((prev) => new Set([...prev, ...needsSort]));
      setCollapsedCats((prev) => {
        const next = new Set(prev);
        for (const cat of cats) {
          if ((byCategory.get(cat.id) ?? []).some((ch) => needsSort.has(ch.id)))
            next.delete(cat.id);
        }
        return next;
      });
    }
    setOnlyNeedsSort((v) => !v);
  }

  // Multi-select of playlist channels for bulk actions.
  const [selectedPl, setSelectedPl] = useState<Set<number>>(new Set());
  const [lastClicked, setLastClicked] = useState<number | null>(null);

  // Filter box over the playlist itself. Without it the only way to find a
  // channel you've already added is to scroll the whole list.
  const [plQuery, setPlQuery] = useState("");
  const needle = plQuery.trim().toLowerCase();

  // Everything a channel can be matched on, built once per edit rather than per
  // keystroke.
  const searchText = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of items) {
      map.set(
        c.id,
        [
          c.customName ?? c.sourceName,
          c.sourceName,
          c.sourceProviderName,
          c.sourceCategoryName ?? "",
        ]
          .join(" ")
          .toLowerCase(),
      );
    }
    return map;
  }, [items]);

  // A group matches if the primary or any of its alternates does, so searching
  // an alternate's name still finds the group it lives in.
  const matches = useCallback(
    (primary: EditorChannel) => {
      if ((searchText.get(primary.id) ?? "").includes(needle)) return true;
      return (alternatesByPrimary.get(primary.id) ?? []).some((a) =>
        (searchText.get(a.id) ?? "").includes(needle),
      );
    },
    [searchText, alternatesByPrimary, needle],
  );

  // The list the pane actually renders: categories and channels flattened into
  // one array so it can be virtualised.
  const visibleByCategory = useMemo(() => {
    if (!filtering && !needle) return byCategory;
    const map = new Map<number, EditorChannel[]>();
    for (const [catId, list] of byCategory) {
      let kept = list;
      if (filtering) kept = kept.filter((ch) => needsSort.has(ch.id));
      if (needle) kept = kept.filter(matches);
      if (kept.length) map.set(catId, kept);
    }
    return map;
  }, [byCategory, filtering, needsSort, needle, matches]);

  // Narrowing the list hides rows between the ones you can see, so a drop would
  // land somewhere you didn't point at. Dragging is off while either filter is
  // on.
  const narrowed = filtering || needle.length > 0;

  const visibleCats = useMemo(
    () => (narrowed ? cats.filter((c) => visibleByCategory.has(c.id)) : cats),
    [cats, narrowed, visibleByCategory],
  );

  // Open any group that only matched because of one of its alternates, so the
  // row you searched for is actually on screen.
  const shownGroups = useMemo(() => {
    if (!needle) return expandedGroups;
    const open = new Set(expandedGroups);
    for (const [primaryId, alts] of alternatesByPrimary) {
      if (alts.some((a) => (searchText.get(a.id) ?? "").includes(needle)))
        open.add(primaryId);
    }
    return open;
  }, [expandedGroups, needle, alternatesByPrimary, searchText]);

  // A filter is no use if the category it matched in happens to be collapsed.
  const shownCollapsed = needle ? EMPTY_COLLAPSED : collapsedCats;

  const rows = useMemo(
    () =>
      buildBoardRows({
        categories: visibleCats,
        channelsByCategory: visibleByCategory,
        alternatesByPrimary,
        autoChannels,
        collapsedCats: shownCollapsed,
        expandedGroups: shownGroups,
      }),
    [
      visibleCats,
      visibleByCategory,
      alternatesByPrimary,
      autoChannels,
      shownCollapsed,
      shownGroups,
    ],
  );

  // "Find them in the playlist" on the source side: copy the search over here
  // and, on a phone where only one pane shows at a time, switch to this one.
  const plSearchRef = useRef<HTMLInputElement>(null);
  function showAlreadyAdded(query: string) {
    setPlQuery(query);
    setView("playlist");
    plSearchRef.current?.focus();
  }

  const matchCount = useMemo(
    () =>
      rows.reduce(
        (n, r) => (r.kind === "primary" || r.kind === "alternate" ? n + 1 : n),
        0,
      ),
    [rows],
  );

  // Every id dnd-kit can sort, in the order they appear. Categories and channels
  // share one context because they're interleaved in the flat list.
  const sortableIds = useMemo(
    () =>
      rows.flatMap<UniqueIdentifier>((r) =>
        r.kind === "category"
          ? [r.key]
          : r.kind === "primary"
            ? [r.channel.id]
            : [],
      ),
    [rows],
  );

  // Selectable rows in display order, so a shift+click range spans what's on
  // screen rather than the underlying data order.
  const orderedIds = useMemo(
    () =>
      rows.flatMap((r) =>
        r.kind === "primary" || r.kind === "alternate" ? [r.channel.id] : [],
      ),
    [rows],
  );
  const orderedIdsRef = useRef(orderedIds);
  orderedIdsRef.current = orderedIds;
  const lastClickedRef = useRef(lastClicked);
  lastClickedRef.current = lastClicked;

  // Drop selections for channels that no longer exist (e.g. after bulk remove).
  useEffect(() => {
    setSelectedPl((prev) => {
      const live = new Set(items.map((i) => i.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const selectPl = useCallback((id: number, shiftKey: boolean) => {
    const last = lastClickedRef.current;
    const ordered = orderedIdsRef.current;
    if (shiftKey && last != null) {
      const a = ordered.indexOf(last);
      const b = ordered.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = ordered.slice(lo, hi + 1);
        setSelectedPl((prev) => new Set([...prev, ...range]));
        setLastClicked(id);
        return;
      }
    }
    setSelectedPl((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastClicked(id);
  }, []);

  function bulkSubmit(intent: string, extra?: Record<string, string>) {
    if (selectedPl.size === 0) return;
    const fd = new FormData();
    fd.set("intent", intent);
    for (const id of selectedPl) fd.append("channelIds", String(id));
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
    bulkFetcher.submit(fd, { method: "post" });
    setSelectedPl(new Set());
  }

  // Channels that can be the primary of a group (anything not already an
  // alternate), with their category for context. Used by the "make alternate
  // of…" pickers on both panes.
  const primaries = useMemo(() => {
    const catName = new Map(cats.map((c) => [c.id, c.name]));
    return items
      .filter((c) => c.primaryChannelId == null)
      .map((c) => ({
        id: c.id,
        name: c.customName ?? c.sourceName,
        // Both names count when suggesting a group, since a channel renamed to
        // something short would otherwise stop matching the provider's name.
        names: c.customName ? [c.customName, c.sourceName] : [c.sourceName],
        epgChannelId: c.epgChannelId ?? c.sourceEpgChannelId,
        hint: catName.get(c.categoryId),
      }));
  }, [items, cats]);

  // The channels you've selected in each pane, which is what the suggested alt
  // groups are worked out from.
  const pickedSource = useMemo(
    () =>
      browserResults
        .filter((c) => selected.has(c.id))
        .map((c) => ({ name: c.name, epgChannelId: c.epgChannelId })),
    [browserResults, selected],
  );
  const pickedPlaylist = useMemo(
    () =>
      items
        .filter((c) => selectedPl.has(c.id))
        .map((c) => ({
          name: c.customName ?? c.sourceName,
          epgChannelId: c.epgChannelId ?? c.sourceEpgChannelId,
        })),
    [items, selectedPl],
  );

  const suggestedForSource = useMemo(
    () => suggestedPrimaries(pickedSource, primaries),
    [pickedSource, primaries],
  );
  // A selected channel can still be picked as the primary from the full list,
  // which starts a group from the rest of the selection. It's no use as a
  // suggestion though: with one channel selected, filing it under itself does
  // nothing.
  const suggestedForPlaylist = useMemo(
    () =>
      suggestedPrimaries(
        pickedPlaylist,
        primaries.filter((p) => !selectedPl.has(p.id)),
      ),
    [pickedPlaylist, primaries, selectedPl],
  );

  // Fold the selected playlist channels into a group as alternates of the
  // chosen primary. Picking one of the selected channels makes the rest its
  // alternates (i.e. starts a new group).
  function makeAlternateOf(primaryId: number) {
    const ids = [...selectedPl].filter((id) => id !== primaryId);
    if (!ids.length) return;
    const fd = new FormData();
    fd.set("intent", "makeAlternates");
    fd.set("primaryId", String(primaryId));
    for (const id of ids) fd.append("alternateIds", String(id));
    bulkFetcher.submit(fd, { method: "post" });
    setSelectedPl(new Set());
  }

  // Attach the selected source channels to a primary as alternates. Driven by
  // the per-row "Add alternate" menu.
  function addAlternate(primaryId: number) {
    const ids = [...selected];
    if (!ids.length) return;
    const fd = new FormData();
    fd.set("intent", "addAlternates");
    fd.set("primaryId", String(primaryId));
    for (const id of ids) fd.append("sourceChannelIds", String(id));
    addFetcher.submit(fd, { method: "post" });
    expandGroup(primaryId);
    setHiddenIds((prev) => new Set([...prev, ...ids]));
    setSelected(new Set());
  }

  const ungroupPrimary = useCallback((primaryId: number) => {
    bulkRef.current.submit(
      { intent: "ungroupPrimary", primaryId: String(primaryId) },
      { method: "post" },
    );
  }, []);

  const ungroupAlternate = useCallback((channelId: number) => {
    bulkRef.current.submit(
      { intent: "ungroupAlternate", channelId: String(channelId) },
      { method: "post" },
    );
  }, []);

  // Promote an alternate into the primary spot (the top alternate's "move up").
  // The promoted channel becomes the new primary, so expand it to keep the group
  // open (expandedGroups is keyed by primary id).
  const promoteAlternate = useCallback((channelId: number) => {
    bulkRef.current.submit(
      { intent: "promoteAlternate", channelId: String(channelId) },
      { method: "post" },
    );
    setExpandedGroups((prev) =>
      prev.has(channelId) ? prev : new Set([...prev, channelId]),
    );
  }, []);

  // Move an alternate up or down among its primary's alternates.
  const moveAlternate = useCallback(
    (primaryId: number, channelId: number, dir: -1 | 1) => {
      const list = (alternatesRef.current.get(primaryId) ?? []).map((a) => a.id);
      const from = list.indexOf(channelId);
      const to = from + dir;
      if (from < 0 || to < 0 || to >= list.length) return;
      const next = arrayMove(list, from, to);
      const fd = new FormData();
      fd.set("intent", "reorderAlternates");
      fd.set("primaryId", String(primaryId));
      for (const id of next) fd.append("alternateIds", String(id));
      reorderRef.current.submit(fd, { method: "post" });
    },
    [],
  );

  // Remove a single channel from the playlist (the row's ⋯ → Delete).
  const deleteChannel = useCallback((channelId: number) => {
    bulkRef.current.submit(
      { intent: "removeChannel", channelId: String(channelId) },
      { method: "post" },
    );
  }, []);

  // Stable so the memoised rows only re-render when their own data changes.
  const groupApi = useMemo<GroupApi>(
    () => ({
      dragDisabled: narrowed,
      onToggleGroup: toggleGroup,
      onUngroupPrimary: ungroupPrimary,
      onUngroupAlternate: ungroupAlternate,
      onMoveAlternate: moveAlternate,
      onPromoteAlternate: promoteAlternate,
      onRemove: deleteChannel,
      onSelectChannel: selectPl,
    }),
    [
      narrowed,
      toggleGroup,
      ungroupPrimary,
      ungroupAlternate,
      moveAlternate,
      promoteAlternate,
      deleteChannel,
      selectPl,
    ],
  );

  // Category rows pin to the top as you scroll past them, so you can always see
  // which category you're looking at.
  const categoryRowIndexes = useMemo(
    () =>
      rows.reduce<number[]>((acc, r, i) => {
        if (r.kind === "category") acc.push(i);
        return acc;
      }, []),
    [rows],
  );
  // Index of the row being dragged, so the range extractor can keep it mounted.
  const activeChannelId = active?.type === "channel" ? active.channel.id : null;
  const activeIndexRef = useRef(-1);
  activeIndexRef.current =
    activeChannelId == null
      ? -1
      : rows.findIndex(
          (r) => r.kind === "primary" && r.channel.id === activeChannelId,
        );

  const stickyIndexRef = useRef(-1);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const pinned =
        [...categoryRowIndexes].reverse().find((i) => range.startIndex >= i) ?? -1;
      stickyIndexRef.current = pinned;
      const keep = new Set(defaultRangeExtractor(range));
      if (pinned >= 0) keep.add(pinned);
      // The row being dragged has to stay mounted even once it scrolls out, or
      // dnd-kit loses the drag halfway through.
      if (activeIndexRef.current >= 0) keep.add(activeIndexRef.current);
      return [...keep].sort((a, b) => a - b);
    },
    [categoryRowIndexes],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimateRowHeight(rows[i]),
    getItemKey: (i) => rows[i].key,
    rangeExtractor,
    overscan: 10,
  });

  return (
    <DndContext
      // dnd-kit ids off a module counter that differs between server and client,
      // so without a fixed id the aria-describedby mismatches on hydration.
      id="playlist-editor"
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      // Without this a cancelled drag (Escape, or the row scrolling out of the
      // list mid-drag) leaves the "drop here to remove" overlay stuck on screen.
      onDragCancel={() => setActive(null)}
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden md:grid md:grid-cols-[minmax(320px,2fr)_3fr]">
        {/* Mobile pane switcher. The two panes can't sit side by side on a
            phone, so this toggles which one is shown. */}
        <div className="flex shrink-0 gap-1 border-b border-border p-2 md:hidden">
          {(["source", "playlist"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium capitalize transition-colors",
                view === v
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {v === "source" ? "Source channels" : "Playlist"}
            </button>
          ))}
        </div>

        <div
          ref={removeZone.setNodeRef}
          className={cn(
            "relative min-h-0 border-border md:block md:border-r",
            view === "source" ? "block flex-1" : "hidden",
          )}
        >
          <SourceBrowser
            categories={browserCategories}
            results={browserResults}
            total={browserTotal}
            alreadyAdded={browserAlreadyAdded}
            loading={browserLoading}
            onShowAlreadyAdded={showAlreadyAdded}
            playlistCategories={cats}
            primaries={primaries}
            suggested={suggestedForSource}
            selected={selected}
            onSelect={selectSource}
            onAdd={submitAdd}
            onAddGroup={addGroup}
            onAutoSync={addAuto}
            onAddMatching={addMatching}
            onAddAlternateOf={addAlternate}
            adding={adding}
          />
          {active?.type === "channel" ? (
            <div
              className={cn(
                "pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed transition-colors",
                removeZone.isOver
                  ? "border-destructive bg-destructive/15 text-destructive"
                  : "border-border/60 bg-background/70 text-muted-foreground",
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-medium">
                <Trash2 className="size-4" />
                Drop here to remove
              </span>
            </div>
          ) : null}
        </div>

        <div
          className={cn(
            "relative min-h-0 flex-col md:flex",
            view === "playlist" ? "flex flex-1" : "hidden",
          )}
        >
          <div className="border-b border-border px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
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
                {needsSort.size > 0 ? (
                  <button
                    type="button"
                    onClick={toggleNeedsSortFilter}
                    className={cn(
                      "flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal",
                      filtering
                        ? "bg-primary text-primary-foreground"
                        : "bg-primary/15 text-primary hover:bg-primary/25",
                    )}
                  >
                    <Sparkles className="size-3" />
                    {needsSort.size} need{needsSort.size === 1 ? "s" : ""} sorting
                  </button>
                ) : null}
                {cats.length > 0 && !narrowed ? (
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedCats(
                        allCollapsed
                          ? new Set()
                          : new Set(cats.map((c) => c.id)),
                      )
                    }
                    className="cursor-pointer text-[11px] font-medium normal-case tracking-normal text-muted-foreground hover:text-foreground"
                  >
                    {allCollapsed ? "Expand all" : "Collapse all"}
                  </button>
                ) : null}
                <span className="text-xs tabular-nums text-muted-foreground">
                  {needle
                    ? `${matchCount.toLocaleString()} of ${items.length.toLocaleString()} channels`
                    : `${cats.length} categories · ${items.length} channels`}
                </span>
              </div>
            </div>
            <div className="flex gap-2">
              <div className="relative w-1/2">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={plSearchRef}
                  value={plQuery}
                  onChange={(e) => setPlQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      if (plQuery) setPlQuery("");
                      else e.currentTarget.blur();
                    }
                  }}
                  placeholder="Filter this playlist..."
                  className="h-8 px-8"
                />
                {plQuery ? (
                  <button
                    type="button"
                    onClick={() => setPlQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                    aria-label="Clear filter"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
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
                className="h-8 flex-1"
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

          {selectedPl.size > 0 ? (
            <div className="absolute inset-x-0 bottom-6 z-30 mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center justify-center gap-2 rounded-2xl border border-border bg-card/95 px-4 py-2.5 text-[13px] shadow-lg shadow-black/40 backdrop-blur duration-150 animate-in fade-in slide-in-from-bottom-2">
              <span className="text-muted-foreground">
                {selectedPl.size} selected
              </span>
              <Select
                value=""
                onValueChange={(v) => bulkSubmit("bulkMove", { toCategoryId: v })}
              >
                <SelectTrigger size="sm" className="w-36">
                  <span className="text-muted-foreground">Move to…</span>
                </SelectTrigger>
                <SelectContent>
                  {cats
                    .filter((c) => !c.auto)
                    .map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <PrimaryPicker
                primaries={primaries}
                suggested={suggestedForPlaylist}
                onPick={makeAlternateOf}
                label="Make alternate of…"
              />
              <ChannelTools count={selectedPl.size} onRun={bulkSubmit} />
              <div className="mx-0.5 h-5 w-px bg-border" />
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
                className="ml-1"
                onClick={() => setSelectedPl(new Set())}
              >
                Clear
              </Button>
            </div>
          ) : null}

          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            {cats.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                  <ListVideo className="size-5" />
                </div>
                <p className="text-[13px] text-muted-foreground">
                  Add a category above, then drag channels in from the left.
                </p>
              </div>
            ) : rows.length === 0 ? (
              <div className="px-4 py-12 text-center text-[13px] text-muted-foreground">
                No channels in this playlist match “{plQuery.trim()}”.
              </div>
            ) : (
              <SortableContext
                items={sortableIds}
                strategy={verticalListSortingStrategy}
              >
                <div
                  ref={listRef}
                  className="relative w-full"
                  style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                >
                  {rowVirtualizer.getVirtualItems().map((vi) => {
                    const row = rows[vi.index];
                    const pinned = vi.index === stickyIndexRef.current;
                    return (
                      <div
                        key={vi.key}
                        data-index={vi.index}
                        ref={rowVirtualizer.measureElement}
                        className="left-0 top-0 w-full"
                        style={
                          pinned
                            ? { position: "sticky", zIndex: 10 }
                            : {
                                position: "absolute",
                                transform: `translateY(${vi.start}px)`,
                              }
                        }
                      >
                        <BoardRowView
                          row={row}
                          playlistId={playlistId}
                          selectedPl={selectedPl}
                          needsSort={needsSort}
                          activeChannelId={activeChannelId}
                          groupApi={groupApi}
                          onToggleCollapse={toggleCatCollapse}
                        />
                      </div>
                    );
                  })}
                </div>
              </SortableContext>
            )}
          </div>
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {active?.type === "channel" ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-1.5 shadow-lg shadow-black/40">
            <ChannelRowBody channel={active.channel} overlay />
            {selectedPl.size > 1 && selectedPl.has(active.channel.id) ? (
              <Badge className="bg-primary/15 text-primary">
                +{selectedPl.size - 1}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/** Picks the component for one flat row. Kept tiny so the memo on each row
    component is what decides whether it re-renders. */
function BoardRowView({
  row,
  playlistId,
  selectedPl,
  needsSort,
  activeChannelId,
  groupApi,
  onToggleCollapse,
}: {
  row: ReturnType<typeof buildBoardRows>[number];
  playlistId: number;
  selectedPl: Set<number>;
  needsSort: Set<number>;
  activeChannelId: number | null;
  groupApi: GroupApi;
  onToggleCollapse: (categoryId: number) => void;
}) {
  switch (row.kind) {
    case "category":
      return (
        <CategoryHeaderRow
          category={row.category}
          count={row.count}
          collapsed={row.collapsed}
          dragDisabled={groupApi.dragDisabled}
          onToggleCollapse={onToggleCollapse}
        />
      );
    case "empty":
      return <EmptyCategoryRow categoryId={row.categoryId} auto={row.auto} />;
    case "auto":
      return <AutoChannelRow channel={row.channel} />;
    case "primary":
      return (
        <SortablePrimaryRow
          channel={row.channel}
          alternates={row.alternates}
          playlistId={playlistId}
          collapsed={row.collapsed}
          selected={selectedPl.has(row.channel.id)}
          needsSort={needsSort.has(row.channel.id)}
          groupApi={groupApi}
        />
      );
    case "alternate":
      return (
        <SortableAlternateRow
          channel={row.channel}
          primary={row.primary}
          index={row.index}
          total={row.total}
          playlistId={playlistId}
          selected={selectedPl.has(row.channel.id)}
          dimmed={activeChannelId === row.primary.id}
          groupApi={groupApi}
        />
      );
  }
}

const BULK_TOAST: Record<string, string> = {
  bulkToggle: "Channels updated",
  bulkMove: "Channels moved",
  bulkRemove: "Channels removed",
  bulkSort: "Channels sorted",
  bulkResetEpg: "EPG reset to source default",
  bulkPrefix: "Names updated",
  bulkSuffix: "Names updated",
  bulkReplace: "Names updated",
  removeChannel: "Channel removed",
  makeAlternates: "Grouped as alternates",
  promoteAlternate: "Made primary",
  ungroupPrimary: "Ungrouped",
  ungroupAlternate: "Removed from group",
};

type ActionResult = {
  ok?: boolean;
  error?: string;
  intent?: string;
  added?: number;
};

/** Toast once when a fetcher action settles: the message on success, the error
    on failure. Keyed on the response object so it fires once per result. */
function useFetcherToast(
  fetcher: ReturnType<typeof useFetcher>,
  message: (data: ActionResult) => string,
) {
  const last = useRef<unknown>(null);
  useEffect(() => {
    const d = fetcher.data as ActionResult | undefined;
    if (fetcher.state !== "idle" || !d || d === last.current) return;
    last.current = d;
    if (d.ok === false) toast.error(d.error ?? "Something went wrong");
    else toast.success(message(d));
  }, [fetcher.state, fetcher.data, message]);
}
