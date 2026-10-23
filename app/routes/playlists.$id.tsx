import {
  ArrowLeft,
  Check,
  ChevronDown,
  Gauge,
  Link2,
  Loader2,
  MoreVertical,
  Settings,
  Tv,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Link,
  useFetcher,
  useFetchers,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import type { EditorData } from "~/api/types/EditorData";
import type { EditorCategory, EditorChannel } from "~/components/playlist/types";
import { apiAction, apiLoad } from "~/lib/api";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { CopyField } from "~/components/copy-field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { ChannelNameTemplate } from "~/components/playlist/channel-name";
import { EditorBoard } from "~/components/playlist/editor-board";
import { MobileNavButton } from "~/components/mobile-nav";
import { ProbeQueue, probeQueue } from "~/components/playlist/probe-queue";
import { Button } from "~/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "~/components/ui/hover-card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type { Route } from "./+types/playlists.$id";

export const handle = { ownMobileHeader: true };

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.playlist.name ?? "Playlist"} · Bouquet` }];
}

// The source browser keeps its search and category filters in the URL, and
// nothing here reads them. Without this, every keystroke in the search box
// reloads the whole playlist from the server and the editor feels laggy.
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  const filtersOnly =
    !formMethod &&
    currentUrl.pathname === nextUrl.pathname &&
    currentUrl.search !== nextUrl.search;
  return filtersOnly ? false : defaultShouldRevalidate;
}

// Kept light on purpose: the source browser loads from its own endpoint, so
// editing the playlist revalidates only the playlist itself.
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const data = await apiLoad<EditorData>(request);
  return {
    ...data,
    // The generated types read the text columns as plain strings; the editor's
    // own types spell out the values each one can hold.
    categories: data.categories as EditorCategory[],
    channels: data.channels as EditorChannel[],
  };
}

export type ActionResult = {
  ok: boolean;
  intent?: string;
  error?: string;
  added?: number;
  queued?: number;
  cleared?: number;
};

export function clientAction({ request }: Route.ClientActionArgs) {
  return apiAction<ActionResult>(request);
}
export default function PlaylistEditor({ loaderData }: Route.ComponentProps) {
  const {
    playlist,
    categories,
    channels,
    autoChannels,
    output,
    anyProbing,
    needsSmartSort,
  } = loaderData;

  // Channels waiting on or mid-probe right now, for the live header count and
  // the list you get by hovering it.
  const probeRows = probeQueue(channels, playlist.channelNameTemplate);
  const probingCount = probeRows.length;

  // Counts for the probe submenu, scoped to enabled channels to match what the
  // server actually probes. Missing = never probed, failed = last probe errored.
  // The probe menu never touches a switched-off source, so its counts skip
  // those channels too, otherwise the numbers wouldn't match what runs.
  const onSource = channels.filter((c) => c.sourceEnabled);
  const enabled = onSource.filter((c) => c.enabled);
  const missingCount = enabled.filter((c) => c.probeStatus == null).length;
  const failedCount = enabled.filter(
    (c) => c.probeStatus === "error" || c.probeStatus === "timeout",
  ).length;
  // Auto-disabled channels are off, so they're counted by their marker, not the
  // enabled set above.
  const autoDisabledCount = onSource.filter((c) => c.autoDisabledAt != null).length;

  const probing = anyProbing || probingCount > 0;
  // One probe fetcher shared by the desktop button and the mobile menu, so a
  // probe started from either fires a single toast.
  const { submitting, probe } = useProbeAll();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 md:px-6 md:pt-3">
        <div className="flex min-w-0 items-center gap-1 md:gap-3">
          <MobileNavButton className="md:hidden" />
          <Button asChild variant="ghost" size="icon" className="size-7 shrink-0">
            <Link to="/playlists">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <h1 className="truncate text-base font-semibold tracking-tight">
            {playlist.name}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <SaveStatus />
          {/* Desktop: each action is its own labelled button. */}
          <div className="hidden items-center gap-3 sm:flex">
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline">
                  <Link2 className="size-4" />
                  Output URLs
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                onOpenAutoFocus={(e) => e.preventDefault()}
                className="w-[32rem] max-w-[calc(100vw-2rem)] space-y-3"
              >
                <OutputUrls output={output} />
              </PopoverContent>
            </Popover>
            <ProbeAllButton
              probe={probe}
              submitting={submitting}
              probing={probing}
              probeRows={probeRows}
              missingCount={missingCount}
              failedCount={failedCount}
              autoDisabledCount={autoDisabledCount}
            />
            <Button asChild size="sm" variant="outline">
              <Link to={`/playlists/${playlist.id}/guide`}>
                <Tv className="size-4" />
                Guide
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to={`/playlists/${playlist.id}/settings`}>
                <Settings className="size-4" />
                Settings
              </Link>
            </Button>
          </div>
          {/* Mobile: the actions are icon-only and hard to read, so collapse
              them into one labelled menu. */}
          <HeaderMenu
            className="sm:hidden"
            playlistId={playlist.id}
            output={output}
            probe={probe}
            submitting={submitting}
            probing={probing}
            probeRows={probeRows}
            missingCount={missingCount}
            failedCount={failedCount}
            autoDisabledCount={autoDisabledCount}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <ChannelNameTemplate.Provider value={playlist.channelNameTemplate}>
          <EditorBoard
            playlistId={playlist.id}
            categories={categories}
            channels={channels}
            autoChannels={autoChannels}
            needsSmartSort={needsSmartSort}
          />
        </ChannelNameTemplate.Provider>
      </div>
    </div>
  );
}

type ProbeIntent =
  | "probeAll"
  | "probeMissing"
  | "probeFailed"
  | "probeAutoDisabled"
  | "clearProbes";

// Owns the probe fetcher so the desktop button and the mobile menu can both
// start a probe through it and only one toast fires.
function useProbeAll() {
  const fetcher = useFetcher<{ queued?: number; cleared?: number }>();
  const handled = useRef<typeof fetcher.data>(undefined);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data === handled.current) return;
    handled.current = fetcher.data;
    if (fetcher.data.cleared != null) {
      const n = fetcher.data.cleared;
      toast(`Cleared probes for ${n} channel${n === 1 ? "" : "s"}`);
      return;
    }
    const n = fetcher.data.queued ?? 0;
    toast(`Probing ${n} channel${n === 1 ? "" : "s"}`, {
      description: "Checking stream quality in the background.",
    });
  }, [fetcher.state, fetcher.data]);

  const probe = (intent: ProbeIntent) =>
    fetcher.submit({ intent }, { method: "post" });
  return { submitting: fetcher.state !== "idle", probe };
}

type ProbeProps = {
  probe: (intent: ProbeIntent) => void;
  submitting: boolean;
  probing: boolean;
  probeRows: ReturnType<typeof probeQueue>;
  missingCount: number;
  failedCount: number;
  autoDisabledCount: number;
};

// Kicks a probe of every channel in the playlist. Runs in the background, so it
// just fires and the rows fill in as results land (the editor polls). The
// dropdown narrows the probe to only the channels that need it, or clears
// results. While a probe is running the button shows live progress and the
// dropdown is hidden, since there's nothing to start mid-probe.
function ProbeAllButton({
  probe,
  submitting,
  probing,
  probeRows,
  missingCount,
  failedCount,
  autoDisabledCount,
}: ProbeProps) {
  const busy = submitting || probing;

  // Mid-probe: a single button showing progress, no dropdown. Hovering it lists
  // the channels left to go. The button can't be `disabled` or the browser
  // swallows the hover.
  if (probing) {
    const label =
      probeRows.length > 0 ? `Probing ${probeRows.length}…` : "Probing…";
    const button = (
      <Button
        size="sm"
        variant="outline"
        aria-disabled
        className="cursor-default text-muted-foreground"
      >
        <Gauge className="size-4 animate-pulse" />
        {label}
      </Button>
    );
    // A probe started elsewhere can leave this playlist with nothing queued, and
    // an empty list is worse than no list.
    if (probeRows.length === 0) return button;
    return (
      <HoverCard openDelay={100} closeDelay={100}>
        <HoverCardTrigger asChild>{button}</HoverCardTrigger>
        <HoverCardContent
          align="end"
          className="w-80 max-w-[calc(100vw-2rem)] p-0"
        >
          <ProbeQueue queue={probeRows} />
        </HoverCardContent>
      </HoverCard>
    );
  }

  return (
    <div className="flex items-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            className="rounded-r-none"
            onClick={() => probe("probeAll")}
          >
            <Gauge className="size-4" />
            Probe enabled
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Probes every channel that's switched on, even ones whose source has
          probing turned off. Switched-off channels are skipped.
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            className="rounded-l-none border-l-0 px-2"
            aria-label="More probe options"
          >
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={missingCount === 0}
            onClick={() => probe("probeMissing")}
          >
            Probe missing ({missingCount})
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={failedCount === 0}
            onClick={() => probe("probeFailed")}
          >
            Probe failed ({failedCount})
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={autoDisabledCount === 0}
            onClick={() => probe("probeAutoDisabled")}
          >
            Probe auto-disabled ({autoDisabledCount})
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => probe("clearProbes")}
          >
            Clear probes
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// The output URLs an IPTV player points at. Shared by the desktop popover and
// the mobile dialog.
function OutputUrls({ output }: { output: { m3uUrl: string; epgUrl: string } }) {
  return (
    <>
      <p className="text-[13px] text-muted-foreground">
        Point your IPTV player at these.
      </p>
      <CopyField label="M3U" url={output.m3uUrl} />
      <CopyField label="EPG (XMLTV)" url={output.epgUrl} />
    </>
  );
}

// On mobile the header buttons are icon-only and hard to read, so every action
// lives here as a labelled row instead.
function HeaderMenu({
  className,
  playlistId,
  output,
  probe,
  submitting,
  probing,
  probeRows,
  missingCount,
  failedCount,
  autoDisabledCount,
}: ProbeProps & {
  className?: string;
  playlistId: number;
  output: { m3uUrl: string; epgUrl: string };
}) {
  const [urlsOpen, setUrlsOpen] = useState(false);
  const busy = submitting || probing;

  return (
    <div className={className}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="outline" aria-label="Playlist actions">
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setUrlsOpen(true)}>
            <Link2 className="size-4" />
            Output URLs
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to={`/playlists/${playlistId}/guide`}>
              <Tv className="size-4" />
              Guide
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to={`/playlists/${playlistId}/settings`}>
              <Settings className="size-4" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={busy} onClick={() => probe("probeAll")}>
            <Gauge className={cn("size-4", probing && "animate-pulse")} />
            {probing
              ? probeRows.length > 0
                ? `Probing ${probeRows.length}…`
                : "Probing…"
              : "Probe enabled"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={busy || missingCount === 0}
            onClick={() => probe("probeMissing")}
          >
            Probe missing ({missingCount})
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={busy || failedCount === 0}
            onClick={() => probe("probeFailed")}
          >
            Probe failed ({failedCount})
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={busy || autoDisabledCount === 0}
            onClick={() => probe("probeAutoDisabled")}
          >
            Probe auto-disabled ({autoDisabledCount})
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            onClick={() => probe("clearProbes")}
          >
            Clear probes
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={urlsOpen} onOpenChange={setUrlsOpen}>
        <DialogContent className="space-y-3">
          <DialogHeader>
            <DialogTitle>Output URLs</DialogTitle>
          </DialogHeader>
          <OutputUrls output={output} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Edits save through fetchers, so reflect their state as a save indicator.
function SaveStatus() {
  const fetchers = useFetchers();
  const saving = fetchers.some((f) => f.state !== "idle");
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {saving ? (
        <>
          <Loader2 className="size-3.5 animate-spin" />
          <span className="hidden sm:inline">Saving…</span>
        </>
      ) : (
        <>
          <Check className="size-3.5 text-success" />
          <span className="hidden sm:inline">All changes saved</span>
        </>
      )}
    </span>
  );
}
