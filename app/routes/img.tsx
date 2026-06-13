import type { Route } from "./+types/img";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 10000;

// Block obvious internal targets so this can't be pointed at the host's own
// network. Best-effort on the hostname; enough for a self-hosted tool.
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h.endsWith(".localhost") ||
    h.startsWith("127.") ||
    h.startsWith("10.") ||
    h.startsWith("192.168.") ||
    h.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

// Proxy a remote channel logo through our origin. Fixes mixed content (http
// logos on an https page) and referer-based hotlink blocking.
export async function loader({ request }: Route.LoaderArgs) {
  const raw = new URL(request.url).searchParams.get("u");
  if (!raw) return new Response("missing url", { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return new Response("bad scheme", { status: 400 });
  }
  if (isBlockedHost(target.hostname)) {
    return new Response("blocked", { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": USER_AGENT, Accept: "image/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return new Response("upstream error", { status: 502 });
    const body = Buffer.from(await res.arrayBuffer());
    return new Response(body, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "image/png",
        // Logos rarely change; let the browser cache hard.
        "Cache-Control": "public, max-age=604800, immutable",
      },
    });
  } catch {
    return new Response("fetch failed", { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
