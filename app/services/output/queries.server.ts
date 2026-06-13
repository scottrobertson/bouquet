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

  const rows = db
    .select({
      customName: playlistChannels.customName,
      customLogo: playlistChannels.customLogo,
      pcEpgSourceId: playlistChannels.epgSourceId,
      pcEpgChannelId: playlistChannels.epgChannelId,
      categoryName: playlistCategories.name,
      channelName: sourceChannels.name,
      channelLogo: sourceChannels.logo,
      channelEpgId: sourceChannels.epgChannelId,
      streamId: sourceChannels.streamId,
      channelSourceId: sourceChannels.sourceId,
      serverUrl: sources.serverUrl,
      username: sources.username,
      password: sources.password,
    })
    .from(playlistChannels)
    .innerJoin(
      playlistCategories,
      eq(playlistChannels.categoryId, playlistCategories.id),
    )
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
    .orderBy(asc(playlistCategories.position), asc(playlistChannels.position))
    .all();

  const channels: ResolvedChannel[] = rows.map((r) => ({
    displayName: r.customName || r.channelName,
    logo: r.customLogo || r.channelLogo || "",
    groupTitle: r.categoryName,
    tvgId: r.pcEpgChannelId ?? r.channelEpgId ?? "",
    epgSourceId: r.pcEpgSourceId ?? r.channelSourceId,
    streamUrl: buildStreamUrl(
      {
        serverUrl: r.serverUrl,
        username: r.username,
        password: r.password,
      },
      r.streamId,
    ),
  }));

  return { playlist, channels };
}
