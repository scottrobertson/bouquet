import { useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  Gauge,
  GripVertical,
  MoreVertical,
  RefreshCw,
  Trash2,
  Tv,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { logoSrc } from "~/lib/logo";
import { cn } from "~/lib/utils";
import { AlternateRow, PrimaryRow } from "./channel-row";
import type { AutoChannelView, EditorCategory, EditorChannel } from "./types";

/** Group actions wired up by the board, applied per primary/alternate here. */
export type GroupApi = {
  // True while the list is filtered down to a subset of rows. Dropping a row
  // between two that are far apart in the real list would move it somewhere you
  // didn't point at, so dragging is off.
  dragDisabled: boolean;
  onToggleGroup: (primaryId: number) => void;
  onUngroupPrimary: (primaryId: number) => void;
  onUngroupAlternate: (channelId: number) => void;
  onMoveAlternate: (primaryId: number, channelId: number, dir: -1 | 1) => void;
  onPromoteAlternate: (channelId: number) => void;
  onRemove: (channelId: number) => void;
  onSelectChannel: (id: number, shiftKey: boolean) => void;
};

/** A category header. Drags to reorder categories, and accepts channels dropped
    straight onto it (they land at the end of the category). */
export const CategoryHeaderRow = memo(function CategoryHeaderRow({
  category,
  count,
  collapsed,
  dragDisabled,
  onToggleCollapse,
}: {
  category: EditorCategory;
  count: number;
  collapsed: boolean;
  dragDisabled: boolean;
  onToggleCollapse: (categoryId: number) => void;
}) {
  const auto = category.auto;
  const isAuto = auto != null;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: `cat-${category.id}`,
      data: { type: "categoryHeader", categoryId: category.id },
      disabled: dragDisabled,
    });

  // Auto categories are read-only mirrors of a source, so nothing drops in.
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `category-${category.id}`,
    data: { type: "category", categoryId: category.id },
    disabled: isAuto,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("border-t-2 border-border", isDragging && "opacity-60")}
    >
      <div
        ref={setDropRef}
        className={cn(
          "flex items-center gap-2 border-y border-border bg-secondary px-3 py-2.5",
          isOver && "bg-primary/15",
        )}
      >
        {dragDisabled ? null : (
          <button
            type="button"
            className="cursor-grab text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onToggleCollapse(category.id)}
          className="cursor-pointer text-muted-foreground hover:text-foreground"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? (
            <ChevronRight className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          )}
        </button>
        <CategoryName category={category} />
        <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
        {isAuto ? (
          <span
            className="flex min-w-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
            title={`Auto-syncs ${auto.sourceName} / ${auto.categoryName}`}
          >
            <RefreshCw className="size-3 shrink-0" />
            <span className="truncate">
              {auto.sourceName} / {auto.categoryName}
            </span>
          </span>
        ) : null}
        {isAuto && !auto.enabled ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            Source off
          </span>
        ) : null}
        <div className="ml-auto">
          <CategoryMenu category={category} count={count} />
        </div>
      </div>
    </div>
  );
});

/** Stand-in row for a category with nothing in it. Doubles as the drop target,
    since there are no channel rows to aim at. */
export const EmptyCategoryRow = memo(function EmptyCategoryRow({
  categoryId,
  auto,
}: {
  categoryId: number;
  auto: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `category-${categoryId}-empty`,
    data: { type: "category", categoryId },
    disabled: auto,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "border-b border-white/5 px-3 py-4 text-center text-xs text-muted-foreground",
        isOver && "bg-primary/5 text-primary",
      )}
    >
      {auto
        ? "No channels in this category right now. They appear as the provider adds them."
        : "Drop channels here."}
    </div>
  );
});

/** A channel inside an auto-sync category. Read-only, so no controls. */
export const AutoChannelRow = memo(function AutoChannelRow({
  channel,
}: {
  channel: AutoChannelView;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
      {channel.logo ? (
        <img
          src={logoSrc(channel.logo)}
          alt=""
          loading="lazy"
          onError={(e) => {
            e.currentTarget.style.visibility = "hidden";
          }}
          className="size-7 shrink-0 rounded object-contain"
        />
      ) : (
        <div className="flex size-7 shrink-0 items-center justify-center rounded bg-secondary text-muted-foreground">
          <Tv className="size-3.5" />
        </div>
      )}
      <span className="min-w-0 flex-1 truncate text-[13px]">{channel.name}</span>
    </div>
  );
});

/** A primary channel row wired into dnd-kit. Alternates render as their own
    rows below, so the sortable only covers the primary itself. */
export const SortablePrimaryRow = memo(function SortablePrimaryRow({
  channel,
  alternates,
  playlistId,
  collapsed,
  selected,
  needsSort,
  groupApi,
}: {
  channel: EditorChannel;
  alternates: EditorChannel[];
  playlistId: number;
  collapsed: boolean;
  selected: boolean;
  needsSort: boolean;
  groupApi: GroupApi;
}) {
  const {
    active,
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id: channel.id,
    data: { type: "channel", channel },
    disabled: groupApi.dragDisabled,
  });

  // Show the insert line only when adding from the source list (it lands above
  // this group). Reordering already shows dnd-kit's gap.
  const insertAbove = isOver && active?.data.current?.type === "source";

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "opacity-50")}
    >
      <PrimaryRow
        channel={channel}
        playlistId={playlistId}
        selected={selected}
        onSelect={groupApi.onSelectChannel}
        alternates={alternates}
        dragHandleProps={{ ...attributes, ...listeners }}
        insertAbove={insertAbove}
        group={{
          isAlternate: false,
          hasAlternates: alternates.length > 0,
          altCount: alternates.length,
          needsSort,
          dragDisabled: groupApi.dragDisabled,
          collapsed,
          onToggleCollapse: () => groupApi.onToggleGroup(channel.id),
          onUngroupPrimary: () => groupApi.onUngroupPrimary(channel.id),
          onUngroupAlternate: () => {},
          canMoveUp: false,
          canMoveDown: false,
          onMove: () => {},
          onDelete: () => groupApi.onRemove(channel.id),
        }}
      />
    </div>
  );
});

/** An alternate nested under its primary. Static: reordering, ungrouping and
    removing happen from its menu. */
export const SortableAlternateRow = memo(function SortableAlternateRow({
  channel,
  primary,
  index,
  total,
  playlistId,
  selected,
  dimmed,
  groupApi,
}: {
  channel: EditorChannel;
  primary: EditorChannel;
  index: number;
  total: number;
  playlistId: number;
  selected: boolean;
  // True while the primary is being dragged, so the whole group fades together.
  dimmed: boolean;
  groupApi: GroupApi;
}) {
  return (
    <div className={cn(dimmed && "opacity-50")}>
      <AlternateRow
        channel={channel}
        playlistId={playlistId}
        selected={selected}
        onSelect={groupApi.onSelectChannel}
        group={{
          isAlternate: true,
          primaryEnabled: primary.enabled,
          hasAlternates: false,
          altCount: 0,
          collapsed: false,
          onToggleCollapse: () => {},
          onUngroupPrimary: () => {},
          onUngroupAlternate: () => groupApi.onUngroupAlternate(channel.id),
          // The top alternate moves up into the primary spot; others reorder
          // within the alternates.
          canMoveUp: true,
          canMoveDown: index < total - 1,
          willPromote: index === 0,
          onMove: (dir) => {
            if (dir === -1 && index === 0)
              groupApi.onPromoteAlternate(channel.id);
            else groupApi.onMoveAlternate(primary.id, channel.id, dir);
          },
          onDelete: () => groupApi.onRemove(channel.id),
        }}
      />
    </div>
  );
});

function CategoryName({ category }: { category: EditorCategory }) {
  const fetcher = useFetcher();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(category.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setValue(category.name);
  }, [category.name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Optimistic name while a rename is in flight.
  const submitted =
    fetcher.formData?.get("intent") === "renameCategory"
      ? (fetcher.formData.get("name") as string)
      : undefined;
  const shown = submitted?.trim() || category.name;

  function save() {
    setEditing(false);
    const next = value.trim();
    if (!next || next === category.name) {
      setValue(category.name);
      return;
    }
    fetcher.submit(
      { intent: "renameCategory", categoryId: category.id, name: next },
      { method: "post" },
    );
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setValue(category.name);
            setEditing(false);
          }
        }}
        className="rounded border border-input bg-transparent px-1.5 py-0.5 text-[13px] font-medium outline-none focus:border-ring"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="text-[13px] font-semibold hover:text-primary"
      title="Click to rename"
    >
      {shown}
    </button>
  );
}

/** The category header ⋯ menu: probe the whole category (not on auto categories,
    which have no playlist channels) and delete it. */
function CategoryMenu({
  category,
  count,
}: {
  category: EditorCategory;
  count: number;
}) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);
  const isAuto = category.auto != null;
  const probing = fetcher.formData?.get("intent") === "probeCategory";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            // Icon stays small but the tap target stretches to ~44px so it's easy to hit on mobile.
            className="relative size-7 cursor-pointer text-muted-foreground before:absolute before:-inset-2 before:content-[''] hover:text-foreground"
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!isAuto ? (
            <>
              <DropdownMenuItem
                disabled={probing || count === 0}
                onClick={() =>
                  fetcher.submit(
                    { intent: "probeCategory", categoryId: category.id },
                    { method: "post" },
                  )
                }
              >
                <Gauge className="size-4" />
                {probing ? "Probing…" : "Probe category"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem
            onClick={() => setOpen(true)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {category.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {count > 0
                ? `This removes the category and its ${count} ${count === 1 ? "channel" : "channels"} from the playlist.`
                : "This removes the category from the playlist."}{" "}
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                fetcher.submit(
                  { intent: "deleteCategory", categoryId: category.id },
                  { method: "post" },
                )
              }
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
