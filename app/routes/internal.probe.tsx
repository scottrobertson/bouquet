import { data } from "react-router";
import { env } from "~/lib/env.server";
import { probeDueSources } from "~/services/probe/probe.server";
import type { Route } from "./+types/internal.probe";

// Internal probe endpoint, called by the cron job in server.js.
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const token = request.headers.get("x-internal-token");
  if (token !== env.sessionSecret) {
    return new Response("unauthorized", { status: 401 });
  }
  await probeDueSources();
  return data({ ok: true });
}
