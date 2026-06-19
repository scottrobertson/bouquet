import { and, asc, eq, inArray, sql } from "drizzle-orm";
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Renumber a primary's alternates to a gap-free 0..n by current order. */
function renumberAlternates(tx: Tx, primaryId: number) {
  const alts = tx
    .select({ id: playlistChannels.id })
    .from(playlistChannels)
    .where(eq(playlistChannels.primaryChannelId, primaryId))
    .orderBy(asc(playlistChannels.altPosition), asc(playlistChannels.id))
    .all();
  alts.forEach((a, i) => {
    tx.update(playlistChannels)
      .set({ altPosition: i })
      .where(eq(playlistChannels.id, a.id))
      .run();
  });
}

/** Snap every alternate in the playlist into its primary's category, so a
    primary moving categories drags its alternates along. */
function keepAlternatesWithPrimary(tx: Tx, playlistId: number) {
  const catById = new Map(
    tx
      .select({
        id: playlistChannels.id,
        categoryId: playlistChannels.categoryId,
        primaryChannelId: playlistChannels.primaryChannelId,
      })
      .from(playlistChannels)
      .where(eq(playlistChannels.playlistId, playlistId))
      .all()
      .map((r) => [r.id, r]),
  );
  for (const r of catById.values()) {
    if (r.primaryChannelId == null) continue;
    const target = catById.get(r.primaryChannelId)?.categoryId;
    if (target != null && target !== r.categoryId) {
      tx.update(playlistChannels)
        .set({ categoryId: target })
        .where(eq(playlistChannels.id, r.id))
        .run();
    }
  }
}

/** Delete the given channels. When a deleted channel is a primary with a
    surviving alternate, the first alternate is promoted to primary and keeps
    the old primary's name and position, so the channel stays put. */
function performRemove(idList: number[]) {
  const deleteSet = new Set(idList);
  if (!deleteSet.size) return;
  db.transaction((tx) => {
    const rows = tx
      .select({
        id: playlistChannels.id,
        primaryChannelId: playlistChannels.primaryChannelId,
        position: playlistChannels.position,
      })
      .from(playlistChannels)
      .where(inArray(playlistChannels.id, idList))
      .all();

    // Promote a surviving alternate for each deleted primary.
    for (const r of rows) {
      const alts = tx
        .select({ id: playlistChannels.id })
        .from(playlistChannels)
        .where(eq(playlistChannels.primaryChannelId, r.id))
        .orderBy(asc(playlistChannels.altPosition), asc(playlistChannels.id))
        .all()
        .filter((a) => !deleteSet.has(a.id));
      if (!alts.length) continue;
      const newPrimaryId = alts[0].id;
      // The promoted alternate reverts to its own name (it had none as an
      // alternate); it takes the deleted primary's list position.
      tx.update(playlistChannels)
        .set({
          primaryChannelId: null,
          altPosition: 0,
          position: r.position,
          customName: null,
        })
        .where(eq(playlistChannels.id, newPrimaryId))
        .run();
      alts.slice(1).forEach((a, i) => {
        tx.update(playlistChannels)
          .set({ primaryChannelId: newPrimaryId, altPosition: i })
          .where(eq(playlistChannels.id, a.id))
          .run();
      });
    }

    // Clear any links among the rows being deleted so deleting a primary and
    // its alternates together never trips the foreign key.
    tx.update(playlistChannels)
      .set({ primaryChannelId: null })
      .where(inArray(playlistChannels.id, idList))
      .run();
    tx.delete(playlistChannels).where(inArray(playlistChannels.id, idList)).run();

    // Renumber alternates of any surviving primary that lost one.
    const affected = new Set<number>();
    for (const r of rows) {
      if (r.primaryChannelId != null && !deleteSet.has(r.primaryChannelId)) {
        affected.add(r.primaryChannelId);
      }
    }
    for (const pid of affected) renumberAlternates(tx, pid);
  });
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

    keepAlternatesWithPrimary(tx, playlistId);
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
    .select({
      sourceName: sourceChannels.name,
      primaryChannelId: playlistChannels.primaryChannelId,
    })
    .from(playlistChannels)
    .innerJoin(
      sourceChannels,
      eq(playlistChannels.sourceChannelId, sourceChannels.id),
    )
    .where(eq(playlistChannels.id, channelId))
    .get();
  // Alternates are auto-named from their primary; they can't be renamed.
  if (!row || row.primaryChannelId != null) return;
  const next = trimmed && trimmed !== row.sourceName ? trimmed : null;
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
  // Alternates always use their primary's guide; their own EPG can't be set.
  const row = db
    .select({ primaryChannelId: playlistChannels.primaryChannelId })
    .from(playlistChannels)
    .where(eq(playlistChannels.id, channelId))
    .get();
  if (row?.primaryChannelId != null) return;
  db.update(playlistChannels)
    .set({ epgSourceId, epgChannelId })
    .where(eq(playlistChannels.id, channelId))
    .run();
}

export function removeChannel(playlistId: number, channelId: number) {
  if (!channelInPlaylist(playlistId, channelId)) return;
  performRemove([channelId]);
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
  performRemove(ids);
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
    keepAlternatesWithPrimary(tx, playlistId);
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
        primaryChannelId: playlistChannels.primaryChannelId,
      })
      .from(playlistChannels)
      .innerJoin(
        sourceChannels,
        eq(playlistChannels.sourceChannelId, sourceChannels.id),
      )
      .where(inArray(playlistChannels.id, ids))
      .all();
    for (const r of rows) {
      // Alternates are auto-named from their primary; skip them.
      if (r.primaryChannelId != null) continue;
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

/** Sort the selected channels by name within each category, filling the slots
    they already sit in. Unselected channels stay put, and alternates are left
    to their primary's group. */
export function bulkSort(
  playlistId: number,
  channelIds: number[],
  direction: "asc" | "desc",
) {
  const owned = ownedChannels(playlistId, channelIds);
  if (!owned.size) return;

  const rows = db
    .select({
      id: playlistChannels.id,
      categoryId: playlistChannels.categoryId,
      position: playlistChannels.position,
      customName: playlistChannels.customName,
      sourceName: sourceChannels.name,
      primaryChannelId: playlistChannels.primaryChannelId,
    })
    .from(playlistChannels)
    .innerJoin(
      sourceChannels,
      eq(playlistChannels.sourceChannelId, sourceChannels.id),
    )
    .where(inArray(playlistChannels.id, [...owned]))
    .all();

  const byCat = new Map<number, typeof rows>();
  for (const r of rows) {
    // Alternates follow their primary, so they don't sort on their own.
    if (r.primaryChannelId != null) continue;
    const list = byCat.get(r.categoryId);
    if (list) list.push(r);
    else byCat.set(r.categoryId, [r]);
  }

  const dir = direction === "desc" ? -1 : 1;
  db.transaction((tx) => {
    for (const list of byCat.values()) {
      // The slots these channels occupy now, lowest first. Sorting just
      // reshuffles the same channels back into the same slots.
      const slots = list.map((r) => r.position).sort((a, b) => a - b);
      const sorted = [...list].sort(
        (a, b) =>
          dir *
          (a.customName ?? a.sourceName).localeCompare(
            b.customName ?? b.sourceName,
            undefined,
            { numeric: true, sensitivity: "base" },
          ),
      );
      sorted.forEach((r, i) => {
        tx.update(playlistChannels)
          .set({ position: slots[i] })
          .where(eq(playlistChannels.id, r.id))
          .run();
      });
    }
  });
}

/** A channel that can be the primary of a group: in the playlist, not itself
    an alternate, and not in an auto category. Returns its row or null. */
function primaryCandidate(playlistId: number, channelId: number) {
  const row = db
    .select({
      id: playlistChannels.id,
      categoryId: playlistChannels.categoryId,
      position: playlistChannels.position,
      primaryChannelId: playlistChannels.primaryChannelId,
      epgSourceId: playlistChannels.epgSourceId,
      epgChannelId: playlistChannels.epgChannelId,
    })
    .from(playlistChannels)
    .where(
      and(
        eq(playlistChannels.id, channelId),
        eq(playlistChannels.playlistId, playlistId),
      ),
    )
    .get();
  if (!row || row.primaryChannelId != null) return null;
  if (categoryIsAuto(row.categoryId)) return null;
  return row;
}

/** Highest alt position currently used under a primary, or -1 if none. */
function maxAltPosition(tx: Tx, primaryId: number) {
  const row = tx
    .select({ max: sql<number | null>`max(${playlistChannels.altPosition})` })
    .from(playlistChannels)
    .where(eq(playlistChannels.primaryChannelId, primaryId))
    .get();
  return row?.max ?? -1;
}

/** Turn existing playlist channels into alternates of a primary. They move into
    the primary's category, inherit its EPG, and drop their custom name so they
    pick up the auto-name. */
export function makeAlternates(
  playlistId: number,
  primaryId: number,
  alternateIds: number[],
) {
  const primary = primaryCandidate(playlistId, primaryId);
  if (!primary) return;
  const owned = ownedChannels(playlistId, alternateIds);
  // Keep the given order, drop the primary itself and anything not owned.
  const candidates = alternateIds.filter(
    (id) => id !== primaryId && owned.has(id),
  );
  if (!candidates.length) return;

  db.transaction((tx) => {
    let next = maxAltPosition(tx, primaryId) + 1;
    // Groups an alternate leaves get renumbered so their numbering stays tidy.
    const formerPrimaries = new Set<number>();
    for (const id of candidates) {
      const row = tx
        .select({ primaryChannelId: playlistChannels.primaryChannelId })
        .from(playlistChannels)
        .where(eq(playlistChannels.id, id))
        .get();
      if (!row) continue;
      // A primary with its own alternates can't become an alternate, or we'd
      // nest a group inside a group.
      const hasOwnAlternates = !!tx
        .select({ id: playlistChannels.id })
        .from(playlistChannels)
        .where(eq(playlistChannels.primaryChannelId, id))
        .get();
      if (hasOwnAlternates) continue;

      if (row.primaryChannelId != null && row.primaryChannelId !== primaryId) {
        formerPrimaries.add(row.primaryChannelId);
      }

      tx.update(playlistChannels)
        .set({
          primaryChannelId: primaryId,
          categoryId: primary.categoryId,
          altPosition: next++,
          epgSourceId: primary.epgSourceId,
          epgChannelId: primary.epgChannelId,
          customName: null,
        })
        .where(eq(playlistChannels.id, id))
        .run();
    }
    for (const former of formerPrimaries) renumberAlternates(tx, former);
  });
}

/** Add source channels as new alternates of a primary, inheriting its EPG. */
export function addAlternates(
  playlistId: number,
  primaryId: number,
  sourceChannelIds: number[],
) {
  const primary = primaryCandidate(playlistId, primaryId);
  if (!primary || sourceChannelIds.length === 0) return 0;

  const order = new Map(sourceChannelIds.map((id, i) => [id, i]));
  const channels = db
    .select({ id: sourceChannels.id })
    .from(sourceChannels)
    .where(inArray(sourceChannels.id, sourceChannelIds))
    .all()
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  // Don't duplicate a source channel already in the primary's category.
  const existing = new Set(
    db
      .select({ sourceChannelId: playlistChannels.sourceChannelId })
      .from(playlistChannels)
      .where(eq(playlistChannels.categoryId, primary.categoryId))
      .all()
      .map((r) => r.sourceChannelId),
  );
  const toAdd = channels.filter((ch) => !existing.has(ch.id));
  if (!toAdd.length) return 0;

  db.transaction((tx) => {
    let next = maxAltPosition(tx, primaryId) + 1;
    for (const ch of toAdd) {
      tx.insert(playlistChannels)
        .values({
          playlistId,
          categoryId: primary.categoryId,
          sourceChannelId: ch.id,
          position: primary.position,
          primaryChannelId: primaryId,
          altPosition: next++,
          epgSourceId: primary.epgSourceId,
          epgChannelId: primary.epgChannelId,
        })
        .run();
    }
  });
  return toAdd.length;
}

/** Persist the order of a primary's alternates. */
export function reorderAlternates(
  playlistId: number,
  primaryId: number,
  orderedIds: number[],
) {
  if (!channelInPlaylist(playlistId, primaryId)) return;
  const alts = new Set(
    db
      .select({ id: playlistChannels.id })
      .from(playlistChannels)
      .where(eq(playlistChannels.primaryChannelId, primaryId))
      .all()
      .map((r) => r.id),
  );
  db.transaction((tx) => {
    orderedIds.forEach((id, i) => {
      if (!alts.has(id)) return;
      tx.update(playlistChannels)
        .set({ altPosition: i })
        .where(eq(playlistChannels.id, id))
        .run();
    });
  });
}

/** Promote an alternate to be the group's primary. The old primary becomes an
    alternate at the top of the list; the other alternates follow. */
export function promoteAlternate(playlistId: number, channelId: number) {
  const alt = db
    .select({
      id: playlistChannels.id,
      primaryChannelId: playlistChannels.primaryChannelId,
      position: playlistChannels.position,
    })
    .from(playlistChannels)
    .where(
      and(
        eq(playlistChannels.id, channelId),
        eq(playlistChannels.playlistId, playlistId),
      ),
    )
    .get();
  if (!alt || alt.primaryChannelId == null) return;
  const oldPrimaryId = alt.primaryChannelId;
  const oldPrimary = db
    .select({
      position: playlistChannels.position,
      customName: playlistChannels.customName,
    })
    .from(playlistChannels)
    .where(eq(playlistChannels.id, oldPrimaryId))
    .get();
  if (!oldPrimary) return;

  // Other alternates of the old primary, in order, excluding the one promoted.
  const others = db
    .select({ id: playlistChannels.id })
    .from(playlistChannels)
    .where(eq(playlistChannels.primaryChannelId, oldPrimaryId))
    .orderBy(asc(playlistChannels.altPosition), asc(playlistChannels.id))
    .all()
    .map((r) => r.id)
    .filter((id) => id !== channelId);

  db.transaction((tx) => {
    // The user is just picking a different primary, not renaming the group, so
    // the new primary keeps whatever custom name the old one had and takes its
    // list position.
    tx.update(playlistChannels)
      .set({
        primaryChannelId: null,
        altPosition: 0,
        position: oldPrimary.position,
        customName: oldPrimary.customName,
      })
      .where(eq(playlistChannels.id, channelId))
      .run();
    // Old primary becomes the first alternate: drop its custom name so it's
    // auto-named from the new primary like every other alternate.
    tx.update(playlistChannels)
      .set({ primaryChannelId: channelId, altPosition: 0, customName: null })
      .where(eq(playlistChannels.id, oldPrimaryId))
      .run();
    // Remaining alternates follow, under the new primary.
    others.forEach((id, i) => {
      tx.update(playlistChannels)
        .set({ primaryChannelId: channelId, altPosition: i + 1 })
        .where(eq(playlistChannels.id, id))
        .run();
    });
  });
}

/** Detach an alternate so it becomes a standalone channel again. */
export function ungroupAlternate(playlistId: number, channelId: number) {
  const row = db
    .select({
      categoryId: playlistChannels.categoryId,
      primaryChannelId: playlistChannels.primaryChannelId,
    })
    .from(playlistChannels)
    .where(
      and(
        eq(playlistChannels.id, channelId),
        eq(playlistChannels.playlistId, playlistId),
      ),
    )
    .get();
  if (!row || row.primaryChannelId == null) return;
  const formerPrimary = row.primaryChannelId;
  db.transaction((tx) => {
    tx.update(playlistChannels)
      .set({
        primaryChannelId: null,
        altPosition: 0,
        position: nextChannelPosition(row.categoryId),
      })
      .where(eq(playlistChannels.id, channelId))
      .run();
    renumberAlternates(tx, formerPrimary);
  });
}

/** Detach every alternate of a primary, leaving standalone channels. */
export function ungroupPrimary(playlistId: number, primaryId: number) {
  if (!channelInPlaylist(playlistId, primaryId)) return;
  const alts = db
    .select({
      id: playlistChannels.id,
      categoryId: playlistChannels.categoryId,
    })
    .from(playlistChannels)
    .where(eq(playlistChannels.primaryChannelId, primaryId))
    .all();
  if (!alts.length) return;
  db.transaction((tx) => {
    for (const a of alts) {
      tx.update(playlistChannels)
        .set({
          primaryChannelId: null,
          altPosition: 0,
          position: nextChannelPosition(a.categoryId),
        })
        .where(eq(playlistChannels.id, a.id))
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
        primaryChannelId: playlistChannels.primaryChannelId,
      })
      .from(playlistChannels)
      .innerJoin(
        sourceChannels,
        eq(playlistChannels.sourceChannelId, sourceChannels.id),
      )
      .where(inArray(playlistChannels.id, ids))
      .all();
    for (const r of rows) {
      // Alternates always follow their primary's guide; skip them.
      if (r.primaryChannelId != null) continue;
      tx.update(playlistChannels)
        .set({ epgSourceId: r.sourceId, epgChannelId: r.epgChannelId })
        .where(eq(playlistChannels.id, r.id))
        .run();
    }
  });
}
