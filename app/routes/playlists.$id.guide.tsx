import { ArrowLeft, Tv } from "lucide-react";
import { Link } from "react-router";
import type { GuideData } from "~/api/types/GuideData";
import { GuideGrid } from "~/components/guide/guide-grid";
import { EmptyState } from "~/components/empty-state";
import { Button } from "~/components/ui/button";
import { apiAction, apiLoad } from "~/lib/api";
import type { Route } from "./+types/playlists.$id.guide";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `Guide · ${loaderData?.playlistName ?? "Playlist"} · Bouquet` }];
}

export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return apiLoad<GuideData>(request);
}

export function clientAction({ request }: Route.ClientActionArgs) {
  return apiAction<{ ok: boolean; count: number }>(request);
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
