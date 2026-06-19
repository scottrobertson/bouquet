import { and, inArray } from "drizzle-orm";
import { db } from "~/db/index.server";
import { sourceEpgChannels } from "~/db/schema";

/** What we need from a channel to work out its EPG logo: its own source and
    source-default EPG, plus any per-playlist EPG override. */
export type EpgLogoRef = {
  // The channel's own source.
  channelSourceId: number;
  // The EPG id the channel's source ships by default (source_channels.epg_channel_id).
  sourceDefaultEpgId: string | null;
  // Per-playlist EPG override, null when not overridden.
  epgSourceId: number | null;
  epgChannelId: string | null;
};

/** The EPG channel a ref points at, but only when it's not the channel's own
    source default. The default keeps the source logo; a custom pick borrows the
    picked EPG channel's logo. */
function customEpg(ref: EpgLogoRef): { sourceId: number; channelId: string } | null {
  const sourceId = ref.epgSourceId ?? ref.channelSourceId;
  const channelId = ref.epgChannelId ?? ref.sourceDefaultEpgId;
  if (!channelId) return null;
  if (sourceId === ref.channelSourceId && channelId === ref.sourceDefaultEpgId)
    return null;
  return { sourceId, channelId };
}

/** Build a logo lookup for a set of channels. The returned function gives the
    icon of the EPG channel a ref points at when that EPG is a custom pick, else
    "". Each EPG channel's icon is the logo of the source channel it came from,
    so picking another provider's EPG borrows that provider's logo. */
export function epgLogoLookup(refs: EpgLogoRef[]): (ref: EpgLogoRef) => string {
  const sourceIds = new Set<number>();
  const channelIds = new Set<string>();
  for (const ref of refs) {
    const epg = customEpg(ref);
    if (!epg) continue;
    sourceIds.add(epg.sourceId);
    channelIds.add(epg.channelId);
  }

  const byKey = new Map<string, string>();
  if (channelIds.size > 0) {
    for (const e of db
      .select({
        sourceId: sourceEpgChannels.sourceId,
        channelId: sourceEpgChannels.channelId,
        icon: sourceEpgChannels.icon,
      })
      .from(sourceEpgChannels)
      .where(
        and(
          inArray(sourceEpgChannels.sourceId, [...sourceIds]),
          inArray(sourceEpgChannels.channelId, [...channelIds]),
        ),
      )
      .all()) {
      if (e.icon) byKey.set(`${e.sourceId}:${e.channelId}`, e.icon);
    }
  }

  return (ref) => {
    const epg = customEpg(ref);
    if (!epg) return "";
    return byKey.get(`${epg.sourceId}:${epg.channelId}`) ?? "";
  };
}
