import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  RefreshCw,
  Trash2,
  Tv,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { logoSrc } from "~/lib/logo";
import { cn } from "~/lib/utils";
import { SortableChannelRow } from "./channel-row";
import type { AutoChannelView, EditorCategory, EditorChannel } from "./types";

export function CategoryGroup({
  category,
  channels,
  autoChannels,
  playlistId,
  collapsed,
  onToggleCollapse,
  selectedChannels,
  onSelectChannel,
}: {
  category: EditorCategory;
  channels: EditorChannel[];
  autoChannels: AutoChannelView[];
  playlistId: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  selectedChannels: Set<number>;
  onSelectChannel: (id: number, shiftKey: boolean) => void;
}) {
  const auto = category.auto;
  const isAuto = auto != null;
  const count = isAuto ? autoChannels.length : channels.length;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: `cat-${category.id}`, data: { type: "categoryHeader", categoryId: category.id } });

  // Channels drop into the category container itself when it has no rows to land
  // on. Auto categories are read-only, so we never attach this as a drop target.
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `category-${category.id}`,
    data: { type: "category", categoryId: category.id },
  });

  const style = { transform: CSS.Translate.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("border-b-2 border-border", isDragging && "opacity-60")}
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-border bg-secondary px-3 py-2.5">
        <button
          type="button"
          className="cursor-grab text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <button
          type="button"
          onClick={onToggleCollapse}
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
        <div className="ml-auto">
          <DeleteCategory category={category} count={count} />
        </div>
      </div>

      {collapsed ? (
        // Normal categories stay a drop target when collapsed (drop on the header
        // adds here). Auto categories never accept drops.
        isAuto ? null : (
          <div ref={setDropRef} className={cn("h-0", isOver && "h-1 bg-primary")} />
        )
      ) : isAuto ? (
        <AutoChannelList channels={autoChannels} />
      ) : (
        <div
          ref={setDropRef}
          className={cn(
            "min-h-[10px] border-l-2 border-transparent",
            isOver && "border-primary bg-primary/5",
          )}
        >
          <SortableContext
            items={channels.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {channels.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                Drop channels here.
              </div>
            ) : (
              channels.map((ch) => (
                <SortableChannelRow
                  key={ch.id}
                  channel={ch}
                  playlistId={playlistId}
                  selected={selectedChannels.has(ch.id)}
                  onSelect={onSelectChannel}
                />
              ))
            )}
          </SortableContext>
        </div>
      )}
    </div>
  );
}

/** Read-only channel list for an auto-sync category. */
function AutoChannelList({ channels }: { channels: AutoChannelView[] }) {
  if (channels.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-xs text-muted-foreground">
        No channels in this category right now. They appear as the provider adds them.
      </div>
    );
  }
  return (
    <div>
      {channels.map((ch) => (
        <div
          key={ch.sourceChannelId}
          className="flex items-center gap-2 border-b border-white/5 px-3 py-2"
        >
          {ch.logo ? (
            <img
              src={logoSrc(ch.logo)}
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
          <span className="min-w-0 flex-1 truncate text-[13px]">{ch.name}</span>
        </div>
      ))}
    </div>
  );
}

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

function DeleteCategory({
  category,
  count,
}: {
  category: EditorCategory;
  count: number;
}) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-4" />
      </Button>
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
