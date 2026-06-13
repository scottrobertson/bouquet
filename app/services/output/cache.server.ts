import { createHash } from "node:crypto";

interface CacheEntry {
  etag: string;
  body: string;
  builtAt: number;
}

// Players poll these URLs often and providers rate-limit, so we cache the
// built output and only rebuild once a TTL has passed.
const globalForCache = globalThis as unknown as {
  __outputCache?: Map<string, CacheEntry>;
};

const cache = globalForCache.__outputCache ?? new Map<string, CacheEntry>();
globalForCache.__outputCache = cache;

function sha1(body: string): string {
  return createHash("sha1").update(body).digest("hex");
}

export async function getOrBuild(
  key: string,
  ttlMs: number,
  builder: () => Promise<string>,
): Promise<{ body: string; etag: string }> {
  const existing = cache.get(key);
  if (existing && Date.now() - existing.builtAt < ttlMs) {
    return { body: existing.body, etag: existing.etag };
  }
  const body = await builder();
  const entry: CacheEntry = { body, etag: sha1(body), builtAt: Date.now() };
  cache.set(key, entry);
  return { body: entry.body, etag: entry.etag };
}

export function invalidate(token: string): void {
  cache.delete(`m3u:${token}`);
  cache.delete(`epg:${token}`);
}

/** Drop all cached output. Used when a change can affect many playlists at once,
    e.g. enabling/disabling a source category. */
export function invalidateAll(): void {
  cache.clear();
}
