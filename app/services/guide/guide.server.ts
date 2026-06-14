import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "~/db/index.server";
import { epgProgrammes, playlists, sources, type Playlist } from "~/db/schema";
import { resolvePlaylistChannels } from "~/services/output/queries.server";

// SQLite caps bound variables per statement, so query channel ids in batches.
const ID_CHUNK = 500;

export interface GuideProgramme {
  startTs: number;
  stopTs: number;
  title: string | null;
  subTitle: string | null;
  description: string | null;
  category: string | null;
  // Past programme on a channel whose provider keeps catchup for it. A real
  // player could replay it; we just flag it.
  catchup: boolean;
}

export interface GuideChannel {
  displayName: string;
  logo: string;
  tvgId: string;
  catchupDays: number;
  programmes: GuideProgramme[];
}

export interface GuideCategory {
  name: string;
  channels: GuideChannel[];
}

export interface GuideSource {
  id: number;
  name: string;
  epgStale: boolean;
  lastSyncedAt: number | null;
}

export interface Guide {
  playlist: Playlist;
  fromTs: number;
  toTs: number;
  categories: GuideCategory[];
  // The sources backing this playlist's channels, for the "needs sync" nudge.
  sources: GuideSource[];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Build the guide for a playlist over [fromTs, toTs): its channels in display
    order, grouped by category, each with the programmes overlapping the window.
    Reads only the local DB, so it's fast. */
export function getPlaylistGuide(
  playlistId: number,
  fromTs: number,
  toTs: number,
): Guide | null {
  const playlist = db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .get();
  if (!playlist) return null;

  const channels = resolvePlaylistChannels(playlist);

  // The channel ids each source needs to supply programmes for.
  const idsBySource = new Map<number, Set<string>>();
  for (const c of channels) {
    if (!c.tvgId) continue;
    let set = idsBySource.get(c.epgSourceId);
    if (!set) {
      set = new Set<string>();
      idsBySource.set(c.epgSourceId, set);
    }
    set.add(c.tvgId);
  }

  const now = Math.floor(Date.now() / 1000);
  // Key is `${epgSourceId}:${tvgId}` so a channel maps to its own source's guide.
  const progsByChannel = new Map<string, GuideProgramme[]>();

  for (const [sourceId, idSet] of idsBySource) {
    for (const ids of chunk([...idSet], ID_CHUNK)) {
      const rows = db
        .select({
          channelId: epgProgrammes.channelId,
          startTs: epgProgrammes.startTs,
          stopTs: epgProgrammes.stopTs,
          title: epgProgrammes.title,
          subTitle: epgProgrammes.subTitle,
          description: epgProgrammes.description,
          category: epgProgrammes.category,
          hasArchive: epgProgrammes.hasArchive,
        })
        .from(epgProgrammes)
        .where(
          and(
            eq(epgProgrammes.sourceId, sourceId),
            inArray(epgProgrammes.channelId, ids),
            lt(epgProgrammes.startTs, toTs),
            gt(epgProgrammes.stopTs, fromTs),
          ),
        )
        .orderBy(asc(epgProgrammes.channelId), asc(epgProgrammes.startTs))
        .all();
      for (const r of rows) {
        const key = `${sourceId}:${r.channelId}`;
        let list = progsByChannel.get(key);
        if (!list) {
          list = [];
          progsByChannel.set(key, list);
        }
        list.push({
          startTs: r.startTs,
          stopTs: r.stopTs,
          title: r.title,
          subTitle: r.subTitle,
          description: r.description,
          category: r.category,
          // The provider marks which aired programmes are in the archive.
          catchup: r.hasArchive && r.stopTs <= now,
        });
      }
    }
  }

  // Walk channels in display order, attaching programmes and regrouping into
  // categories (first-seen order, since channels are already ordered).
  const categories: GuideCategory[] = [];
  const byName = new Map<string, GuideCategory>();
  for (const c of channels) {
    const programmes = c.tvgId
      ? (progsByChannel.get(`${c.epgSourceId}:${c.tvgId}`) ?? [])
      : [];

    let cat = byName.get(c.groupTitle);
    if (!cat) {
      cat = { name: c.groupTitle, channels: [] };
      byName.set(c.groupTitle, cat);
      categories.push(cat);
    }
    cat.channels.push({
      displayName: c.displayName,
      logo: c.logo,
      tvgId: c.tvgId,
      catchupDays: c.catchupDays,
      programmes,
    });
  }

  const sourceIds = [...new Set(channels.map((c) => c.epgSourceId))];
  const guideSources: GuideSource[] = sourceIds.length
    ? db
        .select({
          id: sources.id,
          name: sources.name,
          epgStale: sources.epgStale,
          lastSyncedAt: sources.lastSyncedAt,
        })
        .from(sources)
        .where(inArray(sources.id, sourceIds))
        .all()
        .map((s) => ({
          id: s.id,
          name: s.name,
          epgStale: s.epgStale,
          lastSyncedAt: s.lastSyncedAt ? s.lastSyncedAt.getTime() : null,
        }))
    : [];

  return { playlist, fromTs, toTs, categories, sources: guideSources };
}
