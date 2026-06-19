import { onSourceChange } from "~/services/events.server";
import type { Route } from "./+types/events";

// Server-sent events stream. Tabs open this while a sync or probe is running and
// revalidate when a source changes, so updates land instantly instead of on a
// polling timer. One-directional (server to browser), so SSE not WebSockets.

// Nudge the connection every 20s so reverse proxies don't drop it as idle.
const HEARTBEAT_MS = 20_000;

export async function loader({ request }: Route.LoaderArgs) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string) => controller.enqueue(encoder.encode(data));

      // Open with a comment so headers flush and the browser fires `onopen`
      // straight away, and set the reconnect delay.
      send(`retry: 3000\n: connected\n\n`);

      const unsubscribe = onSourceChange((change) => {
        send(`data: ${JSON.stringify(change)}\n\n`);
      });

      // Comment line keeps the connection warm without triggering a client event.
      const heartbeat = setInterval(() => send(`:keepalive\n\n`), HEARTBEAT_MS);

      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      // no-transform stops the Express compression middleware from buffering it.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
