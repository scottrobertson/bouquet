import { and, asc, count, eq, like, sql } from "drizzle-orm";
import { db } from "~/db/index.server";
import { sourceChannels } from "~/db/schema";

/** Most channels one request will send back. A single category can hold
    thousands, and the source screen only needs enough to find one. */
export const SOURCE_CHANNEL_LIMIT = 500;

/** How many categories a search can land in and still have all of them opened
    up on screen. Past this the search was too vague for that to help. */
export const AUTO_OPEN_LIMIT = 8;

export type SourceChannelRow = {
  id: number;
  name: string;
  logo: string | null;
  categoryName: string | null;
  available: boolean;
};

function channelFilter(
  sourceId: number,
  opts: { category?: string; q?: string },
) {
  const filters = [eq(sourceChannels.sourceId, sourceId)];
  if (opts.category) {
    filters.push(eq(sourceChannels.categoryName, opts.category));
  }
  if (opts.q) {
    filters.push(like(sourceChannels.name, `%${opts.q}%`));
  }
  return and(...filters);
}

/** Channels in a source, narrowed to a category and/or a name search. Provider
    order, capped, with the uncapped total so the caller can say what it cut. */
export function listSourceChannels(
  sourceId: number,
  opts: { category?: string; q?: string } = {},
): { channels: SourceChannelRow[]; total: number } {
  const where = channelFilter(sourceId, opts);

  const total = db
    .select({ n: count() })
    .from(sourceChannels)
    .where(where)
    .get();

  const channels = db
    .select({
      id: sourceChannels.id,
      name: sourceChannels.name,
      logo: sourceChannels.logo,
      categoryName: sourceChannels.categoryName,
      available: sourceChannels.available,
    })
    .from(sourceChannels)
    .where(where)
    .orderBy(asc(sourceChannels.position), asc(sourceChannels.id))
    .limit(SOURCE_CHANNEL_LIMIT)
    .all();

  return { channels, total: total?.n ?? 0 };
}

/** How many channels match a search in each category, biggest first. This is
    what tells you which category a channel you're hunting for lives in. */
export function searchCategoryCounts(
  sourceId: number,
  q: string,
): { name: string; count: number }[] {
  return db
    .select({ name: sourceChannels.categoryName, n: count() })
    .from(sourceChannels)
    .where(
      and(
        eq(sourceChannels.sourceId, sourceId),
        like(sourceChannels.name, `%${q}%`),
      ),
    )
    .groupBy(sourceChannels.categoryName)
    .orderBy(sql`count(*) desc`)
    .all()
    .filter((r): r is { name: string; n: number } => !!r.name)
    .map((r) => ({ name: r.name, count: r.n }));
}
