import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db/index.server";
import {
  playlistCategories,
  playlistChannels,
  playlists,
  sourceChanges,
  sourceChannels,
} from "~/db/schema";

type PlaylistRef = { id: number; name: string };

// SQLite caps bound variables per statement, so insert in batches.
const INSERT_CHUNK = 200;

export type BeforeChannel = {
  name: string;
  categoryName: string | null;
  available: boolean;
};
export type SeenChannel = {
  streamId: string;
  name: string;
  categoryName: string | null;
};

type NewChange = {
  kind:
    | "channel_added"
    | "channel_removed"
    | "channel_returned"
    | "category_added"
    | "category_removed";
  name: string;
  categoryName: string | null;
  streamId: string | null;
  playlists?: PlaylistRef[] | null;
};

/** Work out which playlists each change touches, snapshotting playlist name + id
    now so the log survives later renames/deletes. A channel is touched by any
    playlist that added it directly, or whose auto-sync category mirrors its source
    category; a category change touches playlists whose auto-sync mirrors it. */
function attachPlaylists(sourceId: number, changes: NewChange[]) {
  const streamIds = changes
    .map((c) => c.streamId)
    .filter((s): s is string => s != null);

  // streamId -> source_channels.id (rows persist even when unavailable).
  const scIdByStream = new Map<string, number>();
  if (streamIds.length) {
    for (const r of db
      .select({ id: sourceChannels.id, streamId: sourceChannels.streamId })
      .from(sourceChannels)
      .where(
        and(
          eq(sourceChannels.sourceId, sourceId),
          inArray(sourceChannels.streamId, streamIds),
        ),
      )
      .all()) {
      scIdByStream.set(r.streamId, r.id);
    }
  }

  // Manual membership: source_channel id -> playlists that added it.
  const manualByChannel = new Map<number, PlaylistRef[]>();
  const scIds = [...scIdByStream.values()];
  if (scIds.length) {
    for (const r of db
      .select({
        scId: playlistChannels.sourceChannelId,
        id: playlists.id,
        name: playlists.name,
      })
      .from(playlistChannels)
      .innerJoin(playlists, eq(playlists.id, playlistChannels.playlistId))
      .where(inArray(playlistChannels.sourceChannelId, scIds))
      .all()) {
      const list = manualByChannel.get(r.scId) ?? [];
      list.push({ id: r.id, name: r.name });
      manualByChannel.set(r.scId, list);
    }
  }

  // Auto membership: source category name -> playlists mirroring it.
  const autoByCategory = new Map<string, PlaylistRef[]>();
  for (const r of db
    .select({
      cat: playlistCategories.autoCategoryName,
      id: playlists.id,
      name: playlists.name,
    })
    .from(playlistCategories)
    .innerJoin(playlists, eq(playlists.id, playlistCategories.playlistId))
    .where(eq(playlistCategories.autoSourceId, sourceId))
    .all()) {
    if (!r.cat) continue;
    const list = autoByCategory.get(r.cat) ?? [];
    list.push({ id: r.id, name: r.name });
    autoByCategory.set(r.cat, list);
  }

  for (const c of changes) {
    const byId = new Map<number, string>();
    if (c.streamId) {
      const scId = scIdByStream.get(c.streamId);
      if (scId != null) {
        for (const p of manualByChannel.get(scId) ?? []) byId.set(p.id, p.name);
      }
    }
    // For channel changes the category is on `categoryName`; for category changes
    // it's the row's `name`.
    const cat = c.categoryName ?? (c.streamId ? null : c.name);
    if (cat) for (const p of autoByCategory.get(cat) ?? []) byId.set(p.id, p.name);
    c.playlists = byId.size
      ? [...byId].map(([id, name]) => ({ id, name }))
      : null;
  }
}

/** Diff a sync and log what the provider added/removed. `before` is the source's
    channels snapshotted before the sync touched anything; `seen` is the streams
    the provider returned this sync. Logging never throws into the sync. */
export function recordSyncChanges(
  sourceId: number,
  before: Map<string, BeforeChannel>,
  seen: SeenChannel[],
  syncedAt: Date,
) {
  // First sync of a source: nothing existed before, so the whole catalog would
  // log as "added". Treat it as a baseline and record nothing.
  if (before.size === 0) return;

  const changes: NewChange[] = [];
  const seenIds = new Set(seen.map((s) => s.streamId));

  for (const s of seen) {
    const prev = before.get(s.streamId);
    if (!prev) {
      changes.push({
        kind: "channel_added",
        name: s.name,
        categoryName: s.categoryName,
        streamId: s.streamId,
      });
    } else if (!prev.available) {
      changes.push({
        kind: "channel_returned",
        name: s.name,
        categoryName: s.categoryName,
        streamId: s.streamId,
      });
    }
  }

  for (const [streamId, prev] of before) {
    if (prev.available && !seenIds.has(streamId)) {
      changes.push({
        kind: "channel_removed",
        name: prev.name,
        categoryName: prev.categoryName,
        streamId,
      });
    }
  }

  // Categories: a name is "added" if it wasn't present before at all (even via an
  // unavailable channel); "removed" if it had available channels before and none now.
  const beforeAll = new Set<string>();
  const beforeAvailable = new Set<string>();
  for (const prev of before.values()) {
    if (!prev.categoryName) continue;
    beforeAll.add(prev.categoryName);
    if (prev.available) beforeAvailable.add(prev.categoryName);
  }
  const nowAvailable = new Set<string>();
  for (const s of seen) if (s.categoryName) nowAvailable.add(s.categoryName);

  for (const name of nowAvailable) {
    if (!beforeAll.has(name)) {
      changes.push({ kind: "category_added", name, categoryName: null, streamId: null });
    }
  }
  for (const name of beforeAvailable) {
    if (!nowAvailable.has(name)) {
      changes.push({ kind: "category_removed", name, categoryName: null, streamId: null });
    }
  }

  if (changes.length === 0) return;

  attachPlaylists(sourceId, changes);

  for (let i = 0; i < changes.length; i += INSERT_CHUNK) {
    db.insert(sourceChanges)
      .values(
        changes.slice(i, i + INSERT_CHUNK).map((c) => ({
          sourceId,
          syncedAt,
          kind: c.kind,
          name: c.name,
          categoryName: c.categoryName,
          streamId: c.streamId,
          playlists: c.playlists ?? null,
        })),
      )
      .run();
  }
}

/** One row per sync that recorded changes, newest first, with add/remove counts.
    Light enough to load the full history for the sync picker. */
export function listSyncs(sourceId: number) {
  return db
    .select({
      syncedAt: sourceChanges.syncedAt,
      added: sql<number>`sum(case when ${sourceChanges.kind} in ('channel_added','category_added','channel_returned') then 1 else 0 end)`,
      removed: sql<number>`sum(case when ${sourceChanges.kind} in ('channel_removed','category_removed') then 1 else 0 end)`,
    })
    .from(sourceChanges)
    .where(eq(sourceChanges.sourceId, sourceId))
    .groupBy(sourceChanges.syncedAt)
    .orderBy(desc(sourceChanges.syncedAt))
    .all();
}

/** Every change from one sync. */
export function changesForSync(sourceId: number, syncedAt: Date) {
  return db
    .select()
    .from(sourceChanges)
    .where(
      and(
        eq(sourceChanges.sourceId, sourceId),
        eq(sourceChanges.syncedAt, syncedAt),
      ),
    )
    .orderBy(asc(sourceChanges.id))
    .all();
}
