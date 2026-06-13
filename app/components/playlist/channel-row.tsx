import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Pencil, RotateCcw, Trash2, Tv } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Switch } from "~/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { logoSrc } from "~/lib/logo";
import { cn } from "~/lib/utils";
import { EpgPicker } from "./epg-picker";
import type { EditorChannel } from "./types";

export function SortableChannelRow({
  channel,
  playlistId,
  selected,
  onSelect,
}: {
  channel: EditorChannel;
  playlistId: number;
  selected: boolean;
  onSelect: (id: number, shiftKey: boolean) => void;
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
  } = useSortable({ id: channel.id, data: { type: "channel", channel } });

  // Only show the insert line when adding from the source list (it lands above
  // this row). For reordering, dnd-kit already shifts the rows to show the gap.
  const insertAbove = isOver && active?.data.current?.type === "source";
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    boxShadow: insertAbove ? "inset 0 2px 0 0 var(--primary)" : undefined,
  };

  return (
    // The whole row is the drag handle. Interactive controls below stop
    // propagation so they click/toggle instead of starting a drag.
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group/row flex cursor-grab items-center gap-1.5 border-b border-white/5 px-2 py-2 transition-colors hover:bg-white/[0.02] active:cursor-grabbing sm:gap-2 sm:px-3",
        selected && "bg-primary/5",
        isDragging && "opacity-50",
      )}
      {...attributes}
      {...listeners}
    >
      {/* The whole row is the drag handle; the grip is just an affordance, so
          hide it on mobile to claw back width. */}
      <GripVertical className="hidden size-4 shrink-0 text-muted-foreground/50 sm:block" />
      <span
        onClick={(e) => {
          e.preventDefault();
          onSelect(channel.id, e.shiftKey);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex cursor-pointer items-center"
      >
        <Checkbox checked={selected} className="pointer-events-none" />
      </span>
      <ChannelRowBody channel={channel} playlistId={playlistId} />
    </div>
  );
}

/** Static body, also used by the drag overlay. */
export function ChannelRowBody({
  channel,
  playlistId,
  overlay,
}: {
  channel: EditorChannel;
  playlistId?: number;
  overlay?: boolean;
}) {
  const fetcher = useFetcher();
  const logo = channel.customLogo ?? channel.sourceLogo;
  const displayName = channel.customName ?? channel.sourceName;

  // Optimistic enabled state so the toggle never waits on the server.
  const submittedEnabled =
    fetcher.formData?.get("intent") === "toggleChannel"
      ? fetcher.formData.get("enabled") === "true"
      : undefined;
  const enabled = submittedEnabled ?? channel.enabled;
  const renamed =
    !!channel.customName && channel.customName !== channel.sourceName;

  return (
    <>
      {/* Logo is hidden on mobile to give the name room. */}
      {logo ? (
        <img
          src={logoSrc(logo)}
          alt=""
          loading="lazy"
          onError={(e) => {
            e.currentTarget.style.visibility = "hidden";
          }}
          className="hidden size-7 shrink-0 rounded object-contain sm:block"
        />
      ) : (
        <div className="hidden size-7 shrink-0 items-center justify-center rounded bg-secondary text-muted-foreground sm:flex">
          <Tv className="size-3.5" />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <NameField channel={channel} displayName={displayName} disabled={overlay} />
        </div>
        <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span className="shrink-0">{channel.sourceProviderName}</span>
          <span className="shrink-0 text-muted-foreground/50">·</span>
          <span className="min-w-0 truncate">
            {channel.sourceCategoryName ?? "Uncategorised"}
          </span>
        </div>
        {renamed ? (
          <div
            className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"
            title={`Renamed from ${channel.sourceName}`}
          >
            <Pencil className="size-3 shrink-0" />
            <span className="min-w-0 truncate">“{channel.sourceName}”</span>
          </div>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        {!channel.sourceAvailable || !channel.sourceCategoryEnabled ? (
          <div className="flex shrink-0 items-center gap-1">
            {!channel.sourceAvailable ? (
              <Badge className="border-transparent bg-warning/10 text-warning">
                Unavailable
              </Badge>
            ) : null}
            {!channel.sourceCategoryEnabled ? (
              <Badge className="border-transparent bg-muted text-muted-foreground">
                Category off
              </Badge>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-0.5">
        {!overlay && renamed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="hidden size-7 cursor-pointer text-muted-foreground hover:text-foreground sm:inline-flex"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() =>
                  fetcher.submit(
                    { intent: "renameChannel", channelId: channel.id, customName: "" },
                    { method: "post" },
                  )
                }
              >
                <RotateCcw className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Revert to source name</TooltipContent>
          </Tooltip>
        ) : null}
        {overlay || playlistId == null ? null : (
          <span
            onPointerDown={(e) => e.stopPropagation()}
            className="hidden sm:inline-flex"
          >
            <EpgPicker channel={channel} playlistId={playlistId} fetcher={fetcher} />
          </span>
        )}
        <Switch
          checked={enabled}
          disabled={overlay}
          onPointerDown={(e) => e.stopPropagation()}
          onCheckedChange={(v) =>
            fetcher.submit(
              { intent: "toggleChannel", channelId: channel.id, enabled: String(v) },
              { method: "post" },
            )
          }
        />
        {overlay ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 cursor-pointer text-muted-foreground hover:text-destructive"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() =>
              fetcher.submit(
                { intent: "removeChannel", channelId: channel.id },
                { method: "post" },
              )
            }
          >
            <Trash2 className="size-4" />
          </Button>
        )}
        </div>
      </div>
    </>
  );
}

function NameField({
  channel,
  displayName,
  disabled,
}: {
  channel: EditorChannel;
  displayName: string;
  disabled?: boolean;
}) {
  const fetcher = useFetcher();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(displayName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setValue(displayName);
  }, [displayName, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Optimistic name from an in-flight save.
  const submittedName =
    fetcher.formData?.get("intent") === "renameChannel"
      ? (fetcher.formData.get("customName") as string)
      : undefined;
  const shown =
    submittedName !== undefined
      ? submittedName.trim() || channel.sourceName
      : displayName;

  function save() {
    setEditing(false);
    const next = value.trim();
    if (next === displayName) return;
    fetcher.submit(
      { intent: "renameChannel", channelId: channel.id, customName: next },
      { method: "post" },
    );
  }

  if (editing && !disabled) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setValue(displayName);
            setEditing(false);
          }
        }}
        className="-mx-1.5 min-w-0 flex-1 rounded-sm bg-white/[0.06] px-1.5 text-[13px] leading-[1.4] outline-none ring-1 ring-ring/60"
      />
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setEditing(true)}
      className={cn(
        "min-w-0 flex-1 truncate text-left text-[13px]",
        channel.customName && channel.customName !== channel.sourceName
          ? "font-medium"
          : "",
      )}
      title="Click to rename"
    >
      {shown}
    </button>
  );
}
