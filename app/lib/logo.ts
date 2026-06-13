/** Route a remote logo through our own origin (see routes/img.tsx). Providers
    serve a lot of logos over http or behind referer-based hotlink protection,
    both of which a browser blocks on an https page. Proxying makes them
    same-origin and referer-free, so they load. */
export function logoSrc(url?: string | null): string | undefined {
  const u = url?.trim();
  if (!u) return undefined;
  return `/img?u=${encodeURIComponent(u)}`;
}
