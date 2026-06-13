import { data } from "react-router";
import { env } from "~/lib/env.server";
import { syncAllSources } from "~/services/sync/sync.server";
import type { Route } from "./+types/internal.sync";

// Internal sync endpoint, called by the cron job in server.js.
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const token = request.headers.get("x-internal-token");
  if (token !== env.sessionSecret) {
    return new Response("unauthorized", { status: 401 });
  }
  await syncAllSources();
  return data({ ok: true });
}
