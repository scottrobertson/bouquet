import type { SourceBrowserData } from "~/api/types/SourceBrowserData";
import { apiLoad } from "~/lib/api";
import type { Route } from "./+types/playlists.$id.source-channels";

// Playlist edits would otherwise revalidate this big list on every mutation,
// flickering the browser. The editor reloads it explicitly when it needs to
// (filter change, after an add), so skip automatic revalidation.
export function shouldRevalidate() {
  return false;
}

// The source browser's channels across every source, kept out of the editor's
// own data so playlist edits never reload this potentially huge list.
export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return apiLoad<SourceBrowserData>(request);
}
