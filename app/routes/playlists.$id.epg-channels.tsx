import type { EpgChannelsData } from "~/api/types/EpgChannelsData";
import { apiLoad } from "~/lib/api";
import type { Route } from "./+types/playlists.$id.epg-channels";

// The picker loads this on demand; don't auto-revalidate it on playlist edits.
export function shouldRevalidate() {
  return false;
}

// There can be thousands of EPG channels, so the picker fetches them only when
// it opens.
export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return apiLoad<EpgChannelsData>(request);
}
