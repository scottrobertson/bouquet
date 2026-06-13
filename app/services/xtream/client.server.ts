// Xtream Codes API client. Talks to a provider's player_api.php and xmltv.php.
// This app never proxies streams; we only read metadata and build the direct
// stream URLs that go into the output M3U.

export interface XtreamCreds {
  serverUrl: string;
  username: string;
  password: string;
}

export interface XtreamLiveCategory {
  categoryId: string;
  categoryName: string;
}

export interface XtreamLiveStream {
  streamId: string;
  name: string;
  logo: string | null;
  epgChannelId: string | null;
  categoryId: string | null;
  tvArchive: boolean;
}

export interface XtreamEpgChannel {
  channelId: string;
  displayName: string | null;
  icon: string | null;
}

export interface XtreamAccount {
  ok: boolean;
  message?: string;
  status?: string;
  expiresAt?: Date | null;
  maxConnections?: number | null;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 30000;
// The full EPG (xmltv.php) can be tens of MB, so give it much longer.
const EPG_TIMEOUT_MS = 180000;

/** Strip trailing slashes so we can append paths cleanly. */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

async function fetchWithTimeout(
  url: string,
  accept: string,
  timeoutMs: number = TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

function playerApiUrl(creds: XtreamCreds, params: Record<string, string>): string {
  const base = normalizeServerUrl(creds.serverUrl);
  const qs = new URLSearchParams({
    username: creds.username,
    password: creds.password,
    ...params,
  });
  return `${base}/player_api.php?${qs.toString()}`;
}

async function playerApi(
  creds: XtreamCreds,
  params: Record<string, string>,
): Promise<unknown> {
  const res = await fetchWithTimeout(playerApiUrl(creds, params), "application/json");
  if (!res.ok) {
    throw new Error(`Provider returned HTTP ${res.status}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Provider did not return valid JSON (check the server URL)");
  }
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Validate credentials and read account status. */
export async function validateAccount(creds: XtreamCreds): Promise<XtreamAccount> {
  let data: any;
  try {
    data = await playerApi(creds, {});
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Request failed" };
  }
  const info = data?.user_info;
  if (!info || Number(info.auth) !== 1) {
    return { ok: false, message: info?.message || "Authentication failed" };
  }
  const exp = info.exp_date ? new Date(Number(info.exp_date) * 1000) : null;
  return {
    ok: true,
    status: asString(info.status) ?? undefined,
    expiresAt: exp,
    maxConnections: info.max_connections ? Number(info.max_connections) : null,
  };
}

export async function fetchLiveCategories(
  creds: XtreamCreds,
): Promise<XtreamLiveCategory[]> {
  const data = await playerApi(creds, { action: "get_live_categories" });
  if (!Array.isArray(data)) return [];
  return data.map((c: any) => ({
    categoryId: String(c.category_id),
    categoryName: asString(c.category_name) ?? "Uncategorized",
  }));
}

export async function fetchLiveStreams(
  creds: XtreamCreds,
): Promise<XtreamLiveStream[]> {
  const data = await playerApi(creds, { action: "get_live_streams" });
  if (!Array.isArray(data)) return [];
  return data.map((s: any) => ({
    streamId: String(s.stream_id),
    name: asString(s.name) ?? `Channel ${s.stream_id}`,
    logo: asString(s.stream_icon),
    epgChannelId: asString(s.epg_channel_id),
    categoryId: asString(s.category_id),
    tvArchive: Number(s.tv_archive) === 1,
  }));
}

/** Build the direct stream URL that goes into the output M3U. */
export function buildStreamUrl(
  creds: XtreamCreds,
  streamId: string,
  ext: "ts" | "m3u8" = "ts",
): string {
  const base = normalizeServerUrl(creds.serverUrl);
  return `${base}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(
    creds.password,
  )}/${streamId}.${ext}`;
}

export function xmltvUrl(creds: XtreamCreds): string {
  const base = normalizeServerUrl(creds.serverUrl);
  const qs = new URLSearchParams({
    username: creds.username,
    password: creds.password,
  });
  return `${base}/xmltv.php?${qs.toString()}`;
}

/** Fetch xmltv.php and pull out just the <channel> definitions. We regex the
    channel blocks rather than parse the whole guide, which can be tens of MB
    of programme data we don't need here. */
export async function fetchEpgChannels(
  creds: XtreamCreds,
): Promise<XtreamEpgChannel[]> {
  const res = await fetchWithTimeout(
    xmltvUrl(creds),
    "application/xml",
    EPG_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`EPG returned HTTP ${res.status}`);
  const xml = await res.text();
  return parseEpgChannels(xml);
}

export function parseEpgChannels(xml: string): XtreamEpgChannel[] {
  const channels: XtreamEpgChannel[] = [];
  const seen = new Set<string>();
  const channelRe = /<channel\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/gi;
  let m: RegExpExecArray | null;
  while ((m = channelRe.exec(xml)) !== null) {
    const channelId = decodeXml(m[1]).trim();
    if (!channelId || seen.has(channelId)) continue;
    seen.add(channelId);
    const body = m[2];
    const nameMatch = body.match(/<display-name[^>]*>([\s\S]*?)<\/display-name>/i);
    const iconMatch = body.match(/<icon\b[^>]*\bsrc="([^"]*)"/i);
    channels.push({
      channelId,
      displayName: nameMatch ? decodeXml(nameMatch[1]).trim() : null,
      icon: iconMatch ? decodeXml(iconMatch[1]).trim() : null,
    });
  }
  return channels;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
