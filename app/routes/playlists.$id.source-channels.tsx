import {
  BROWSER_LIMIT,
  browserCategories,
  browserChannels,
} from "~/services/playlist/queries.server";
import type { Route } from "./+types/playlists.$id.source-channels";

// Lazy endpoint for the source browser. Returns channels across every source
// (each row carries its source), kept out of the editor loader so playlist edits
// never reload this (potentially huge) list.
export async function loader({ params, request }: Route.LoaderArgs) {
  const playlistId = Number(params.id);
  const url = new URL(request.url);

  const categories = (url.searchParams.get("categories") ?? "")
    .split(",")
    .filter(Boolean);
  const q = (url.searchParams.get("q") ?? "").trim();

  const { rows, total } = browserChannels({
    categories: categories.length ? categories : undefined,
    q: q || undefined,
    excludePlaylistId: playlistId,
  });

  return {
    channels: rows,
    categories: browserCategories(),
    total,
    limit: BROWSER_LIMIT,
  };
}
