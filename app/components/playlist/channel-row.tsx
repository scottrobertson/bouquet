import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  Eye,
  EyeOff,
  Gauge,
  GripVertical,
  Loader2,
  MoreVertical,
  Pencil,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  Tv,
  Unlink,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { logoSrc } from "~/lib/logo";
import { cleanProbeError, qualityMeta } from "~/lib/quality";
import { cn } from "~/lib/utils";
import { EpgPicker } from "./epg-picker";
import { SmartSortDialog } from "./smart-sort-dialog";
import type { EditorChannel } from "./types";

/** Stream quality below the provider/category line. Shows a live waiting/probing
    state while a probe is in flight, the result when we have one, a quiet note
    when the last probe failed, and nothing when the channel was never probed (so
    unprobed lists stay clean). `probing` is the row's own in-flight probe, which
    the server status doesn't reflect until the next poll. */
function QualityLine({
  channel,
  probing,
}: {
  channel: EditorChannel;
  probing?: boolean;
}) {
  if (probing || channel.probeStatus === "probing") {
    return (
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Probing…
      </div>
    );
  }

  if (channel.probeStatus === "queued") {
    return (
      <div className="text-[11px] text-muted-foreground/60">Queued…</div>
    );
  }

  if (channel.probeStatus === "error" || channel.probeStatus === "timeout") {
    const label =
      channel.probeStatus === "timeout" ? "Probe timed out" : "Probe failed";
    const detail = cleanProbeError(channel.probeError)?.trim();
    // The timeout message is the same as the label, so don't repeat it.
    const text = detail && detail !== label ? `${label}: ${detail}` : label;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="truncate text-[11px] text-muted-foreground/60">
            {text}
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{text}</TooltipContent>
      </Tooltip>
    );
  }

  const meta = qualityMeta(channel);
  if (!meta) return null;

  const parts = [
    ...(meta.resolution ? [meta.resolution.label] : []),
    ...meta.details,
    ...(meta.bitrate ? [meta.bitrate] : []),
  ];

  return (
    <div className="flex min-w-0 items-center gap-1 truncate text-[11px] text-muted-foreground">
      {parts.map((p, i) => (
        <span key={i} className="flex shrink-0 items-center gap-1">
          {i > 0 ? <span className="text-muted-foreground/50">·</span> : null}
          {p}
        </span>
      ))}
    </div>
  );
}

/** Row actions in the ⋯ menu: ungroup on a primary, reorder/ungroup on an
    alternate, and delete on both. */
export type GroupControls = {
  isAlternate: boolean;
  // Set on an alternate: whether its primary is enabled. A disabled primary
  // gates the whole group out of output, so we dim its alternates too.
  primaryEnabled?: boolean;
  // Primary that has alternates.
  hasAlternates: boolean;
  altCount: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onUngroupPrimary: () => void;
  onUngroupAlternate: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  // Set on an alternate when moving up would make it the primary.
  willPromote?: boolean;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
};

/** The primary channel of a group (or a plain standalone channel). The whole
    group drags as one unit, so the drag handle props come from the parent that
    owns the sortable. */
export function PrimaryRow({
  channel,
  playlistId,
  selected,
  onSelect,
  group,
  alternates,
  dragHandleProps,
  insertAbove,
}: {
  channel: EditorChannel;
  playlistId: number;
  selected: boolean;
  onSelect: (id: number, shiftKey: boolean) => void;
  group?: GroupControls;
  alternates?: EditorChannel[];
  dragHandleProps?: Record<string, unknown>;
  insertAbove?: boolean;
}) {
  return (
    // The whole row is the drag handle. Interactive controls below stop
    // propagation so they click/toggle instead of starting a drag.
    <div
      className={cn(
        "group/row flex cursor-grab items-center gap-1.5 border-b border-white/5 px-2 py-2 transition-colors hover:bg-white/[0.02] active:cursor-grabbing sm:gap-2 sm:px-3",
        selected && "bg-primary/5",
      )}
      style={insertAbove ? { boxShadow: "inset 0 2px 0 0 var(--primary)" } : undefined}
      {...dragHandleProps}
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
      <ChannelRowBody
        channel={channel}
        playlistId={playlistId}
        group={group}
        alternates={alternates}
      />
    </div>
  );
}

/** An alternate channel: a static row nested under its primary. Its columns line
    up with the primary's (the ↳ sits in the chevron slot, the name under the
    primary's name) and it carries a subtle tint to read as part of the group.
    Reordering, ungrouping and removing happen from its menu. */
export function AlternateRow({
  channel,
  playlistId,
  selected,
  onSelect,
  group,
}: {
  channel: EditorChannel;
  playlistId: number;
  selected: boolean;
  onSelect: (id: number, shiftKey: boolean) => void;
  group: GroupControls;
}) {
  return (
    <div
      className={cn(
        "group/row flex items-center gap-1.5 border-b border-white/5 px-2 py-2 transition-colors sm:gap-2 sm:px-3",
        selected ? "bg-primary/10" : "bg-white/[0.025] hover:bg-white/[0.05]",
      )}
    >
      {/* Spacer aligning with the primary's drag grip. */}
      <span className="hidden size-4 shrink-0 sm:block" />
      <span
        onClick={(e) => {
          e.preventDefault();
          onSelect(channel.id, e.shiftKey);
        }}
        className="flex cursor-pointer items-center"
      >
        <Checkbox checked={selected} className="pointer-events-none" />
      </span>
      {/* In the primary's chevron column, marking this as a child. */}
      <CornerDownRight className="size-4 shrink-0 text-muted-foreground/40" />
      <ChannelRowBody channel={channel} playlistId={playlistId} group={group} />
    </div>
  );
}

const BOX = 28; // logo box in px (size-7)

// Logos preloaded this session, with their decoded dimensions. Lets a row paint
// its logo instantly on re-render/remount, and lets us size the <img> in exact
// pixels (see ChannelLogo) instead of object-fit, which Safari mis-recomputes
// on reflow.
const logoDims = new Map<string, { w: number; h: number }>();

/** Channel logo. Preloaded with a detached Image() (no <img> loading
    placeholder), then rendered at an exact pixel size computed from its decoded
    aspect — no object-fit / max-size, so Safari has nothing to recompute when
    the list reflows on collapse/expand. TV icon on failure. */
function ChannelLogo({ src }: { src: string | null }) {
  const proxied = src ? logoSrc(src) : undefined;
  const [dims, setDims] = useState<{ w: number; h: number } | null>(() =>
    proxied ? (logoDims.get(proxied) ?? null) : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!proxied) return;
    const cached = logoDims.get(proxied);
    if (cached) {
      setDims(cached);
      return;
    }
    setDims(null);
    const img = new Image();
    img.onload = () => {
      const d = { w: img.naturalWidth, h: img.naturalHeight };
      if (d.w > 0 && d.h > 0) logoDims.set(proxied, d);
      setDims(d.w > 0 ? d : null);
      if (d.w === 0) setFailed(true);
    };
    img.onerror = () => setFailed(true);
    img.src = proxied;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [proxied]);

  if (!proxied || failed) {
    return (
      <div className="hidden size-7 shrink-0 items-center justify-center sm:flex">
        <Tv className="size-3.5 text-muted-foreground" />
      </div>
    );
  }
  if (!dims) {
    // Nothing painted while preloading.
    return <div className="hidden size-7 shrink-0 sm:block" />;
  }
  // Exact pixel size that fits the box, preserving aspect. Fixed width/height
  // means no intrinsic-size recompute on reflow, so the logo can't shrink.
  const scale = Math.min(BOX / dims.w, BOX / dims.h);
  const w = Math.round(dims.w * scale);
  const h = Math.round(dims.h * scale);
  return (
    <span className="hidden size-7 shrink-0 items-center justify-center sm:flex">
      <img
        src={proxied}
        alt=""
        width={w}
        height={h}
        style={{ width: w, height: h }}
        className="rounded"
      />
    </span>
  );
}

/** Static body, also used by the drag overlay. */
export function ChannelRowBody({
  channel,
  playlistId,
  overlay,
  group,
  alternates,
}: {
  channel: EditorChannel;
  playlistId?: number;
  overlay?: boolean;
  group?: GroupControls;
  // The primary's alternates, passed through to the EPG picker.
  alternates?: EditorChannel[];
}) {
  const fetcher = useFetcher();
  const [smartSortOpen, setSmartSortOpen] = useState(false);
  const logo = channel.customLogo || channel.epgLogo || channel.sourceLogo;
  const isAlternate = channel.primaryChannelId != null;
  // Alternates are always auto-named from their primary (any stored custom name
  // is ignored). Primaries use their custom name, falling back to the source.
  const baseName = isAlternate ? channel.autoName : channel.sourceName;
  const displayName = isAlternate
    ? channel.autoName
    : (channel.customName ?? channel.sourceName);

  // Optimistic enabled state so the toggle never waits on the server.
  const submittedEnabled =
    fetcher.formData?.get("intent") === "toggleChannel"
      ? fetcher.formData.get("enabled") === "true"
      : undefined;
  const enabled = submittedEnabled ?? channel.enabled;
  // Dim a row when it won't reach output: its own toggle is off, or it's an
  // alternate whose primary is disabled (the primary gates the group).
  const dimmed = !enabled || (isAlternate && group?.primaryEnabled === false);
  const renamed =
    !isAlternate && !!channel.customName && channel.customName !== baseName;
  // This row's own probe is in flight. The server status only catches up on the
  // next poll, so show the spinner straight away.
  const probing = fetcher.formData?.get("intent") === "probeChannel";

  return (
    <>
      {/* Chevron slot. Always reserve its width on top-level rows so a single
          channel's logo lines up with a group's logo, even between groups. */}
      {group && !group.isAlternate ? (
        group.hasAlternates ? (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={group.onToggleCollapse}
            className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
            title={group.collapsed ? "Show alternates" : "Hide alternates"}
          >
            {group.collapsed ? (
              <ChevronRight className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </button>
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )
      ) : null}

      {/* Logo is hidden on mobile to give the name room. Alternates show no
          logo (they use the primary's in output); a spacer keeps the name
          aligned under the primary's. */}
      {isAlternate ? (
        <span className="hidden size-7 shrink-0 sm:block" />
      ) : (
        <span className={cn("transition-opacity", dimmed && "opacity-40")}>
          <ChannelLogo src={logo} />
        </span>
      )}

      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-0.5 transition-opacity",
          dimmed && "opacity-40",
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <NameField
            channel={channel}
            displayName={displayName}
            baseName={baseName}
            disabled={overlay}
            editable={!group?.isAlternate}
          />
          {renamed || group?.isAlternate ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  onPointerDown={(e) => e.stopPropagation()}
                  className="shrink-0 cursor-default text-muted-foreground"
                >
                  <Pencil className="size-3" />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {group?.isAlternate
                  ? `Original: ${channel.sourceName}`
                  : `Renamed from “${baseName}”`}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {group?.hasAlternates ? (
            <Badge className="shrink-0 border-transparent bg-white/[0.06] text-muted-foreground">
              {group.altCount} alt{group.altCount === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span className="shrink-0">{channel.sourceProviderName}</span>
          <span className="shrink-0 text-muted-foreground/50">·</span>
          <span className="min-w-0 truncate">
            {channel.sourceCategoryName ?? "Uncategorised"}
          </span>
        </div>
        <QualityLine channel={channel} probing={probing} />
      </div>

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        {!channel.sourceAvailable ||
        !channel.sourceCategoryEnabled ||
        (channel.autoDisabledAt && !enabled) ? (
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
            {channel.autoDisabledAt && !enabled ? (
              <Badge className="border-transparent bg-warning/10 text-warning">
                Auto-disabled
              </Badge>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-0.5">
        {/* Alternates always use the primary's guide, so no EPG picker. */}
        {overlay || playlistId == null || isAlternate ? null : (
          <span
            onPointerDown={(e) => e.stopPropagation()}
            className="hidden sm:inline-flex"
          >
            <EpgPicker
              channel={channel}
              playlistId={playlistId}
              fetcher={fetcher}
              alternates={alternates}
            />
          </span>
        )}
        {!overlay && group ? (
          <GroupMenu
            group={group}
            streamUrl={channel.streamUrl}
            enabled={enabled}
            onToggleEnabled={() =>
              fetcher.submit(
                {
                  intent: "toggleChannel",
                  channelId: channel.id,
                  enabled: String(!enabled),
                },
                { method: "post" },
              )
            }
            probing={probing}
            onProbe={() =>
              fetcher.submit(
                { intent: "probeChannel", sourceChannelId: channel.sourceChannelId },
                { method: "post" },
              )
            }
            onProbeGroup={
              group.hasAlternates && !group.isAlternate
                ? () =>
                    fetcher.submit(
                      { intent: "probeGroup", primaryId: channel.id },
                      { method: "post" },
                    )
                : undefined
            }
            onSmartSort={
              group.hasAlternates && !group.isAlternate
                ? () => setSmartSortOpen(true)
                : undefined
            }
            onRevertName={
              renamed
                ? () =>
                    fetcher.submit(
                      { intent: "renameChannel", channelId: channel.id, customName: "" },
                      { method: "post" },
                    )
                : undefined
            }
          />
        ) : null}
        </div>
      </div>

      {!overlay && group?.hasAlternates && !group.isAlternate ? (
        <SmartSortDialog
          primaryId={channel.id}
          open={smartSortOpen}
          onOpenChange={setSmartSortOpen}
        />
      ) : null}
    </>
  );
}

/** The ⋯ menu of per-row actions: probe, reorder/ungroup for alternates,
    ungroup-all for a primary with alternates, and delete on every row. */
function GroupMenu({
  group,
  streamUrl,
  enabled,
  onToggleEnabled,
  onProbe,
  onProbeGroup,
  onSmartSort,
  onRevertName,
  probing,
}: {
  group: GroupControls;
  streamUrl: string;
  enabled: boolean;
  onToggleEnabled: () => void;
  onProbe: () => void;
  // Set on a primary that has alternates: probe the whole group.
  onProbeGroup?: () => void;
  // Set on a primary that has alternates: reorder the group by stream quality.
  onSmartSort?: () => void;
  // Set when the channel has a custom name: revert it to the source name.
  onRevertName?: () => void;
  probing: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // Icon stays small but the tap target stretches to ~44px so it's easy to hit on mobile.
          className="relative size-7 cursor-pointer text-muted-foreground before:absolute before:-inset-2 before:content-[''] hover:text-foreground"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <MoreVertical className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onPointerDown={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={onToggleEnabled}>
          {enabled ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          {enabled ? "Disable" : "Enable"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
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
        <DropdownMenuSeparator />
        {onProbeGroup ? (
          <DropdownMenuItem onClick={onProbeGroup}>
            <Gauge className="size-4" />
            Probe group
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={onProbe} disabled={probing}>
          <Gauge className="size-4" />
          {probing ? "Probing…" : "Probe"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {group.isAlternate ? (
          <>
            <DropdownMenuItem
              disabled={!group.canMoveUp}
              onClick={() => group.onMove(-1)}
            >
              <ArrowUp className="size-4" />
              {group.willPromote ? "Make primary" : "Move up"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!group.canMoveDown}
              onClick={() => group.onMove(1)}
            >
              <ArrowDown className="size-4" />
              Move down
            </DropdownMenuItem>
            <DropdownMenuItem onClick={group.onUngroupAlternate}>
              <Unlink className="size-4" />
              Remove from group
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : group.hasAlternates ? (
          <>
            {onSmartSort ? (
              <DropdownMenuItem onClick={onSmartSort}>
                <Sparkles className="size-4" />
                Smart sort
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={group.onUngroupPrimary}>
              <Unlink className="size-4" />
              Ungroup all
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {onRevertName ? (
          <>
            <DropdownMenuItem onClick={onRevertName}>
              <RotateCcw className="size-4" />
              Revert name
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          onClick={group.onDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NameField({
  channel,
  displayName,
  baseName,
  disabled,
  editable = true,
}: {
  channel: EditorChannel;
  displayName: string;
  baseName: string;
  disabled?: boolean;
  // Alternates are auto-named from their primary, so they can't be renamed.
  editable?: boolean;
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
      ? submittedName.trim() || baseName
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

  if (!editable) {
    return (
      <span className="min-w-0 truncate text-left text-[13px]">{displayName}</span>
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
        className="-mx-1.5 min-w-0 flex-1 rounded-sm bg-white/[0.06] px-1.5 text-base leading-[1.4] outline-none ring-1 ring-ring/60 md:text-[13px]"
      />
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setEditing(true)}
      className={cn(
        "min-w-0 truncate text-left text-[13px]",
        channel.customName && channel.customName !== baseName
          ? "font-medium"
          : "",
      )}
      title="Click to rename"
    >
      {shown}
    </button>
  );
}
