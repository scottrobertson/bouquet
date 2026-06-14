import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "~/db/index.server";
import { epgProgrammes, sourceEpgChannels } from "~/db/schema";
import type { ResolvedChannel } from "./queries.server";

// SQLite caps bound variables per statement, so query channel ids in batches.
const ID_CHUNK = 500;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format unix seconds as an xmltv UTC timestamp, e.g. "20240115140000 +0000". */
export function formatXmltvTime(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`
  );
}

export interface StoredProgramme {
  channelId: string;
  startTs: number;
  stopTs: number;
  title: string | null;
  subTitle: string | null;
  description: string | null;
  category: string | null;
}

// Build a <programme> element from a stored row. We rebuild it from columns
// rather than keep provider markup, the same as channelBlock does.
export function programmeBlock(p: StoredProgramme): string {
  const lines = [
    `  <programme start="${formatXmltvTime(p.startTs)}" stop="${formatXmltvTime(
      p.stopTs,
    )}" channel="${escapeXml(p.channelId)}">`,
  ];
  if (p.title) lines.push(`    <title>${escapeXml(p.title)}</title>`);
  if (p.subTitle) lines.push(`    <sub-title>${escapeXml(p.subTitle)}</sub-title>`);
  if (p.description) lines.push(`    <desc>${escapeXml(p.description)}</desc>`);
  if (p.category) lines.push(`    <category>${escapeXml(p.category)}</category>`);
  lines.push(`  </programme>`);
  return lines.join("\n");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Re-emit a <channel> from its stored definition. We rebuild it rather than keep
// the provider's raw markup so channel and programme data come from one place.
function channelBlock(
  id: string,
  displayName: string | null,
  icon: string | null,
): string {
  const lines = [`  <channel id="${escapeXml(id)}">`];
  if (displayName)
    lines.push(`    <display-name>${escapeXml(displayName)}</display-name>`);
  if (icon) lines.push(`    <icon src="${escapeXml(icon)}" />`);
  lines.push(`  </channel>`);
  return lines.join("\n");
}

// Build the merged XMLTV guide straight from the DB. Both the channel
// definitions and the programmes were stored at sync time, so there's no live
// fetch here and the output matches what the in-app guide shows.
export async function buildXmltv(rows: ResolvedChannel[]): Promise<string> {
  // The channel ids each source needs to contribute, deduped per source.
  const neededBySource = new Map<number, Set<string>>();
  for (const r of rows) {
    if (!r.tvgId) continue;
    let set = neededBySource.get(r.epgSourceId);
    if (!set) {
      set = new Set<string>();
      neededBySource.set(r.epgSourceId, set);
    }
    set.add(r.tvgId);
  }

  const channelParts: string[] = [];
  const programmeParts: string[] = [];
  // First source to define a given channel id wins, so a channel shared across
  // sources is only emitted once.
  const seenChannels = new Set<string>();

  for (const [sourceId, idSet] of neededBySource) {
    const ids = [...idSet];
    for (const ids_ of chunk(ids, ID_CHUNK)) {
      const defs = db
        .select({
          channelId: sourceEpgChannels.channelId,
          displayName: sourceEpgChannels.displayName,
          icon: sourceEpgChannels.icon,
        })
        .from(sourceEpgChannels)
        .where(
          and(
            eq(sourceEpgChannels.sourceId, sourceId),
            inArray(sourceEpgChannels.channelId, ids_),
          ),
        )
        .all();
      for (const d of defs) {
        if (seenChannels.has(d.channelId)) continue;
        seenChannels.add(d.channelId);
        channelParts.push(channelBlock(d.channelId, d.displayName, d.icon));
      }

      const progs = db
        .select({
          channelId: epgProgrammes.channelId,
          startTs: epgProgrammes.startTs,
          stopTs: epgProgrammes.stopTs,
          title: epgProgrammes.title,
          subTitle: epgProgrammes.subTitle,
          description: epgProgrammes.description,
          category: epgProgrammes.category,
        })
        .from(epgProgrammes)
        .where(
          and(
            eq(epgProgrammes.sourceId, sourceId),
            inArray(epgProgrammes.channelId, ids_),
          ),
        )
        .orderBy(asc(epgProgrammes.channelId), asc(epgProgrammes.startTs))
        .all();
      for (const p of progs) programmeParts.push(programmeBlock(p));
    }
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<tv generator-info-name="bouquet">\n` +
    (channelParts.length ? channelParts.join("\n") + "\n" : "") +
    (programmeParts.length ? programmeParts.join("\n") + "\n" : "") +
    `</tv>\n`
  );
}
