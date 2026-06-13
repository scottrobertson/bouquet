import { and, asc, eq, inArray } from "drizzle-orm";
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

/** An auto-sync category mirrors a source category and owns no editable
    channels, so channel mutations must refuse to touch it. */
function categoryIsAuto(categoryId: number) {
  const row = db
    .select({ autoSourceId: playlistCategories.autoSourceId })
    .from(playlistCategories)
    .where(eq(playlistCategories.id, categoryId))
    .get();
  return row?.autoSourceId != null;
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

/** Create a category that mirrors one source category live (read-only). */
export function createAutoCategory(
  playlistId: number,
  sourceId: number,
  categoryName: string,
  name: string,
) {
  const trimmed = name.trim();
  if (!trimmed || !categoryName.trim()) return null;
  return db
    .insert(playlistCategories)
    .values({
      playlistId,
      name: trimmed,
      position: nextCategoryPosition(playlistId),
      autoSourceId: sourceId,
      autoCategoryName: categoryName,
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

/** Add many source channels into a category, defaulting EPG to the channel's
    own. Appends by default, or inserts at insertIndex within the category. */
export function addChannels(
  playlistId: number,
  categoryId: number,
  sourceChannelIds: number[],
  insertIndex?: number,
) {
  if (
    !categoryInPlaylist(playlistId, categoryId) ||
    categoryIsAuto(categoryId) ||
    sourceChannelIds.length === 0
  ) {
    return 0;
  }

  // Preserve the order the ids were given in.
  const order = new Map(sourceChannelIds.map((id, i) => [id, i]));
  const channels = db
    .select({
      id: sourceChannels.id,
      sourceId: sourceChannels.sourceId,
      epgChannelId: sourceChannels.epgChannelId,
    })
    .from(sourceChannels)
    .where(inArray(sourceChannels.id, sourceChannelIds))
    .all()
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  // Skip channels already in this category so re-adding does not duplicate.
  const existing = new Set(
    db
      .select({ sourceChannelId: playlistChannels.sourceChannelId })
      .from(playlistChannels)
      .where(eq(playlistChannels.categoryId, categoryId))
      .all()
      .map((r) => r.sourceChannelId),
  );
  const toAdd = channels.filter((ch) => !existing.has(ch.id));
  if (toAdd.length === 0) return 0;

  db.transaction((tx) => {
    const current = tx
      .select({ id: playlistChannels.id })
      .from(playlistChannels)
      .where(eq(playlistChannels.categoryId, categoryId))
      .orderBy(asc(playlistChannels.position), asc(playlistChannels.id))
      .all()
      .map((r) => r.id);

    const newIds = toAdd.map(
      (ch) =>
        tx
          .insert(playlistChannels)
          .values({
            playlistId,
            categoryId,
            sourceChannelId: ch.id,
            position: 0,
            epgSourceId: ch.sourceId,
            epgChannelId: ch.epgChannelId,
          })
          .returning({ id: playlistChannels.id })
          .get().id,
    );

    const at =
      insertIndex == null
        ? current.length
        : Math.max(0, Math.min(insertIndex, current.length));
    const ordered = [...current.slice(0, at), ...newIds, ...current.slice(at)];
    ordered.forEach((id, i) => {
      tx.update(playlistChannels)
        .set({ position: i })
        .where(eq(playlistChannels.id, id))
        .run();
    });
  });
  return toAdd.length;
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
    !categoryInPlaylist(playlistId, toCategoryId) ||
    categoryIsAuto(toCategoryId)
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
  // Renaming back to the source name clears the custom name (not a real rename).
  const row = db
    .select({ sourceName: sourceChannels.name })
    .from(playlistChannels)
    .innerJoin(
      sourceChannels,
      eq(playlistChannels.sourceChannelId, sourceChannels.id),
    )
    .where(eq(playlistChannels.id, channelId))
    .get();
  const next = trimmed && trimmed !== row?.sourceName ? trimmed : null;
  db.update(playlistChannels)
    .set({ customName: next })
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
  if (!categoryInPlaylist(playlistId, toCategoryId) || categoryIsAuto(toCategoryId)) {
    return;
  }
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

/** Apply a name transform to each selected channel. Works off the current
    display name (custom name, or the source name), and clears the custom name
    when the result lands back on the source name. */
function bulkRename(
  playlistId: number,
  channelIds: number[],
  transform: (current: string) => string,
) {
  const ids = [...ownedChannels(playlistId, channelIds)];
  if (!ids.length) return;
  db.transaction((tx) => {
    const rows = tx
      .select({
        id: playlistChannels.id,
        customName: playlistChannels.customName,
        sourceName: sourceChannels.name,
      })
      .from(playlistChannels)
      .innerJoin(
        sourceChannels,
        eq(playlistChannels.sourceChannelId, sourceChannels.id),
      )
      .where(inArray(playlistChannels.id, ids))
      .all();
    for (const r of rows) {
      const current = r.customName ?? r.sourceName;
      const result = transform(current).trim();
      const next = result && result !== r.sourceName ? result : null;
      tx.update(playlistChannels)
        .set({ customName: next })
        .where(eq(playlistChannels.id, r.id))
        .run();
    }
  });
}

export function bulkAddPrefix(playlistId: number, ids: number[], prefix: string) {
  if (!prefix) return;
  bulkRename(playlistId, ids, (current) => prefix + current);
}

export function bulkAddSuffix(playlistId: number, ids: number[], suffix: string) {
  if (!suffix) return;
  bulkRename(playlistId, ids, (current) => current + suffix);
}

/** Replace every occurrence of `search` with `replace` (literal, not regex).
    Pass an empty `replace` to just remove the matched text. */
export function bulkReplace(
  playlistId: number,
  ids: number[],
  search: string,
  replace: string,
) {
  if (!search) return;
  bulkRename(playlistId, ids, (current) => current.split(search).join(replace));
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
