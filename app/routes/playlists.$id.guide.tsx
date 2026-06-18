import { ArrowLeft, Tv } from "lucide-react";
import { Link } from "react-router";
import { GuideGrid } from "~/components/guide/guide-grid";
import type { CategoryView } from "~/components/guide/types";
import { EmptyState } from "~/components/empty-state";
import { Button } from "~/components/ui/button";
import { getPlaylistGuide } from "~/services/guide/guide.server";
import { resolvePlaylistChannels } from "~/services/output/queries.server";
import { getPlaylist } from "~/services/playlist/queries.server";
import { startSync } from "~/services/sync/sync.server";
import type { Route } from "./+types/playlists.$id.guide";

// Fetch a few days either side of the anchor so day-to-day navigation in the
// guide is client-side and doesn't refetch (and flicker) at each boundary.
const WINDOW_PAST_MS = 3 * 24 * 3_600_000;
const WINDOW_FUTURE_MS = 24 * 3_600_000;

export function meta({ data }: Route.MetaArgs) {
  return [{ title: `Guide · ${data?.playlistName ?? "Playlist"} · Bouquet` }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const id = Number(params.id);
  const url = new URL(request.url);
  const atParam = Number(url.searchParams.get("at"));
  const atMs = Number.isFinite(atParam) && atParam > 0 ? atParam : Date.now();
  const fromMs = atMs - WINDOW_PAST_MS;
  const toMs = atMs + WINDOW_FUTURE_MS;

  const guide = getPlaylistGuide(
    id,
    Math.floor(fromMs / 1000),
    Math.floor(toMs / 1000),
  );
  if (!guide) throw new Response("Not found", { status: 404 });

  const categories: CategoryView[] = guide.categories.map((c) => ({
    name: c.name,
    channels: c.channels.map((ch) => ({
      displayName: ch.displayName,
      logo: ch.logo,
      tvgId: ch.tvgId,
      catchupDays: ch.catchupDays,
      streamUrl: ch.streamUrl,
      catchupSource: ch.catchupSource,
      programmes: ch.programmes.map((p) => ({
        startMs: p.startTs * 1000,
        stopMs: p.stopTs * 1000,
        title: p.title,
        subTitle: p.subTitle,
        description: p.description,
        category: p.category,
      })),
    })),
  }));

  return {
    playlistId: id,
    playlistName: guide.playlist.name,
    categories,
    fromMs,
    toMs,
    atMs,
    nowMs: Date.now(),
    sources: guide.sources,
    needsSync: guide.sources.some((s) => s.epgStale || s.lastSyncedAt == null),
  };
}

export async function action({ params }: Route.ActionArgs) {
  const id = Number(params.id);
  const playlist = getPlaylist(id);
  if (!playlist) throw new Response("Not found", { status: 404 });
  const sourceIds = [
    ...new Set(resolvePlaylistChannels(playlist).map((c) => c.epgSourceId)),
  ];
  for (const sid of sourceIds) startSync(sid);
  return { ok: true, count: sourceIds.length };
}

export default function PlaylistGuide({ loaderData }: Route.ComponentProps) {
  const { playlistId, playlistName, categories } = loaderData;
  const hasChannels = categories.some((c) => c.channels.length > 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3 md:px-6">
        <Button asChild variant="ghost" size="icon" className="size-7 shrink-0">
          <Link to={`/playlists/${playlistId}`}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <h1 className="truncate text-base font-semibold tracking-tight">
          {playlistName}
          <span className="ml-2 font-normal text-muted-foreground">Guide</span>
        </h1>
      </div>

      {hasChannels ? (
        <div className="min-h-0 flex-1">
          <GuideGrid
            playlistId={playlistId}
            categories={categories}
            loadedFromMs={loaderData.fromMs}
            loadedToMs={loaderData.toMs}
            atMs={loaderData.atMs}
            initialNowMs={loaderData.nowMs}
            needsSync={loaderData.needsSync}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            icon={Tv}
            title="No channels in this playlist"
            description="Add some channels first, then come back to see the guide."
            action={
              <Button asChild size="sm" variant="outline">
                <Link to={`/playlists/${playlistId}`}>Open playlist</Link>
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}
