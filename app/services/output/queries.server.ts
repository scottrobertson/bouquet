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
import { buildStreamUrl, buildTimeshiftSource } from "~/services/xtream/client.server";
import { altName } from "~/services/playlist/alt-name";

export interface ResolvedChannel {
  displayName: string;
  logo: string;
  groupTitle: string;
  tvgId: string;
  // Which source's xmltv this channel's guide comes from.
  epgSourceId: number;
  streamUrl: string;
  // Days of catchup the channel offers, 0 when none. catchupSource is the
  // timeshift URL template the player uses to play past programmes.
  catchupDays: number;
  catchupSource: string;
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
  return { playlist, channels: resolvePlaylistChannels(playlist) };
}

/** Resolve a playlist's channels in display order: names, logos, EPG (with
    alternates inheriting their primary's), stream and catchup URLs. Shared by
    the M3U/EPG output and the in-app guide so they always agree. */
export function resolvePlaylistChannels(playlist: Playlist): ResolvedChannel[] {
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
      id: playlistChannels.id,
      categoryId: playlistChannels.categoryId,
      primaryChannelId: playlistChannels.primaryChannelId,
      altPosition: playlistChannels.altPosition,
      customName: playlistChannels.customName,
      customLogo: playlistChannels.customLogo,
      pcEpgSourceId: playlistChannels.epgSourceId,
      pcEpgChannelId: playlistChannels.epgChannelId,
      channelName: sourceChannels.name,
      channelLogo: sourceChannels.logo,
      channelEpgId: sourceChannels.epgChannelId,
      streamId: sourceChannels.streamId,
      channelSourceId: sourceChannels.sourceId,
      tvArchiveDuration: sourceChannels.tvArchiveDuration,
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

  // Resolved name and EPG for every channel in the playlist (including disabled
  // ones), so an alternate can take its primary's name and guide even when the
  // primary is hidden from output.
  const primaryNameById = new Map<number, string>();
  const primaryEpgById = new Map<number, { tvgId: string; epgSourceId: number }>();
  const primaryLogoById = new Map<number, string>();
  // Whether each channel is enabled, so an alternate can be gated on its
  // primary: a disabled primary takes its whole group out of output.
  const enabledById = new Map<number, boolean>();
  for (const r of db
    .select({
      id: playlistChannels.id,
      enabled: playlistChannels.enabled,
      customName: playlistChannels.customName,
      customLogo: playlistChannels.customLogo,
      pcEpgSourceId: playlistChannels.epgSourceId,
      pcEpgChannelId: playlistChannels.epgChannelId,
      channelName: sourceChannels.name,
      channelLogo: sourceChannels.logo,
      channelEpgId: sourceChannels.epgChannelId,
      channelSourceId: sourceChannels.sourceId,
    })
    .from(playlistChannels)
    .innerJoin(
      sourceChannels,
      eq(playlistChannels.sourceChannelId, sourceChannels.id),
    )
    .where(eq(playlistChannels.playlistId, playlist.id))
    .all()) {
    enabledById.set(r.id, r.enabled);
    primaryNameById.set(r.id, r.customName || r.channelName);
    primaryEpgById.set(r.id, {
      tvgId: r.pcEpgChannelId ?? r.channelEpgId ?? "",
      epgSourceId: r.pcEpgSourceId ?? r.channelSourceId,
    });
    primaryLogoById.set(r.id, r.customLogo || r.channelLogo || "");
  }

  // Group enabled channels by category, dropping any alternate whose primary is
  // disabled. The primary gates the whole group, so a backup never emits on its
  // own under a name and guide whose primary is gone.
  const byCat = new Map<number, typeof normalRows>();
  for (const r of normalRows) {
    if (r.primaryChannelId != null && enabledById.get(r.primaryChannelId) === false)
      continue;
    const list = byCat.get(r.categoryId);
    if (list) list.push(r);
    else byCat.set(r.categoryId, [r]);
  }

  // Order each category so every primary is immediately followed by its
  // alternates. Alternates whose primary is filtered out of output stay where
  // they fall in position order.
  const sequenceCategory = (rows: typeof normalRows): typeof normalRows => {
    const altsByPrimary = new Map<number, typeof normalRows>();
    for (const r of rows) {
      if (r.primaryChannelId == null) continue;
      const list = altsByPrimary.get(r.primaryChannelId);
      if (list) list.push(r);
      else altsByPrimary.set(r.primaryChannelId, [r]);
    }
    for (const list of altsByPrimary.values())
      list.sort((a, b) => a.altPosition - b.altPosition);

    const present = new Set(rows.map((r) => r.id));
    const out: typeof normalRows = [];
    for (const r of rows) {
      if (r.primaryChannelId != null) {
        if (!present.has(r.primaryChannelId)) out.push(r);
        continue;
      }
      out.push(r);
      for (const alt of altsByPrimary.get(r.id) ?? []) out.push(alt);
    }
    return out;
  };

  const resolveName = (r: (typeof normalRows)[number]): string => {
    // Alternates are always auto-named from their primary; a stored custom name
    // is ignored so they can never drift from the primary's name.
    if (r.primaryChannelId != null) {
      const primaryName = primaryNameById.get(r.primaryChannelId) ?? r.channelName;
      return altName(playlist.altNameTemplate, primaryName, r.altPosition + 1);
    }
    if (r.customName) return r.customName;
    return r.channelName;
  };

  const resolveEpg = (r: (typeof normalRows)[number]) => {
    // Alternates always use their primary's guide; their own EPG is ignored.
    if (r.primaryChannelId != null) {
      const pe = primaryEpgById.get(r.primaryChannelId);
      if (pe) return pe;
    }
    return {
      tvgId: r.pcEpgChannelId ?? r.channelEpgId ?? "",
      epgSourceId: r.pcEpgSourceId ?? r.channelSourceId,
    };
  };

  const resolveLogo = (r: (typeof normalRows)[number]): string => {
    // Alternates always use their primary's logo; their own is ignored.
    if (r.primaryChannelId != null) {
      const pl = primaryLogoById.get(r.primaryChannelId);
      if (pl != null) return pl;
    }
    return r.customLogo || r.channelLogo || "";
  };

  // Live channels for an auto-sync category, straight from the source catalog.
  const autoRows = (sourceId: number, categoryName: string) =>
    db
      .select({
        channelName: sourceChannels.name,
        channelLogo: sourceChannels.logo,
        channelEpgId: sourceChannels.epgChannelId,
        streamId: sourceChannels.streamId,
        channelSourceId: sourceChannels.sourceId,
        tvArchiveDuration: sourceChannels.tvArchiveDuration,
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
        const creds = {
          serverUrl: r.streamBaseUrl ?? r.serverUrl,
          username: r.username,
          password: r.password,
        };
        channels.push({
          displayName: r.channelName,
          logo: r.channelLogo || "",
          groupTitle: cat.name,
          tvgId: r.channelEpgId ?? "",
          epgSourceId: r.channelSourceId,
          streamUrl: buildStreamUrl(creds, r.streamId, r.outputFormat),
          catchupDays: r.tvArchiveDuration,
          catchupSource:
            r.tvArchiveDuration > 0
              ? buildTimeshiftSource(creds, r.streamId, r.outputFormat)
              : "",
        });
      }
    } else {
      for (const r of sequenceCategory(byCat.get(cat.id) ?? [])) {
        const creds = {
          serverUrl: r.streamBaseUrl ?? r.serverUrl,
          username: r.username,
          password: r.password,
        };
        const epg = resolveEpg(r);
        channels.push({
          displayName: resolveName(r),
          logo: resolveLogo(r),
          groupTitle: cat.name,
          tvgId: epg.tvgId,
          epgSourceId: epg.epgSourceId,
          streamUrl: buildStreamUrl(creds, r.streamId, r.outputFormat),
          catchupDays: r.tvArchiveDuration,
          catchupSource:
            r.tvArchiveDuration > 0
              ? buildTimeshiftSource(creds, r.streamId, r.outputFormat)
              : "",
        });
      }
    }
  }

  return channels;
}
