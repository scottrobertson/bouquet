/** The public-facing origin for a request. When the app runs behind a reverse
    proxy that terminates SSL, the request reaches us over http, so we trust the
    proxy's X-Forwarded-Proto / X-Forwarded-Host (falling back to the request's
    own) to build https output URLs. */
export function externalOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    url.protocol.replace(":", "");
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    url.host;
  return `${proto}://${host}`;
}
