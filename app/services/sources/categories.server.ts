import { and, asc, count, eq, sql } from "drizzle-orm";
import { db } from "~/db/index.server";
import { sourceCategories, sourceChannels } from "~/db/schema";

/** Seed category rows for a source. New categories default to enabled; existing
    rows keep their enabled state. Called during sync. */
export function syncSourceCategories(sourceId: number, names: string[]) {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length === 0) return;
  db.transaction((tx) => {
    for (const name of unique) {
      tx.insert(sourceCategories)
        .values({ sourceId, name, enabled: true })
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
