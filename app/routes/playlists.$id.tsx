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
import { Link, data, useFetcher, useFetchers } from "react-router";
import { useLiveRevalidate } from "~/lib/use-live-revalidate";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { z } from "zod";
import { cn } from "~/lib/utils";
import { CopyField } from "~/components/copy-field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { externalOrigin } from "~/lib/url.server";
import { EditorBoard } from "~/components/playlist/editor-board";
import { Button } from "~/components/ui/button";
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
import {
  addAlternates,
  addChannels,
  bulkAddPrefix,
  bulkAddSuffix,
  bulkMove,
  bulkRemove,
  bulkReplace,
  bulkResetEpg,
  bulkSort,
  bulkToggle,
  createAutoCategory,
  createCategory,
  deleteCategory,
  makeAlternates,
  promoteAlternate,
  removeChannel,
  renameCategory,
  renameChannel,
  reorderAlternates,
  reorderCategories,
  reorderChannels,
  setEpg,
  smartSortGroup,
  toggleChannel,
  ungroupAlternate,
  ungroupPrimary,
} from "~/services/playlist/mutations.server";
import {
  getAltGroupStreams,
  getAutoChannels,
  getCategories,
  getPlaylist,
  getPlaylistChannels,
  matchingSourceChannelIds,
  playlistHasProbingSource,
} from "~/services/playlist/queries.server";
import { explainSmartSort } from "~/services/playlist/smart-sort";
import { invalidate } from "~/services/output/cache.server";
import {
  clearPlaylistProbes,
  probeSingleChannel,
  startProbeAutoDisabled,
  startProbeCategory,
  startProbeFailed,
  startProbeGroup,
  startProbeMissing,
  startProbePlaylist,
} from "~/services/probe/probe.server";
import type { Route } from "./+types/playlists.$id";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.playlist.name ?? "Playlist"} · Bouquet` }];
}

// Kept light on purpose: the source browser loads from its own endpoint, so
// editing the playlist revalidates only the playlist itself.
export async function loader({ params, request }: Route.LoaderArgs) {
  const id = Number(params.id);
  const playlist = getPlaylist(id);
  if (!playlist) throw new Response("Not found", { status: 404 });

  const origin = externalOrigin(request);
  const cats = getCategories(id);
  return {
    playlist: { id: playlist.id, name: playlist.name },
    output: {
      m3uUrl: `${origin}/output/m3u/${playlist.outputToken}`,
      epgUrl: `${origin}/output/epg/${playlist.outputToken}`,
    },
    categories: cats.map((c) => ({
      id: c.id,
      name: c.name,
      auto:
        c.autoSourceId != null
          ? {
              sourceId: c.autoSourceId,
              sourceName: c.autoSourceName ?? "Unknown source",
              categoryName: c.autoCategoryName ?? "",
            }
          : null,
    })),
    channels: getPlaylistChannels(id),
    autoChannels: getAutoChannels(cats),
    anyProbing: playlistHasProbingSource(id),
  };
}

const reorderSchema = z.object({
  movedId: z.coerce.number().int(),
  toCategoryId: z.coerce.number().int(),
  order: z.record(z.string(), z.array(z.number().int())),
});

function bulkIds(form: FormData): number[] {
  return form
    .getAll("channelIds")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
}

export async function action({ request, params }: Route.ActionArgs) {
  const playlistId = Number(params.id);
  const playlist = getPlaylist(playlistId);
  if (!playlist) throw new Response("Not found", { status: 404 });
  // Drop this playlist's cached output. Used when a structural change (auto
  // category created/removed) needs to show up in the M3U/EPG right away.
  const invalidateOutput = () => invalidate(playlist.outputToken);

  const form = await request.formData();
  const intent = form.get("intent");

  switch (intent) {
    case "addChannels": {
      const ids = form
        .getAll("sourceChannelIds")
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
      const categoryId = Number(form.get("categoryId"));
      if (!Number.isFinite(categoryId)) {
        return data({ ok: false, error: "Pick a category" }, { status: 400 });
      }
      const indexRaw = form.get("index");
      const insertIndex =
        indexRaw != null && indexRaw !== "" ? Number(indexRaw) : undefined;
      const added = addChannels(playlistId, categoryId, ids, insertIndex);
      return data({ ok: true, intent, added });
    }

    case "addSourceCategory": {
      // Add a whole source group as a new category named after the group.
      const sourceId = Number(form.get("sourceId"));
      const categoryName = String(form.get("categoryName") ?? "").trim();
      if (!Number.isFinite(sourceId) || !categoryName) {
        return data({ ok: false, error: "Missing group" }, { status: 400 });
      }
      const ids = matchingSourceChannelIds({
        sourceId,
        categories: [categoryName],
        excludePlaylistId: playlistId,
      });
      const cat = createCategory(playlistId, categoryName);
      if (!cat) {
        return data({ ok: false, error: "Could not create category" }, { status: 400 });
      }
      const added = addChannels(playlistId, cat.id, ids);
      return data({ ok: true, intent, added });
    }

    case "addMatching": {
      // Add every source channel matching the current browser filter, across
      // all sources.
      const categories = String(form.get("categories") ?? "")
        .split(",")
        .filter(Boolean);
      const q = String(form.get("q") ?? "").trim();
      const ids = matchingSourceChannelIds({
        categories: categories.length ? categories : undefined,
        q: q || undefined,
        excludePlaylistId: playlistId,
      });
      const categoryId = Number(form.get("categoryId"));
      if (!Number.isFinite(categoryId)) {
        return data({ ok: false, error: "Pick a category" }, { status: 400 });
      }
      const added = addChannels(playlistId, categoryId, ids);
      return data({ ok: true, intent, added });
    }

    case "createCategory": {
      const name = (form.get("name") as string | null) ?? "";
      const cat = createCategory(playlistId, name);
      if (!cat) return data({ ok: false, error: "Name is required" }, { status: 400 });
      return data({ ok: true, intent });
    }

    case "createAutoCategory": {
      const sourceId = Number(form.get("sourceId"));
      const categoryName = String(form.get("categoryName") ?? "");
      const name = String(form.get("name") ?? "");
      if (!Number.isFinite(sourceId) || !categoryName.trim() || !name.trim()) {
        return data({ ok: false, error: "Missing fields" }, { status: 400 });
      }
      const cat = createAutoCategory(playlistId, sourceId, categoryName, name);
      if (!cat) {
        return data({ ok: false, error: "Could not create category" }, { status: 400 });
      }
      invalidateOutput();
      return data({ ok: true, intent });
    }

    case "renameCategory": {
      renameCategory(playlistId, Number(form.get("categoryId")), String(form.get("name") ?? ""));
      return data({ ok: true, intent });
    }

    case "deleteCategory": {
      deleteCategory(playlistId, Number(form.get("categoryId")));
      // An auto category contributes live channels to output, so refresh it.
      invalidateOutput();
      return data({ ok: true, intent });
    }

    case "reorderCategories": {
      const ids = form
        .getAll("categoryIds")
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
      reorderCategories(playlistId, ids);
      return data({ ok: true, intent });
    }

    case "reorder": {
      const parsed = reorderSchema.safeParse({
        movedId: form.get("movedId"),
        toCategoryId: form.get("toCategoryId"),
        order: JSON.parse(String(form.get("order") ?? "{}")),
      });
      if (!parsed.success) {
        return data({ ok: false, error: "Bad reorder payload" }, { status: 400 });
      }
      reorderChannels(playlistId, parsed.data.movedId, parsed.data.toCategoryId, parsed.data.order);
      return data({ ok: true, intent });
    }

    case "renameChannel": {
      renameChannel(playlistId, Number(form.get("channelId")), String(form.get("customName") ?? ""));
      return data({ ok: true, intent });
    }

    case "toggleChannel": {
      toggleChannel(playlistId, Number(form.get("channelId")), form.get("enabled") === "true");
      return data({ ok: true, intent });
    }

    case "probeChannel": {
      // Probe one channel on demand, even if its source has probing off or the
      // channel is unavailable/hidden. Foreground so the row updates on return.
      await probeSingleChannel(Number(form.get("sourceChannelId")));
      return data({ ok: true, intent });
    }

    case "probeGroup": {
      // Probe a primary and all its alternates at once.
      const queued = startProbeGroup(playlistId, Number(form.get("primaryId")));
      return data({ ok: true, intent, queued });
    }

    case "probeAll": {
      // Probe every channel in this playlist, across all its sources, ignoring
      // the source probe setting and the available/category filters.
      const queued = startProbePlaylist(playlistId);
      return data({ ok: true, intent, queued });
    }

    case "probeMissing": {
      // Probe only the channels that have never been probed.
      const queued = startProbeMissing(playlistId);
      return data({ ok: true, intent, queued });
    }

    case "probeFailed": {
      // Probe only the channels whose last probe failed.
      const queued = startProbeFailed(playlistId);
      return data({ ok: true, intent, queued });
    }

    case "probeAutoDisabled": {
      // Re-check the channels that were auto-disabled, turning back on any that
      // work again.
      const queued = startProbeAutoDisabled(playlistId);
      return data({ ok: true, intent, queued });
    }

    case "clearProbes": {
      // Wipe all probe results for this playlist's channels.
      const cleared = clearPlaylistProbes(playlistId);
      return data({ ok: true, intent, cleared });
    }

    case "probeCategory": {
      // Probe every channel in one category, same rules as probe all.
      const queued = startProbeCategory(playlistId, Number(form.get("categoryId")));
      return data({ ok: true, intent, queued });
    }

    case "setEpg": {
      const epgSourceRaw = String(form.get("epgSourceId") ?? "");
      const epgChannelRaw = String(form.get("epgChannelId") ?? "");
      setEpg(
        playlistId,
        Number(form.get("channelId")),
        epgSourceRaw ? Number(epgSourceRaw) : null,
        epgChannelRaw || null,
      );
      return data({ ok: true, intent });
    }

    case "removeChannel": {
      removeChannel(playlistId, Number(form.get("channelId")));
      return data({ ok: true, intent });
    }

    case "makeAlternates": {
      const primaryId = Number(form.get("primaryId"));
      const ids = form
        .getAll("alternateIds")
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
      makeAlternates(playlistId, primaryId, ids);
      return data({ ok: true, intent });
    }

    case "addAlternates": {
      const primaryId = Number(form.get("primaryId"));
      const ids = form
        .getAll("sourceChannelIds")
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
      const added = addAlternates(playlistId, primaryId, ids);
      return data({ ok: true, intent, added });
    }

    case "reorderAlternates": {
      const primaryId = Number(form.get("primaryId"));
      const ids = form
        .getAll("alternateIds")
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
      reorderAlternates(playlistId, primaryId, ids);
      return data({ ok: true, intent });
    }

    case "promoteAlternate": {
      promoteAlternate(playlistId, Number(form.get("channelId")));
      return data({ ok: true, intent });
    }

    case "previewSmartSort": {
      // Compute the order without applying it, so the editor can show what would
      // change and why before the user confirms.
      const config = {
        prefer: playlist.smartSortPrefer,
        audio: playlist.smartSortAudio,
        availableFirst: playlist.smartSortAvailableFirst,
      };
      const streams = getAltGroupStreams(
        playlistId,
        Number(form.get("primaryId")),
      ).map((s, i) => ({
        ...s,
        currentlyPrimary: s.primaryChannelId == null,
        currentPosition: i,
      }));
      const ranked = explainSmartSort(streams, config);
      return data({ ok: true, intent, config, streams: ranked });
    }

    case "smartSortGroup": {
      smartSortGroup(playlistId, Number(form.get("primaryId")), {
        prefer: playlist.smartSortPrefer,
        audio: playlist.smartSortAudio,
        availableFirst: playlist.smartSortAvailableFirst,
      });
      return data({ ok: true, intent });
    }

    case "ungroupAlternate": {
      ungroupAlternate(playlistId, Number(form.get("channelId")));
      return data({ ok: true, intent });
    }

    case "ungroupPrimary": {
      ungroupPrimary(playlistId, Number(form.get("primaryId")));
      return data({ ok: true, intent });
    }

    case "bulkToggle": {
      const ids = bulkIds(form);
      bulkToggle(playlistId, ids, form.get("enabled") === "true");
      return data({ ok: true, intent });
    }

    case "bulkMove": {
      const ids = bulkIds(form);
      bulkMove(playlistId, ids, Number(form.get("toCategoryId")));
      return data({ ok: true, intent });
    }

    case "bulkRemove": {
      bulkRemove(playlistId, bulkIds(form));
      return data({ ok: true, intent });
    }

    case "bulkResetEpg": {
      bulkResetEpg(playlistId, bulkIds(form));
      return data({ ok: true, intent });
    }

    case "bulkSort": {
      const direction = form.get("direction") === "desc" ? "desc" : "asc";
      bulkSort(playlistId, bulkIds(form), direction);
      return data({ ok: true, intent });
    }

    case "bulkPrefix": {
      bulkAddPrefix(playlistId, bulkIds(form), String(form.get("text") ?? ""));
      return data({ ok: true, intent });
    }

    case "bulkSuffix": {
      bulkAddSuffix(playlistId, bulkIds(form), String(form.get("text") ?? ""));
      return data({ ok: true, intent });
    }

    case "bulkReplace": {
      bulkReplace(
        playlistId,
        bulkIds(form),
        String(form.get("search") ?? ""),
        String(form.get("replace") ?? ""),
      );
      return data({ ok: true, intent });
    }

    default:
      return data({ ok: false, error: "Unknown action" }, { status: 400 });
  }
}

export default function PlaylistEditor({ loaderData }: Route.ComponentProps) {
  const { playlist, categories, channels, autoChannels, output, anyProbing } =
    loaderData;

  // Channels waiting on or mid-probe right now, for the live header count.
  const probingCount = channels.filter(
    (c) => c.probeStatus === "queued" || c.probeStatus === "probing",
  ).length;

  // Counts for the probe submenu, scoped to enabled channels to match what the
  // server actually probes. Missing = never probed, failed = last probe errored.
  const enabled = channels.filter((c) => c.enabled);
  const missingCount = enabled.filter((c) => c.probeStatus == null).length;
  const failedCount = enabled.filter(
    (c) => c.probeStatus === "error" || c.probeStatus === "timeout",
  ).length;
  // Auto-disabled channels are off, so they're counted by their marker, not the
  // enabled set above.
  const autoDisabledCount = channels.filter((c) => c.autoDisabledAt != null).length;

  // One probe fetcher shared by the desktop button and the mobile menu, so a
  // probe started from either fires a single toast.
  const probing = anyProbing || probingCount > 0;

  // Keep listening for live updates until the channel count itself clears, not
  // just while the source says "probing". The source flips to done a beat before
  // the last channel rows do, and if we stopped here we'd be left showing a
  // stale "Probing 1…" with nothing polling to clear it.
  useLiveRevalidate(probing);
  const { submitting, probe } = useProbeAll();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
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
              probingCount={probingCount}
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
            probingCount={probingCount}
            missingCount={missingCount}
            failedCount={failedCount}
            autoDisabledCount={autoDisabledCount}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <EditorBoard
          playlistId={playlist.id}
          categories={categories}
          channels={channels}
          autoChannels={autoChannels}
        />
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
  probingCount: number;
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
  probingCount,
  missingCount,
  failedCount,
  autoDisabledCount,
}: ProbeProps) {
  const busy = submitting || probing;

  // Mid-probe: a single button showing progress, no dropdown.
  if (probing) {
    return (
      <Button size="sm" variant="outline" disabled>
        <Gauge className="size-4 animate-pulse" />
        {probingCount > 0 ? `Probing ${probingCount}…` : "Probing…"}
      </Button>
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
            Probe all
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Probes every channel in this playlist, even ones whose source has probing
          turned off.
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
  probingCount,
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
              ? probingCount > 0
                ? `Probing ${probingCount}…`
                : "Probing…"
              : "Probe all"}
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
