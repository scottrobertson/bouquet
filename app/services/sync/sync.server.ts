import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "~/db/index.server";
import {
  epgProgrammes,
  sourceCategories,
  sourceChannels,
  sourceEpgChannels,
  sources,
} from "~/db/schema";
import { invalidateAll } from "~/services/output/cache.server";
import {
  recordSyncChanges,
  type BeforeChannel,
  type SeenChannel,
} from "~/services/sources/changes.server";
import type { XtreamCreds } from "~/services/xtream/client.server";
import { syncSourceCategories } from "~/services/sources/categories.server";
import {
  fetchLiveCategories,
  fetchLiveStreams,
  fetchSimpleDataTable,
  validateAccount,
} from "~/services/xtream/client.server";

// SQLite caps bound variables per statement, so insert EPG rows in batches.
const EPG_INSERT_CHUNK = 200;
// Programme rows have more columns, so use a smaller batch to stay under the cap.
const PROGRAMME_INSERT_CHUNK = 200;
// How long to keep programmes for sources that stop syncing.
const GUIDE_RETENTION_DAYS = 7;
// EPG is now one request per channel, so fetch a handful at a time instead of
// hammering the provider with all of them at once.
const EPG_FETCH_CONCURRENCY = 10;

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

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

    // Snapshot the catalog before we touch it, so we can log what this sync
    // added/removed once it's done.
    const before = new Map<string, BeforeChannel>(
      db
        .select({
          streamId: sourceChannels.streamId,
          name: sourceChannels.name,
          categoryName: sourceChannels.categoryName,
          available: sourceChannels.available,
        })
        .from(sourceChannels)
        .where(eq(sourceChannels.sourceId, sourceId))
        .all()
        .map((r) => [
          r.streamId,
          { name: r.name, categoryName: r.categoryName, available: r.available },
        ]),
    );
    const seen: SeenChannel[] = [];

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
      seen.push({ streamId: stream.streamId, name: stream.name, categoryName });
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
          tvArchiveDuration: stream.tvArchiveDuration,
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
            tvArchiveDuration: stream.tvArchiveDuration,
            available: true,
            lastSeenAt: now,
          },
        })
        .run();
    });

    // Seed category rows. New ones honor the source's auto-import setting.
    syncSourceCategories(sourceId, [...seenCategories], source.autoImportGroups);

    // Commit channel success now, before the slower EPG step. Cache the real
    // base URL from server_info so output stream URLs use it (keep the old one
    // if the provider didn't return server_info this time).
    db.update(sources)
      .set({
        syncStatus: "ok",
        lastSyncedAt: now,
        lastError: null,
        channelCount: streams.length,
        ...(account.streamBaseUrl ? { streamBaseUrl: account.streamBaseUrl } : {}),
      })
      .where(eq(sources.id, sourceId))
      .run();

    // Drop cached output so auto-sync categories and availability changes reach
    // players on the next poll instead of waiting out the cache TTL.
    invalidateAll();

    // Log what changed for the source's history. Never let it break a sync.
    try {
      recordSyncChanges(sourceId, before, seen, now);
    } catch (err) {
      console.error("[sync] recording changes failed", err);
    }
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

  // Step 2: EPG. Best effort. A failure here keeps the sync "ok" but records a
  // note, so the catalog stays usable even if the guide is missing. We pull the
  // guide per channel from get_simple_data_table, which (unlike xmltv.php)
  // includes recently-aired programmes, and replace each channel's stored rows
  // so the guide mirrors what the provider currently serves.
  try {
    // Only fetch channels that can actually show up in output: those in an
    // enabled category (or with no category at all), matching the output query.
    // Channels sharing an epg id share a guide, so fetch each id only once.
    const eligible = db
      .select({
        streamId: sourceChannels.streamId,
        epgChannelId: sourceChannels.epgChannelId,
      })
      .from(sourceChannels)
      .leftJoin(
        sourceCategories,
        and(
          eq(sourceCategories.sourceId, sourceChannels.sourceId),
          eq(sourceCategories.name, sourceChannels.categoryName),
        ),
      )
      .where(
        and(
          eq(sourceChannels.sourceId, sourceId),
          eq(sourceChannels.available, true),
          or(isNull(sourceCategories.id), eq(sourceCategories.enabled, true)),
        ),
      )
      .all();

    const streamByEpgId = new Map<string, string>();
    for (const r of eligible) {
      if (r.epgChannelId && !streamByEpgId.has(r.epgChannelId)) {
        streamByEpgId.set(r.epgChannelId, r.streamId);
      }
    }

    // The matching dropdown lists the source's epg ids; rebuild it from the
    // catalog now that we no longer fetch xmltv.php for channel definitions.
    refreshSourceEpgChannels(sourceId);

    const targets = [...streamByEpgId.entries()];
    let failures = 0;
    const perChannel = await mapPool(
      targets,
      EPG_FETCH_CONCURRENCY,
      async ([epgId, streamId]) => {
        try {
          return await fetchSimpleDataTable(creds, streamId, epgId);
        } catch {
          failures++;
          return null;
        }
      },
    );

    // If we couldn't reach the provider for any channel, treat EPG as failed
    // and leave the existing rows untouched.
    if (targets.length > 0 && failures === targets.length) {
      throw new Error("every channel's EPG request failed");
    }

    // Replace stored rows for the channels we did fetch. Channels whose fetch
    // failed keep their previous programmes rather than going blank.
    db.transaction((tx) => {
      for (let i = 0; i < perChannel.length; i++) {
        const programmes = perChannel[i];
        if (programmes === null) continue;
        const epgId = targets[i][0];
        tx.delete(epgProgrammes)
          .where(
            and(
              eq(epgProgrammes.sourceId, sourceId),
              eq(epgProgrammes.channelId, epgId),
            ),
          )
          .run();
        for (let j = 0; j < programmes.length; j += PROGRAMME_INSERT_CHUNK) {
          tx.insert(epgProgrammes)
            .values(
              programmes.slice(j, j + PROGRAMME_INSERT_CHUNK).map((p) => ({
                sourceId,
                channelId: p.channelId,
                startTs: p.startTs,
                stopTs: p.stopTs,
                title: p.title,
                subTitle: null,
                description: p.description,
                category: null,
                hasArchive: p.hasArchive,
              })),
            )
            .run();
        }
      }
    });

    // Stored programmes now match the current enabled categories.
    db.update(sources)
      .set({ epgStale: false })
      .where(eq(sources.id, sourceId))
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    db.update(sources)
      .set({ lastError: `Channels synced. EPG update failed: ${msg}` })
      .where(eq(sources.id, sourceId))
      .run();
  }
}

/** Rebuild a source's epg channel list (the matching dropdown) from its
    catalog: one entry per distinct epg id, named after the channel. */
function refreshSourceEpgChannels(sourceId: number): void {
  const rows = db
    .select({
      epgChannelId: sourceChannels.epgChannelId,
      name: sourceChannels.name,
      logo: sourceChannels.logo,
    })
    .from(sourceChannels)
    .where(
      and(
        eq(sourceChannels.sourceId, sourceId),
        eq(sourceChannels.available, true),
      ),
    )
    .orderBy(asc(sourceChannels.position), asc(sourceChannels.id))
    .all();

  const byId = new Map<string, { displayName: string; icon: string | null }>();
  for (const r of rows) {
    if (!r.epgChannelId || byId.has(r.epgChannelId)) continue;
    byId.set(r.epgChannelId, { displayName: r.name, icon: r.logo });
  }

  const entries = [...byId.entries()];
  db.transaction((tx) => {
    tx.delete(sourceEpgChannels)
      .where(eq(sourceEpgChannels.sourceId, sourceId))
      .run();
    for (let i = 0; i < entries.length; i += EPG_INSERT_CHUNK) {
      tx.insert(sourceEpgChannels)
        .values(
          entries.slice(i, i + EPG_INSERT_CHUNK).map(([channelId, v]) => ({
            sourceId,
            channelId,
            displayName: v.displayName,
            icon: v.icon,
          })),
        )
        .run();
    }
  });
}

/** Drop programmes that ended more than the retention window ago. Each sync
    already replaces a source's rows, so this only matters for sources that have
    stopped syncing. */
export function pruneOldProgrammes(): void {
  const cutoff = Math.floor(Date.now() / 1000) - GUIDE_RETENTION_DAYS * 86400;
  db.delete(epgProgrammes).where(lt(epgProgrammes.stopTs, cutoff)).run();
}

/** Has this source's refresh interval elapsed since its last sync? A 0 interval
    means manual only, so it's never due from the scheduler. */
export function isSyncDue(
  lastSyncedAt: Date | null,
  intervalMinutes: number,
  now: number,
): boolean {
  if (intervalMinutes <= 0) return false;
  if (!lastSyncedAt) return true;
  return now - lastSyncedAt.getTime() >= intervalMinutes * 60_000;
}

/** Sync the sources whose interval has elapsed, one at a time so we don't hammer
    providers in parallel. Run hourly by the cron job; most ticks sync nothing. */
export async function syncDueSources(): Promise<void> {
  const now = Date.now();
  const all = db
    .select({
      id: sources.id,
      lastSyncedAt: sources.lastSyncedAt,
      syncIntervalMinutes: sources.syncIntervalMinutes,
    })
    .from(sources)
    .all();
  for (const s of all) {
    if (isSyncDue(s.lastSyncedAt, s.syncIntervalMinutes, now)) {
      await runSync(s.id);
    }
  }
  pruneOldProgrammes();
}
