import { and, eq, inArray } from "drizzle-orm";
import { db } from "~/db/index.server";
import {
  playlistCategories,
  playlistChannels,
  sourceChannels,
} from "~/db/schema";
import { nextCategoryPosition, nextChannelPosition } from "./queries.server";

/** Confirm a category belongs to the playlist before we touch it. */
function categoryInPlaylist(playlistId: number, categoryId: number) {
  return !!db
    .select({ id: playlistCategories.id })
    .from(playlistCategories)
    .where(
      and(
        eq(playlistCategories.id, categoryId),
        eq(playlistCategories.playlistId, playlistId),
      ),
    )
    .get();
}

/** Confirm a playlist channel belongs to the playlist. */
function channelInPlaylist(playlistId: number, channelId: number) {
  return !!db
    .select({ id: playlistChannels.id })
    .from(playlistChannels)
    .where(
      and(
        eq(playlistChannels.id, channelId),
        eq(playlistChannels.playlistId, playlistId),
      ),
    )
    .get();
}

export function createCategory(playlistId: number, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return db
    .insert(playlistCategories)
    .values({
      playlistId,
      name: trimmed,
      position: nextCategoryPosition(playlistId),
    })
    .returning()
    .get();
}

export function renameCategory(
  playlistId: number,
  categoryId: number,
  name: string,
) {
  const trimmed = name.trim();
  if (!trimmed || !categoryInPlaylist(playlistId, categoryId)) return;
  db.update(playlistCategories)
    .set({ name: trimmed })
    .where(eq(playlistCategories.id, categoryId))
    .run();
}

export function deleteCategory(playlistId: number, categoryId: number) {
  if (!categoryInPlaylist(playlistId, categoryId)) return;
  // Channels cascade via the foreign key.
  db.delete(playlistCategories)
    .where(eq(playlistCategories.id, categoryId))
    .run();
}

/** Persist the order of categories. ids must all belong to the playlist. */
export function reorderCategories(playlistId: number, ids: number[]) {
  const owned = db
    .select({ id: playlistCategories.id })
    .from(playlistCategories)
    .where(eq(playlistCategories.playlistId, playlistId))
    .all()
    .map((r) => r.id);
  const ownedSet = new Set(owned);
  db.transaction((tx) => {
    ids.forEach((id, i) => {
      if (!ownedSet.has(id)) return;
      tx.update(playlistCategories)
        .set({ position: i })
        .where(eq(playlistCategories.id, id))
        .run();
    });
  });
}

/** Add many source channels into a category at the end, defaulting EPG to the channel's own. */
export function addChannels(
  playlistId: number,
  categoryId: number,
  sourceChannelIds: number[],
) {
  if (!categoryInPlaylist(playlistId, categoryId) || sourceChannelIds.length === 0) {
    return 0;
  }

  const channels = db
    .select({
      id: sourceChannels.id,
      sourceId: sourceChannels.sourceId,
      epgChannelId: sourceChannels.epgChannelId,
    })
    .from(sourceChannels)
    .where(inArray(sourceChannels.id, sourceChannelIds))
    .all();

  // Skip channels already in this category so re-adding does not duplicate.
  const existing = new Set(
    db
      .select({ sourceChannelId: playlistChannels.sourceChannelId })
      .from(playlistChannels)
      .where(eq(playlistChannels.categoryId, categoryId))
      .all()
      .map((r) => r.sourceChannelId),
  );

  let position = nextChannelPosition(categoryId);
  let added = 0;
  db.transaction((tx) => {
    for (const ch of channels) {
      if (existing.has(ch.id)) continue;
      tx.insert(playlistChannels)
        .values({
          playlistId,
          categoryId,
          sourceChannelId: ch.id,
          position: position++,
          epgSourceId: ch.sourceId,
          epgChannelId: ch.epgChannelId,
        })
        .run();
      added++;
    }
  });
  return added;
}

/** Persist a drag: move one channel to a category and reorder the affected categories. */
export function reorderChannels(
  playlistId: number,
  movedId: number,
  toCategoryId: number,
  order: Record<string, number[]>,
) {
  if (
    !channelInPlaylist(playlistId, movedId) ||
    !categoryInPlaylist(playlistId, toCategoryId)
  ) {
    return;
  }

  // Only touch channels that belong to this playlist.
  const owned = new Set(
    db
      .select({ id: playlistChannels.id })
      .from(playlistChannels)
      .where(eq(playlistChannels.playlistId, playlistId))
      .all()
      .map((r) => r.id),
  );

  db.transaction((tx) => {
    tx.update(playlistChannels)
      .set({ categoryId: toCategoryId })
      .where(eq(playlistChannels.id, movedId))
      .run();

    for (const [catId, ids] of Object.entries(order)) {
      const categoryId = Number(catId);
      if (!categoryInPlaylist(playlistId, categoryId)) continue;
      ids.forEach((id, i) => {
        if (!owned.has(id)) return;
        tx.update(playlistChannels)
          .set({ position: i, categoryId })
          .where(eq(playlistChannels.id, id))
          .run();
      });
    }
  });
}

export function renameChannel(
  playlistId: number,
  channelId: number,
  customName: string,
) {
  if (!channelInPlaylist(playlistId, channelId)) return;
  const trimmed = customName.trim();
  db.update(playlistChannels)
    .set({ customName: trimmed || null })
    .where(eq(playlistChannels.id, channelId))
    .run();
}

export function toggleChannel(
  playlistId: number,
  channelId: number,
  enabled: boolean,
) {
  if (!channelInPlaylist(playlistId, channelId)) return;
  db.update(playlistChannels)
    .set({ enabled })
    .where(eq(playlistChannels.id, channelId))
    .run();
}

export function setEpg(
  playlistId: number,
  channelId: number,
  epgSourceId: number | null,
  epgChannelId: string | null,
) {
  if (!channelInPlaylist(playlistId, channelId)) return;
  db.update(playlistChannels)
    .set({ epgSourceId, epgChannelId })
    .where(eq(playlistChannels.id, channelId))
    .run();
}

export function removeChannel(playlistId: number, channelId: number) {
  if (!channelInPlaylist(playlistId, channelId)) return;
  db.delete(playlistChannels)
    .where(eq(playlistChannels.id, channelId))
    .run();
}

/** Scope a set of channel ids to the ones that belong to the playlist. */
function ownedChannels(playlistId: number, channelIds: number[]) {
  if (channelIds.length === 0) return new Set<number>();
  return new Set(
    db
      .select({ id: playlistChannels.id })
      .from(playlistChannels)
      .where(
        and(
          inArray(playlistChannels.id, channelIds),
          eq(playlistChannels.playlistId, playlistId),
        ),
      )
      .all()
      .map((r) => r.id),
  );
}

export function bulkToggle(
  playlistId: number,
  channelIds: number[],
  enabled: boolean,
) {
  const ids = [...ownedChannels(playlistId, channelIds)];
  if (!ids.length) return;
  db.update(playlistChannels)
    .set({ enabled })
    .where(inArray(playlistChannels.id, ids))
    .run();
}

export function bulkRemove(playlistId: number, channelIds: number[]) {
  const ids = [...ownedChannels(playlistId, channelIds)];
  if (!ids.length) return;
  db.delete(playlistChannels).where(inArray(playlistChannels.id, ids)).run();
}

export function bulkMove(
  playlistId: number,
  channelIds: number[],
  toCategoryId: number,
) {
  if (!categoryInPlaylist(playlistId, toCategoryId)) return;
  const ids = [...ownedChannels(playlistId, channelIds)];
  if (!ids.length) return;
  let position = nextChannelPosition(toCategoryId);
  db.transaction((tx) => {
    for (const id of ids) {
      tx.update(playlistChannels)
        .set({ categoryId: toCategoryId, position: position++ })
        .where(eq(playlistChannels.id, id))
        .run();
    }
  });
}

/** Reset EPG on each channel to its own source's default. */
export function bulkResetEpg(playlistId: number, channelIds: number[]) {
  const ids = [...ownedChannels(playlistId, channelIds)];
  if (!ids.length) return;
  db.transaction((tx) => {
    const rows = tx
      .select({
        id: playlistChannels.id,
        sourceId: sourceChannels.sourceId,
        epgChannelId: sourceChannels.epgChannelId,
      })
      .from(playlistChannels)
      .innerJoin(
        sourceChannels,
        eq(playlistChannels.sourceChannelId, sourceChannels.id),
      )
      .where(inArray(playlistChannels.id, ids))
      .all();
    for (const r of rows) {
      tx.update(playlistChannels)
        .set({ epgSourceId: r.sourceId, epgChannelId: r.epgChannelId })
        .where(eq(playlistChannels.id, r.id))
        .run();
    }
  });
}
