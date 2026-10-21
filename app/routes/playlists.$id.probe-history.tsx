import type { ProbeHistory } from "~/api/types/ProbeHistory";
import { apiLoad } from "~/lib/api";
import type { Route } from "./+types/playlists.$id.probe-history";

// The dialog reloads this each time it opens; don't auto-revalidate it on
// playlist edits.
export function shouldRevalidate() {
  return false;
}

export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return apiLoad<ProbeHistory>(request);
}
