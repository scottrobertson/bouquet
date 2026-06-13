import { xmltvUrl, type XtreamCreds } from "~/services/xtream/client.server";
import { db } from "~/db/index.server";
import { sources } from "~/db/schema";
import { inArray } from "drizzle-orm";
import type { ResolvedChannel } from "./queries.server";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 60000;

async function fetchEpgXml(creds: XtreamCreds): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(xmltvUrl(creds), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/xml" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`EPG returned HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeXmlAttr(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Pull out the <channel> and <programme> blocks whose id is in `needed`,
// keeping the raw inner XML so it round-trips into the merged document.
function extractBlocks(
  xml: string,
  needed: Set<string>,
): { channels: Map<string, string>; programmes: string[] } {
  const channels = new Map<string, string>();
  const programmes: string[] = [];

  const channelRe = /<channel\b[^>]*\bid="([^"]*)"[^>]*>[\s\S]*?<\/channel>/gi;
  let m: RegExpExecArray | null;
  while ((m = channelRe.exec(xml)) !== null) {
    const id = decodeXmlAttr(m[1]).trim();
    if (!needed.has(id) || channels.has(id)) continue;
    channels.set(id, m[0]);
  }

  const progRe =
    /<programme\b[^>]*\bchannel="([^"]*)"[^>]*>[\s\S]*?<\/programme>/gi;
  while ((m = progRe.exec(xml)) !== null) {
    const id = decodeXmlAttr(m[1]).trim();
    if (!needed.has(id)) continue;
    programmes.push(m[0]);
  }

  return { channels, programmes };
}

export async function buildXmltv(rows: ResolvedChannel[]): Promise<string> {
  // Group the needed channel ids per source so each source's xmltv.php is
  // fetched at most once.
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

  const sourceIds = [...neededBySource.keys()];
  const channelParts: string[] = [];
  const programmeParts: string[] = [];

  if (sourceIds.length > 0) {
    const sourceRows = db
      .select({
        id: sources.id,
        serverUrl: sources.serverUrl,
        username: sources.username,
        password: sources.password,
      })
      .from(sources)
      .where(inArray(sources.id, sourceIds))
      .all();

    // First source to define a given channel id wins, so a channel shared
    // across sources is only emitted once.
    const seenChannels = new Set<string>();

    await Promise.all(
      sourceRows.map(async (s) => {
        const needed = neededBySource.get(s.id);
        if (!needed) return;
        let xml: string;
        try {
          xml = await fetchEpgXml({
            serverUrl: s.serverUrl,
            username: s.username,
            password: s.password,
          });
        } catch {
          // A source whose EPG fetch fails just contributes no guide data.
          return;
        }
        const { channels, programmes } = extractBlocks(xml, needed);
        for (const [id, block] of channels) {
          if (seenChannels.has(id)) continue;
          seenChannels.add(id);
          channelParts.push(block);
        }
        programmeParts.push(...programmes);
      }),
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<tv generator-info-name="iptv-manager">\n` +
    (channelParts.length ? channelParts.join("\n") + "\n" : "") +
    (programmeParts.length ? programmeParts.join("\n") + "\n" : "") +
    `</tv>\n`
  );
}
