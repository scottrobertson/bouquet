import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db } from "~/db/index.server";
import type { Playlist } from "~/db/schema";
import {
  playlistCategories,
  playlistChannels,
  playlists,
  sourceCategories,
  sourceChannels,
  sources,
} from "~/db/schema";
import { buildStreamUrl } from "~/services/xtream/client.server";

export interface ResolvedChannel {
  displayName: string;
  logo: string;
  groupTitle: string;
  tvgId: string;
  // Which source's xmltv this channel's guide comes from.
  epgSourceId: number;
  streamUrl: string;
}

export interface PlaylistOutput {
  playlist: Playlist;
  channels: ResolvedChannel[];
}

export async function getPlaylistOutput(
  token: string,
): Promise<PlaylistOutput | null> {
  const playlist = db
    .select()
    .from(playlists)
    .where(eq(playlists.outputToken, token))
    .get();
  if (!playlist) return null;

  const cats = db
    .select({
      id: playlistCategories.id,
      name: playlistCategories.name,
      autoSourceId: playlistCategories.autoSourceId,
      autoCategoryName: playlistCategories.autoCategoryName,
    })
    .from(playlistCategories)
    .where(eq(playlistCategories.playlistId, playlist.id))
    .orderBy(asc(playlistCategories.position), asc(playlistCategories.id))
    .all();

  // Materialized channels (normal categories), grouped by category id.
  const normalRows = db
    .select({
      categoryId: playlistChannels.categoryId,
      customName: playlistChannels.customName,
      customLogo: playlistChannels.customLogo,
      pcEpgSourceId: playlistChannels.epgSourceId,
      pcEpgChannelId: playlistChannels.epgChannelId,
      channelName: sourceChannels.name,
      channelLogo: sourceChannels.logo,
      channelEpgId: sourceChannels.epgChannelId,
      streamId: sourceChannels.streamId,
      channelSourceId: sourceChannels.sourceId,
      serverUrl: sources.serverUrl,
      streamBaseUrl: sources.streamBaseUrl,
      username: sources.username,
      password: sources.password,
      outputFormat: sources.outputFormat,
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
    .where(
      and(
        eq(playlistChannels.playlistId, playlist.id),
        eq(playlistChannels.enabled, true),
        eq(sourceChannels.available, true),
        // Exclude channels whose source category is disabled.
        or(isNull(sourceCategories.id), eq(sourceCategories.enabled, true)),
      ),
    )
    .orderBy(asc(playlistChannels.position), asc(playlistChannels.id))
    .all();

  const byCat = new Map<number, typeof normalRows>();
  for (const r of normalRows) {
    const list = byCat.get(r.categoryId);
    if (list) list.push(r);
    else byCat.set(r.categoryId, [r]);
  }

  // Live channels for an auto-sync category, straight from the source catalog.
  const autoRows = (sourceId: number, categoryName: string) =>
    db
      .select({
        channelName: sourceChannels.name,
        channelLogo: sourceChannels.logo,
        channelEpgId: sourceChannels.epgChannelId,
        streamId: sourceChannels.streamId,
        channelSourceId: sourceChannels.sourceId,
        serverUrl: sources.serverUrl,
        streamBaseUrl: sources.streamBaseUrl,
        username: sources.username,
        password: sources.password,
        outputFormat: sources.outputFormat,
      })
      .from(sourceChannels)
      .innerJoin(sources, eq(sources.id, sourceChannels.sourceId))
      .where(
        and(
          eq(sourceChannels.sourceId, sourceId),
          eq(sourceChannels.categoryName, categoryName),
          eq(sourceChannels.available, true),
        ),
      )
      .orderBy(asc(sourceChannels.position), asc(sourceChannels.id))
      .all();

  // Walk categories in display order so auto and normal groups interleave.
  const channels: ResolvedChannel[] = [];
  for (const cat of cats) {
    if (cat.autoSourceId != null && cat.autoCategoryName != null) {
      for (const r of autoRows(cat.autoSourceId, cat.autoCategoryName)) {
        channels.push({
          displayName: r.channelName,
          logo: r.channelLogo || "",
          groupTitle: cat.name,
          tvgId: r.channelEpgId ?? "",
          epgSourceId: r.channelSourceId,
          streamUrl: buildStreamUrl(
            {
              serverUrl: r.streamBaseUrl ?? r.serverUrl,
              username: r.username,
              password: r.password,
            },
            r.streamId,
            r.outputFormat,
          ),
        });
      }
    } else {
      for (const r of byCat.get(cat.id) ?? []) {
        channels.push({
          displayName: r.customName || r.channelName,
          logo: r.customLogo || r.channelLogo || "",
          groupTitle: cat.name,
          tvgId: r.pcEpgChannelId ?? r.channelEpgId ?? "",
          epgSourceId: r.pcEpgSourceId ?? r.channelSourceId,
          streamUrl: buildStreamUrl(
            {
              serverUrl: r.streamBaseUrl ?? r.serverUrl,
              username: r.username,
              password: r.password,
            },
            r.streamId,
            r.outputFormat,
          ),
        });
      }
    }
  }

  return { playlist, channels };
}
