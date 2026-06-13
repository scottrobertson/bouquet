import { eq } from "drizzle-orm";
import { db } from "~/db/index.server";
import { sourceChannels, sourceEpgChannels, sources } from "~/db/schema";
import { invalidateAll } from "~/services/output/cache.server";
import type { XtreamCreds } from "~/services/xtream/client.server";
import { syncSourceCategories } from "~/services/sources/categories.server";
import {
  fetchEpgChannels,
  fetchLiveCategories,
  fetchLiveStreams,
  validateAccount,
} from "~/services/xtream/client.server";

// SQLite caps bound variables per statement, so insert EPG rows in batches.
const EPG_INSERT_CHUNK = 200;

/** Kick a sync without waiting for it. Marks the source as syncing right away
    so the UI updates immediately, then runs the (slow) fetch in the background.
    Callers return instantly; the UI polls until the status flips. */
export function startSync(sourceId: number): void {
  db.update(sources)
    .set({ syncStatus: "syncing" })
    .where(eq(sources.id, sourceId))
    .run();

  void runSync(sourceId).catch((err) => {
    db.update(sources)
      .set({
        syncStatus: "error",
        lastError: err instanceof Error ? err.message : "Sync failed",
      })
      .where(eq(sources.id, sourceId))
      .run();
  });
}

/** Pull a source's full catalog and EPG channel list, marking anything the
    provider no longer returns as unavailable instead of deleting it. The
    channel sync commits its success before the EPG step, so a slow or failing
    EPG fetch never throws away a good catalog sync. */
export async function runSync(sourceId: number): Promise<void> {
  const source = db
    .select()
    .from(sources)
    .where(eq(sources.id, sourceId))
    .get();
  if (!source) return;

  db.update(sources)
    .set({ syncStatus: "syncing" })
    .where(eq(sources.id, sourceId))
    .run();

  const creds: XtreamCreds = {
    serverUrl: source.serverUrl,
    username: source.username,
    password: source.password,
  };

  const now = new Date();

  // Step 1: channels. This is the critical part. If it fails, the sync fails.
  try {
    const account = await validateAccount(creds);
    if (!account.ok) {
      db.update(sources)
        .set({
          syncStatus: "error",
          lastError: account.message ?? "Account validation failed",
        })
        .where(eq(sources.id, sourceId))
        .run();
      return;
    }

    const categories = await fetchLiveCategories(creds);
    const categoryNames = new Map(
      categories.map((c) => [c.categoryId, c.categoryName]),
    );
    const streams = await fetchLiveStreams(creds);

    // Mark everything unavailable first, then the upsert below flips the
    // channels still present back to available.
    db.update(sourceChannels)
      .set({ available: false })
      .where(eq(sourceChannels.sourceId, sourceId))
      .run();

    const seenCategories = new Set<string>();
    streams.forEach((stream, position) => {
      const categoryName = stream.categoryId
        ? (categoryNames.get(stream.categoryId) ?? null)
        : null;
      if (categoryName) seenCategories.add(categoryName);
      db.insert(sourceChannels)
        .values({
          sourceId,
          streamId: stream.streamId,
          name: stream.name,
          logo: stream.logo,
          epgChannelId: stream.epgChannelId,
          categoryName,
          position,
          tvArchive: stream.tvArchive,
          available: true,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [sourceChannels.sourceId, sourceChannels.streamId],
          set: {
            name: stream.name,
            logo: stream.logo,
            epgChannelId: stream.epgChannelId,
            categoryName,
            position,
            tvArchive: stream.tvArchive,
            available: true,
            lastSeenAt: now,
          },
        })
        .run();
    });

    // Seed category rows so new ones default to enabled and toggles persist.
    syncSourceCategories(sourceId, [...seenCategories]);

    // Commit channel success now, before the slower EPG step.
    db.update(sources)
      .set({
        syncStatus: "ok",
        lastSyncedAt: now,
        lastError: null,
        channelCount: streams.length,
      })
      .where(eq(sources.id, sourceId))
      .run();

    // Drop cached output so auto-sync categories and availability changes reach
    // players on the next poll instead of waiting out the cache TTL.
    invalidateAll();
  } catch (err) {
    db.update(sources)
      .set({
        syncStatus: "error",
        lastError: err instanceof Error ? err.message : "Sync failed",
      })
      .where(eq(sources.id, sourceId))
      .run();
    return;
  }

  // Step 2: EPG channels. Best effort. A failure here keeps the sync "ok" but
  // records a note, so the catalog stays usable even if the guide is missing.
  try {
    const epgChannels = await fetchEpgChannels(creds);
    db.delete(sourceEpgChannels)
      .where(eq(sourceEpgChannels.sourceId, sourceId))
      .run();
    for (let i = 0; i < epgChannels.length; i += EPG_INSERT_CHUNK) {
      const chunk = epgChannels.slice(i, i + EPG_INSERT_CHUNK);
      db.insert(sourceEpgChannels)
        .values(
          chunk.map((c) => ({
            sourceId,
            channelId: c.channelId,
            displayName: c.displayName,
            icon: c.icon,
          })),
        )
        .run();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    db.update(sources)
      .set({ lastError: `Channels synced. EPG update failed: ${msg}` })
      .where(eq(sources.id, sourceId))
      .run();
  }
}

/** Sync every source one at a time so we don't hammer providers in parallel.
    Used by the scheduled cron job, which waits for completion. */
export async function syncAllSources(): Promise<void> {
  const all = db.select({ id: sources.id }).from(sources).all();
  for (const s of all) {
    await runSync(s.id);
  }
}
