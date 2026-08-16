import {
  SOURCE_CHANNEL_LIMIT,
  listSourceChannels,
  searchCategoryCounts,
} from "~/services/sources/channels.server";
import type { Route } from "./+types/sources.$id.channels";

// Lazy endpoint behind the category list on the source screen. Kept out of the
// source loader so toggling a category doesn't reload a catalog that can run to
// tens of thousands of channels.
//
// Pass `category` to list that category's channels, optionally narrowed by `q`.
// Pass `q` on its own to find out how many channels match in each category.
export async function loader({ params, request }: Route.LoaderArgs) {
  const sourceId = Number(params.id);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const category = url.searchParams.get("category");

  if (category) {
    const { channels, total } = listSourceChannels(sourceId, {
      category,
      q: q || undefined,
    });
    return { q, channels, total, counts: null, limit: SOURCE_CHANNEL_LIMIT };
  }

  return {
    q,
    channels: [],
    total: 0,
    counts: q ? searchCategoryCounts(sourceId, q) : [],
    limit: SOURCE_CHANNEL_LIMIT,
  };
}
