import {
  and,
  asc,
  count,
  eq,
  inArray,
  like,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { db } from "~/db/index.server";
import {
  playlistCategories,
  playlistChannels,
  playlists,
  sourceCategories,
  sourceChannels,
  sourceEpgChannels,
  sources,
} from "~/db/schema";
import { altName } from "~/services/playlist/alt-name";
import { epgLogoLookup } from "~/services/playlist/epg-logo.server";
import { buildStreamUrl } from "~/services/xtream/client.server";

// The source browser is virtualized, so this just bounds the payload, not what
// gets rendered. High enough to cover a full provider in one fetch.
export const BROWSER_LIMIT = 5000;

/** All playlists with their category and channel counts, newest first. */
export function listPlaylists() {
  const rows = db.select().from(playlists).orderBy(asc(playlists.name)).all();

  const catCounts = db
    .select({
      playlistId: playlistCategories.playlistId,
      n: count(playlistCategories.id),
    })
    .from(playlistCategories)
    .groupBy(playlistCategories.playlistId)
    .all();

  const chanCounts = db
    .select({
      playlistId: playlistChannels.playlistId,
      n: count(playlistChannels.id),
    })
    .from(playlistChannels)
    .groupBy(playlistChannels.playlistId)
    .all();

  const catMap = new Map(catCounts.map((r) => [r.playlistId, r.n]));
  const chanMap = new Map(chanCounts.map((r) => [r.playlistId, r.n]));

  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt.toISOString(),
    categoryCount: catMap.get(p.id) ?? 0,
    channelCount: chanMap.get(p.id) ?? 0,
  }));
}

/** Load a playlist or null if it does not exist. */
export function getPlaylist(id: number) {
  return db.select().from(playlists).where(eq(playlists.id, id)).get() ?? null;
}

/** Categories of a playlist in display order. Carries auto-sync info (which
    source category an auto group mirrors, plus that source's name). */
export function getCategories(playlistId: number) {
  return db
    .select({
      id: playlistCategories.id,
      playlistId: playlistCategories.playlistId,
      name: playlistCategories.name,
      position: playlistCategories.position,
      autoSourceId: playlistCategories.autoSourceId,
      autoCategoryName: playlistCategories.autoCategoryName,
      autoSourceName: sources.name,
    })
    .from(playlistCategories)
    .leftJoin(sources, eq(sources.id, playlistCategories.autoSourceId))
    .where(eq(playlistCategories.playlistId, playlistId))
    .orderBy(asc(playlistCategories.position), asc(playlistCategories.id))
    .all();
}

/** Live channels for each auto-sync category: the available channels in the
    mirrored source category, in provider order. Read-only, so just the bits we
    render. Keyed by playlist category id. */
export function getAutoChannels(
  categories: {
    id: number;
    autoSourceId: number | null;
    autoCategoryName: string | null;
  }[],
): Record<number, { sourceChannelId: number; name: string; logo: string | null }[]> {
  const out: Record<
    number,
    { sourceChannelId: number; name: string; logo: string | null }[]
  > = {};
  for (const cat of categories) {
    if (cat.autoSourceId == null || cat.autoCategoryName == null) continue;
    out[cat.id] = db
      .select({
        sourceChannelId: sourceChannels.id,
        name: sourceChannels.name,
        logo: sourceChannels.logo,
      })
      .from(sourceChannels)
      .where(
        and(
          eq(sourceChannels.sourceId, cat.autoSourceId),
          eq(sourceChannels.categoryName, cat.autoCategoryName),
          eq(sourceChannels.available, true),
        ),
      )
      .orderBy(asc(sourceChannels.position), asc(sourceChannels.id))
      .all();
  }
  return out;
}

/** Playlist channels joined to their source channel, in category then channel order. */
export function getPlaylistChannels(playlistId: number) {
  const rows = db
    .select({
      id: playlistChannels.id,
      categoryId: playlistChannels.categoryId,
      sourceChannelId: playlistChannels.sourceChannelId,
      customName: playlistChannels.customName,
      customLogo: playlistChannels.customLogo,
      position: playlistChannels.position,
      primaryChannelId: playlistChannels.primaryChannelId,
      altPosition: playlistChannels.altPosition,
      enabled: playlistChannels.enabled,
      autoDisabledAt: playlistChannels.autoDisabledAt,
      epgSourceId: playlistChannels.epgSourceId,
      epgChannelId: playlistChannels.epgChannelId,
      sourceName: sourceChannels.name,
      sourceLogo: sourceChannels.logo,
      sourceAvailable: sourceChannels.available,
      sourceCategoryName: sourceChannels.categoryName,
      channelSourceId: sourceChannels.sourceId,
      sourceEpgChannelId: sourceChannels.epgChannelId,
      streamId: sourceChannels.streamId,
      sourceProviderName: sources.name,
      serverUrl: sources.serverUrl,
      streamBaseUrl: sources.streamBaseUrl,
      username: sources.username,
      password: sources.password,
      outputFormat: sources.outputFormat,
      probeStatus: sourceChannels.probeStatus,
      probeError: sourceChannels.probeError,
      probeWidth: sourceChannels.probeWidth,
      probeHeight: sourceChannels.probeHeight,
      probeFps: sourceChannels.probeFps,
      probeVideoCodec: sourceChannels.probeVideoCodec,
      probeAudioCodec: sourceChannels.probeAudioCodec,
      probeBitrate: sourceChannels.probeBitrate,
      categoryEnabled: sourceCategories.enabled,
    })
    .from(playlistChannels)
    .innerJoin(
      sourceChannels,
      eq(playlistChannels.sourceChannelId, sourceChannels.id),
    )
    .innerJoin(sources, eq(sourceChannels.sourceId, sources.id))
    .leftJoin(
      sourceCategories,
      and(
        eq(sourceCategories.sourceId, sourceChannels.sourceId),
        eq(sourceCategories.name, sourceChannels.categoryName),
      ),
    )
    .innerJoin(
      playlistCategories,
      eq(playlistChannels.categoryId, playlistCategories.id),
    )
    .where(eq(playlistChannels.playlistId, playlistId))
    .orderBy(
      asc(playlistCategories.position),
      asc(playlistCategories.id),
      asc(playlistChannels.position),
      asc(playlistChannels.id),
    )
    .all();

  const template =
    db
      .select({ t: playlists.altNameTemplate })
      .from(playlists)
      .where(eq(playlists.id, playlistId))
      .get()?.t ?? "{name} (Alt {n})";

  // Resolved name of every channel, so an alternate's auto-name can reference
  // its primary.
  const nameById = new Map<number, string>();
  for (const r of rows) nameById.set(r.id, r.customName || r.sourceName);

  // Logo borrowed from a custom EPG pick, so the editor preview matches output.
  const epgLogoOf = epgLogoLookup(
    rows.map((r) => ({
      channelSourceId: r.channelSourceId,
      sourceDefaultEpgId: r.sourceEpgChannelId,
      epgSourceId: r.epgSourceId,
      epgChannelId: r.epgChannelId,
    })),
  );

  // No category row (null category, or unseeded) counts as enabled. Strip the
  // raw provider creds out of the payload, keeping only the built stream URL.
  return rows.map(
    ({
      categoryEnabled,
      serverUrl,
      streamBaseUrl,
      username,
      password,
      outputFormat,
      ...r
    }) => ({
      ...r,
      sourceCategoryEnabled: categoryEnabled ?? true,
      epgLogo:
        epgLogoOf({
          channelSourceId: r.channelSourceId,
          sourceDefaultEpgId: r.sourceEpgChannelId,
          epgSourceId: r.epgSourceId,
          epgChannelId: r.epgChannelId,
        }) || null,
      streamUrl: buildStreamUrl(
        { serverUrl: streamBaseUrl ?? serverUrl, username, password },
        r.streamId,
        outputFormat,
      ),
      // For an alternate, the name it falls back to when not manually renamed.
      // For a primary it's just the source name, so existing rename logic is
      // unchanged.
      autoName:
        r.primaryChannelId != null
          ? altName(
              template,
              nameById.get(r.primaryChannelId) ?? r.sourceName,
              r.altPosition + 1,
            )
          : r.sourceName,
    }),
  );
}

/** The streams in one alt group (primary plus alternates), with the provider and
    probe data the smart-sort preview shows. Primary first, then alternates in
    their current order. */
export function getAltGroupStreams(playlistId: number, primaryId: number) {
  return db
    .select({
      id: playlistChannels.id,
      primaryChannelId: playlistChannels.primaryChannelId,
      sourceName: sourceChannels.name,
      providerName: sources.name,
      categoryName: sourceChannels.categoryName,
      available: sourceChannels.available,
      autoDisabledAt: playlistChannels.autoDisabledAt,
      probeStatus: sourceChannels.probeStatus,
      probeWidth: sourceChannels.probeWidth,
      probeHeight: sourceChannels.probeHeight,
      probeFps: sourceChannels.probeFps,
      probeVideoCodec: sourceChannels.probeVideoCodec,
      probeAudioCodec: sourceChannels.probeAudioCodec,
      probeBitrate: sourceChannels.probeBitrate,
    })
    .from(playlistChannels)
    .innerJoin(
      sourceChannels,
      eq(playlistChannels.sourceChannelId, sourceChannels.id),
    )
    .innerJoin(sources, eq(sourceChannels.sourceId, sources.id))
    .where(
      and(
        eq(playlistChannels.playlistId, playlistId),
        or(
          eq(playlistChannels.id, primaryId),
          eq(playlistChannels.primaryChannelId, primaryId),
        ),
      ),
    )
    .orderBy(
      sql`${playlistChannels.primaryChannelId} is null desc`,
      asc(playlistChannels.altPosition),
      asc(playlistChannels.id),
    )
    .all();
}

/** Is any source feeding this playlist currently probing? Drives live polling
    in the editor so quality fills in as it lands. */
export function playlistHasProbingSource(playlistId: number): boolean {
  const row = db
    .select({ id: sources.id })
    .from(playlistChannels)
    .innerJoin(
      sourceChannels,
      eq(playlistChannels.sourceChannelId, sourceChannels.id),
    )
    .innerJoin(sources, eq(sourceChannels.sourceId, sources.id))
    .where(
      and(
        eq(playlistChannels.playlistId, playlistId),
        eq(sources.probeStatus, "probing"),
      ),
    )
    .limit(1)
    .get();
  return !!row;
}

/** Sources for the pickers. */
export function listSources() {
  return db
    .select({ id: sources.id, name: sources.name })
    .from(sources)
    .orderBy(asc(sources.name))
    .all();
}

/** Enabled category names across all sources, in provider order (by first
    channel), deduped by name, for the browser category picker. */
export function browserCategories() {
  const rows = db
    .select({ categoryName: sourceChannels.categoryName })
    .from(sourceChannels)
    .where(categoryEnabled())
    .groupBy(sourceChannels.categoryName)
    .orderBy(sql`min(${sourceChannels.id})`)
    .all();
  return rows
    .map((r) => r.categoryName)
    .filter((c): c is string => !!c);
}

export type BrowserFilter = {
  sourceId?: number;
  categories?: string[];
  q?: string;
  excludePlaylistId?: number;
};

/** A channel's own source category is not disabled. Correlated so it works
    across every source at once. */
function categoryEnabled() {
  return notExists(
    db
      .select({ x: sql`1` })
      .from(sourceCategories)
      .where(
        and(
          eq(sourceCategories.sourceId, sourceChannels.sourceId),
          eq(sourceCategories.name, sourceChannels.categoryName),
          eq(sourceCategories.enabled, false),
        ),
      ),
  );
}

/** Shared WHERE for the browser and bulk-add queries, so "add all matching"
    matches exactly what the browser shows. Spans all sources. */
function browserWhere(opts: BrowserFilter) {
  const filters = [categoryEnabled()];
  if (opts.sourceId != null) {
    filters.push(eq(sourceChannels.sourceId, opts.sourceId));
  }
  if (opts.categories && opts.categories.length) {
    filters.push(inArray(sourceChannels.categoryName, opts.categories));
  }
  if (opts.q) {
    filters.push(like(sourceChannels.name, `%${opts.q}%`));
  }
  if (opts.excludePlaylistId != null) {
    filters.push(
      notInArray(
        sourceChannels.id,
        db
          .select({ id: playlistChannels.sourceChannelId })
          .from(playlistChannels)
          .where(eq(playlistChannels.playlistId, opts.excludePlaylistId)),
      ),
    );
    // Also hide channels already covered by an auto-sync category here, since
    // those mirror a whole source category and aren't manually added.
    filters.push(
      notExists(
        db
          .select({ x: sql`1` })
          .from(playlistCategories)
          .where(
            and(
              eq(playlistCategories.playlistId, opts.excludePlaylistId),
              eq(playlistCategories.autoSourceId, sourceChannels.sourceId),
              eq(playlistCategories.autoCategoryName, sourceChannels.categoryName),
            ),
          ),
      ),
    );
  }
  return and(...filters);
}

/** Browser results for the left pane, across every source. Each row carries its
    source. Filtered, already-added removed, capped. */
export function browserChannels(opts: BrowserFilter) {
  const where = browserWhere(opts);

  const total = db
    .select({ n: count() })
    .from(sourceChannels)
    .where(where)
    .get();

  const rows = db
    .select({
      id: sourceChannels.id,
      name: sourceChannels.name,
      logo: sourceChannels.logo,
      categoryName: sourceChannels.categoryName,
      available: sourceChannels.available,
      sourceId: sourceChannels.sourceId,
      sourceName: sources.name,
      epgChannelId: sourceChannels.epgChannelId,
    })
    .from(sourceChannels)
    .innerJoin(sources, eq(sources.id, sourceChannels.sourceId))
    .where(where)
    .orderBy(
      asc(sources.name),
      asc(sourceChannels.position),
      asc(sourceChannels.id),
    )
    .limit(BROWSER_LIMIT)
    .all();

  return { rows, total: total?.n ?? 0 };
}

/** Every source-channel id matching a filter (no cap), in display order. For
    bulk add of a whole group or all matching results. */
export function matchingSourceChannelIds(opts: BrowserFilter): number[] {
  return db
    .select({ id: sourceChannels.id })
    .from(sourceChannels)
    .where(browserWhere(opts))
    .orderBy(
      asc(sourceChannels.sourceId),
      asc(sourceChannels.position),
      asc(sourceChannels.id),
    )
    .all()
    .map((r) => r.id);
}

/** All EPG channels across every source, with the source name, for the picker. */
export function listEpgChannels() {
  return db
    .select({
      id: sourceEpgChannels.id,
      sourceId: sourceEpgChannels.sourceId,
      channelId: sourceEpgChannels.channelId,
      displayName: sourceEpgChannels.displayName,
      icon: sourceEpgChannels.icon,
      sourceName: sources.name,
    })
    .from(sourceEpgChannels)
    .innerJoin(sources, eq(sourceEpgChannels.sourceId, sources.id))
    .orderBy(asc(sources.name), asc(sourceEpgChannels.displayName))
    .all();
}

/** Next position to append a category at the end of a playlist. */
export function nextCategoryPosition(playlistId: number) {
  const row = db
    .select({ max: sql<number | null>`max(${playlistCategories.position})` })
    .from(playlistCategories)
    .where(eq(playlistCategories.playlistId, playlistId))
    .get();
  return (row?.max ?? -1) + 1;
}

/** Next position to append a channel at the end of a category. */
export function nextChannelPosition(categoryId: number) {
  const row = db
    .select({ max: sql<number | null>`max(${playlistChannels.position})` })
    .from(playlistChannels)
    .where(eq(playlistChannels.categoryId, categoryId))
    .get();
  return (row?.max ?? -1) + 1;
}
