import { listEpgChannels } from "~/services/playlist/queries.server";
import type { Route } from "./+types/playlists.$id.epg-channels";

// Lazy endpoint for the EPG picker. There can be thousands of EPG channels, so
// we keep them out of the editor loader and fetch them only when a picker opens.
export async function loader(_: Route.LoaderArgs) {
  return { epgChannels: listEpgChannels() };
}
