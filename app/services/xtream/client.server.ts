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
  // Days of catchup/archive the provider keeps. 0 when there's no archive.
  tvArchiveDuration: number;
}

export interface XtreamProgramme {
  channelId: string;
  startTs: number;
  stopTs: number;
  title: string | null;
  description: string | null;
  // Provider flags this programme as available from the archive (catchup).
  hasArchive: boolean;
}

export interface XtreamAccount {
  ok: boolean;
  message?: string;
  status?: string;
  expiresAt?: Date | null;
  maxConnections?: number | null;
  // The provider's real base URL from the API's server_info, if it gave one.
  streamBaseUrl?: string | null;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 30000;

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

/** The provider's real base URL from server_info, e.g. http://host:8080. Lets
    the output use the real address even when serverUrl points at a proxy. */
function streamBaseFromServerInfo(si: any): string | null {
  const host = asString(si?.url);
  if (!host) return null;
  // If the panel already handed back a full URL, trust it.
  if (/^https?:\/\//i.test(host)) return normalizeServerUrl(host);
  const protocol = asString(si?.server_protocol) ?? "http";
  const port =
    protocol === "https"
      ? (asString(si?.https_port) ?? asString(si?.port))
      : asString(si?.port);
  return normalizeServerUrl(port ? `${protocol}://${host}:${port}` : `${protocol}://${host}`);
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
    streamBaseUrl: streamBaseFromServerInfo(data?.server_info),
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
    tvArchiveDuration: Math.max(0, Math.trunc(Number(s.tv_archive_duration)) || 0),
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

/** Build the catchup-source template for a channel's archive. The {duration},
    {Y}, {m}, {d}, {H}, {M} placeholders are filled in by the player when it
    requests a past programme. */
export function buildTimeshiftSource(
  creds: XtreamCreds,
  streamId: string,
  ext: "ts" | "m3u8" = "ts",
): string {
  const base = normalizeServerUrl(creds.serverUrl);
  return `${base}/timeshift/${encodeURIComponent(creds.username)}/${encodeURIComponent(
    creds.password,
  )}/{duration}/{Y}-{m}-{d}:{H}-{M}/${streamId}.${ext}`;
}

function decodeBase64(s: string): string {
  try {
    return Buffer.from(s, "base64").toString("utf-8");
  } catch {
    return s;
  }
}

/** Pull programmes out of a get_simple_data_table response. Titles and
    descriptions come back base64 encoded; times come as unix seconds. The
    channelId we store is the one we asked for, so it lines up with tvgId. */
export function parseSimpleDataTable(
  data: unknown,
  channelId: string,
): XtreamProgramme[] {
  const listings = (data as any)?.epg_listings;
  if (!Array.isArray(listings)) return [];
  const out: XtreamProgramme[] = [];
  for (const l of listings) {
    const startTs = Math.trunc(Number(l?.start_timestamp));
    const stopTs = Math.trunc(Number(l?.stop_timestamp));
    if (!Number.isFinite(startTs) || !Number.isFinite(stopTs)) continue;
    if (stopTs <= startTs) continue;
    out.push({
      channelId,
      startTs,
      stopTs,
      title: asString(decodeBase64(asString(l?.title) ?? "")),
      description: asString(decodeBase64(asString(l?.description) ?? "")),
      hasArchive: Number(l?.has_archive) === 1,
    });
  }
  return out;
}

/** Fetch a single channel's EPG via get_simple_data_table. Unlike xmltv.php
    this returns recently-aired programmes too, plus a per-programme archive
    flag, which is how players like TiviMate show catchup history. */
export async function fetchSimpleDataTable(
  creds: XtreamCreds,
  streamId: string,
  channelId: string,
): Promise<XtreamProgramme[]> {
  const data = await playerApi(creds, {
    action: "get_simple_data_table",
    stream_id: streamId,
  });
  return parseSimpleDataTable(data, channelId);
}
