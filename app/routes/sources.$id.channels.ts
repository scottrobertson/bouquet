import type { SourceChannelsData } from "~/api/types/SourceChannelsData";
import { apiLoad } from "~/lib/api";
import type { Route } from "./+types/sources.$id.channels";

// Lazy data behind the category list on the source screen. Kept out of the
// source page's own data so toggling a category doesn't reload a catalog that
// can run to tens of thousands of channels.
export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return apiLoad<SourceChannelsData>(request);
}
