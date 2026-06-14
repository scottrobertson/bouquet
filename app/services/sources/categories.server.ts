import { and, asc, count, eq, sql } from "drizzle-orm";
import { db } from "~/db/index.server";
import { sourceCategories, sourceChannels, sources } from "~/db/schema";

/** Flag the source so the UI nudges a resync: stored programmes only cover the
    channels that were in enabled categories at the last sync. */
function markEpgStale(sourceId: number) {
  db.update(sources)
    .set({ epgStale: true })
    .where(eq(sources.id, sourceId))
    .run();
}

/** Seed category rows for a source. New categories default to `enabledDefault`
    (the source's auto-import setting); existing rows keep their enabled state. */
export function syncSourceCategories(
  sourceId: number,
  names: string[],
  enabledDefault = true,
) {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length === 0) return;
  db.transaction((tx) => {
    for (const name of unique) {
      tx.insert(sourceCategories)
        .values({ sourceId, name, enabled: enabledDefault })
        .onConflictDoNothing()
        .run();
    }
  });
}

/** Categories for a source with channel counts and enabled state, in provider
    order (by first channel). */
export function listSourceCategories(sourceId: number) {
  const counts = db
    .select({
      name: sourceChannels.categoryName,
      n: count(),
      minId: sql<number>`min(${sourceChannels.id})`,
    })
    .from(sourceChannels)
    .where(eq(sourceChannels.sourceId, sourceId))
    .groupBy(sourceChannels.categoryName)
    .all();

  const enabledByName = new Map(
    db
      .select({ name: sourceCategories.name, enabled: sourceCategories.enabled })
      .from(sourceCategories)
      .where(eq(sourceCategories.sourceId, sourceId))
      .all()
      .map((r) => [r.name, r.enabled]),
  );

  return counts
    .filter((c): c is { name: string; n: number; minId: number } => !!c.name)
    .sort((a, b) => a.minId - b.minId)
    .map((c) => ({
      name: c.name,
      count: c.n,
      enabled: enabledByName.get(c.name) ?? true,
    }));
}

/** Enabled/total category and disabled-channel counts for every source, in two
    queries total. Used by the sources list so it doesn't run a pair of queries
    per source. Uncategorized channels (no category name) are left out of the
    category totals and always count as enabled, matching listSourceCategories. */
export function sourceCategorySummaries(): Map<
  number,
  { categoriesTotal: number; categoriesOn: number; offChannels: number }
> {
  const counts = db
    .select({
      sourceId: sourceChannels.sourceId,
      name: sourceChannels.categoryName,
      n: count(),
    })
    .from(sourceChannels)
    .groupBy(sourceChannels.sourceId, sourceChannels.categoryName)
    .all();

  const enabledByKey = new Map<string, boolean>();
  for (const e of db
    .select({
      sourceId: sourceCategories.sourceId,
      name: sourceCategories.name,
      enabled: sourceCategories.enabled,
    })
    .from(sourceCategories)
    .all()) {
    enabledByKey.set(`${e.sourceId}:${e.name}`, e.enabled);
  }

  const out = new Map<
    number,
    { categoriesTotal: number; categoriesOn: number; offChannels: number }
  >();
  for (const c of counts) {
    if (!c.name) continue;
    let agg = out.get(c.sourceId);
    if (!agg) {
      agg = { categoriesTotal: 0, categoriesOn: 0, offChannels: 0 };
      out.set(c.sourceId, agg);
    }
    agg.categoriesTotal++;
    if (enabledByKey.get(`${c.sourceId}:${c.name}`) ?? true) agg.categoriesOn++;
    else agg.offChannels += c.n;
  }
  return out;
}

export function setSourceCategoryEnabled(
  sourceId: number,
  name: string,
  enabled: boolean,
) {
  db.insert(sourceCategories)
    .values({ sourceId, name, enabled })
    .onConflictDoUpdate({
      target: [sourceCategories.sourceId, sourceCategories.name],
      set: { enabled },
    })
    .run();
  markEpgStale(sourceId);
}

/** Enable or disable every category of a source at once. */
export function setAllSourceCategories(sourceId: number, enabled: boolean) {
  const names = db
    .selectDistinct({ name: sourceChannels.categoryName })
    .from(sourceChannels)
    .where(eq(sourceChannels.sourceId, sourceId))
    .all()
    .map((r) => r.name)
    .filter((n): n is string => !!n);

  db.transaction((tx) => {
    for (const name of names) {
      tx.insert(sourceCategories)
        .values({ sourceId, name, enabled })
        .onConflictDoUpdate({
          target: [sourceCategories.sourceId, sourceCategories.name],
          set: { enabled },
        })
        .run();
    }
  });
  markEpgStale(sourceId);
}

/** Names of disabled categories for a source. Used to exclude their channels. */
export function disabledCategoryNames(sourceId: number): string[] {
  return db
    .select({ name: sourceCategories.name })
    .from(sourceCategories)
    .where(
      and(
        eq(sourceCategories.sourceId, sourceId),
        eq(sourceCategories.enabled, false),
      ),
    )
    .orderBy(asc(sourceCategories.name))
    .all()
    .map((r) => r.name);
}
