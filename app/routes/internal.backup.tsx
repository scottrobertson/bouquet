import { data } from "react-router";
import { env } from "~/lib/env.server";
import { createBackup, pruneAutoBackups } from "~/services/backup/backup.server";
import type { Route } from "./+types/internal.backup";

// Internal backup endpoint, called by the cron job in server.js.
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const token = request.headers.get("x-internal-token");
  if (token !== env.sessionSecret) {
    return new Response("unauthorized", { status: 401 });
  }
  const { file } = createBackup("auto");
  pruneAutoBackups(env.backupKeep);
  return data({ ok: true, file });
}
