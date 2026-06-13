import { ArrowLeft, Check, Link2, Loader2, Settings } from "lucide-react";
import { Link, data, useFetchers } from "react-router";
import { z } from "zod";
import { CopyField } from "~/components/copy-field";
import { externalOrigin } from "~/lib/url.server";
import { EditorBoard } from "~/components/playlist/editor-board";
import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import {
  addChannels,
  bulkAddPrefix,
  bulkAddSuffix,
  bulkMove,
  bulkRemove,
  bulkReplace,
  bulkResetEpg,
  bulkToggle,
  createAutoCategory,
  createCategory,
  deleteCategory,
  removeChannel,
  renameCategory,
  renameChannel,
  reorderCategories,
  reorderChannels,
  setEpg,
  toggleChannel,
} from "~/services/playlist/mutations.server";
import {
  getAutoChannels,
  getCategories,
  getPlaylist,
  getPlaylistChannels,
  matchingSourceChannelIds,
} from "~/services/playlist/queries.server";
import { invalidate } from "~/services/output/cache.server";
import type { Route } from "./+types/playlists.$id";

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `${data?.playlist.name ?? "Playlist"} · Bouquet` }];
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
      let categoryId = Number(form.get("categoryId"));
      const newName = (form.get("newCategoryName") as string | null)?.trim();
      if (!Number.isFinite(categoryId) && newName) {
        const cat = createCategory(playlistId, newName);
        if (!cat) return data({ ok: false, error: "Could not create category" }, { status: 400 });
        categoryId = cat.id;
      }
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
      let categoryId = Number(form.get("categoryId"));
      const newName = (form.get("newCategoryName") as string | null)?.trim();
      if (!Number.isFinite(categoryId) && newName) {
        const cat = createCategory(playlistId, newName);
        if (!cat) {
          return data({ ok: false, error: "Could not create category" }, { status: 400 });
        }
        categoryId = cat.id;
      }
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
  const { playlist, categories, channels, autoChannels, output } = loaderData;

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
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline">
                <Link2 className="size-4" />
                <span className="hidden sm:inline">Output URLs</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              onOpenAutoFocus={(e) => e.preventDefault()}
              className="w-[32rem] max-w-[calc(100vw-2rem)] space-y-3"
            >
              <p className="text-[13px] text-muted-foreground">
                Point your IPTV player at these.
              </p>
              <CopyField label="M3U" url={output.m3uUrl} />
              <CopyField label="EPG (XMLTV)" url={output.epgUrl} />
            </PopoverContent>
          </Popover>
          <Button asChild size="sm" variant="outline">
            <Link to={`/playlists/${playlist.id}/settings`}>
              <Settings className="size-4" />
              <span className="hidden sm:inline">Settings</span>
            </Link>
          </Button>
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
