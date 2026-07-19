import { and, eq } from "drizzle-orm";
import { db } from "~/db/index.server";
import { playlists, uploadDestinations } from "~/db/schema";
import type { UploadDestination } from "~/db/schema";
import { bumpPlaylist } from "~/services/events.server";
import { buildM3u } from "~/services/output/m3u.server";
import { getPlaylistOutput } from "~/services/output/queries.server";
import { buildXmltv } from "~/services/output/xmltv.server";
import { buildTarget } from "./storage.server";

// Wait after a sync before uploading, so a cron tick that syncs several sources
// collapses into a single upload pass instead of one per source.
const DEBOUNCE_MS = 5000;

/** Regenerate a destination's M3U and EPG and push both. Self-contained: it
    records its own uploading/ok/error status and never throws, so a batch upload
    keeps going past a failing destination. */
export async function uploadDestination(destId: number): Promise<void> {
  const dest = db
    .select()
    .from(uploadDestinations)
    .where(eq(uploadDestinations.id, destId))
    .get();
  if (!dest) return;

  db.update(uploadDestinations)
    .set({ uploadStatus: "uploading", uploadError: null })
    .where(eq(uploadDestinations.id, destId))
    .run();
  bumpPlaylist(dest.playlistId);

  try {
    const playlist = db
      .select()
      .from(playlists)
      .where(eq(playlists.id, dest.playlistId))
      .get();
    if (!playlist) throw new Error("Playlist not found");

    const output = await getPlaylistOutput(playlist.outputToken);
    if (!output) throw new Error("Playlist output not found");

    const epgUrl = resolveEpgUrl(dest);
    const m3u = buildM3u(output.channels, epgUrl);
    const xmltv = await buildXmltv(output.channels);

    const target = buildTarget(dest);
    await target.write(dest.m3uPath, m3u);
    await target.write(dest.epgPath, xmltv);

    db.update(uploadDestinations)
      .set({ uploadStatus: "ok", lastUploadedAt: new Date(), uploadError: null })
      .where(eq(uploadDestinations.id, destId))
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upload failed";
    console.error(`[upload] destination ${destId} (${dest.name}) failed:`, err);
    db.update(uploadDestinations)
      .set({ uploadStatus: "error", uploadError: msg })
      .where(eq(uploadDestinations.id, destId))
      .run();
  } finally {
    bumpPlaylist(dest.playlistId);
  }
}

/** Kick a single destination's upload without waiting. Used by the manual button. */
export function startUpload(destId: number): void {
  void uploadDestination(destId).catch((err) =>
    console.error("[upload] startUpload failed", err),
  );
}

/** Upload every enabled destination for one playlist. */
export async function uploadPlaylist(playlistId: number): Promise<void> {
  const dests = db
    .select()
    .from(uploadDestinations)
    .where(
      and(
        eq(uploadDestinations.playlistId, playlistId),
        eq(uploadDestinations.enabled, true),
      ),
    )
    .all();
  for (const d of dests) await uploadDestination(d.id);
}

/** Upload every enabled destination across all playlists. */
export async function uploadAllPlaylists(): Promise<void> {
  const dests = db
    .select({ id: uploadDestinations.id })
    .from(uploadDestinations)
    .where(eq(uploadDestinations.enabled, true))
    .all();
  if (dests.length === 0) return;
  console.log(`[upload] uploading ${dests.length} destination(s)`);
  for (const d of dests) await uploadDestination(d.id);
}

// Indirection so the debounce timer's target can be observed in tests.
export const uploadRunner = { run: uploadAllPlaylists };

const timerState = globalThis as unknown as {
  __uploadDebounce?: ReturnType<typeof setTimeout>;
};

/** Ask for an upload of all playlists shortly. Repeated calls within the window
    collapse into one run, so a batch sync uploads once. */
export function requestUploadSoon(): void {
  if (timerState.__uploadDebounce) clearTimeout(timerState.__uploadDebounce);
  timerState.__uploadDebounce = setTimeout(() => {
    timerState.__uploadDebounce = undefined;
    void uploadRunner
      .run()
      .catch((err) => console.error("[upload] scheduled upload failed", err));
  }, DEBOUNCE_MS);
}

/** The url-tvg for the uploaded M3U: the uploaded EPG's own public URL, so the
    uploaded playlist is self-contained. Empty when the destination has no public
    URL base set, in which case the M3U just carries no guide link. */
function resolveEpgUrl(dest: UploadDestination): string {
  return dest.publicUrlBase ? joinUrl(dest.publicUrlBase, dest.epgPath) : "";
}

function joinUrl(base: string, path: string): string {
  return `${trimTrailingSlash(base)}/${path.replace(/^\/+/, "")}`;
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
