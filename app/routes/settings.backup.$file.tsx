import { readBackup } from "~/services/backup/backup.server";
import type { Route } from "./+types/settings.backup.$file";

// Download a backup file so it can be kept off-box.
export function loader({ params }: Route.LoaderArgs) {
  let backup;
  try {
    backup = readBackup(params.file);
  } catch {
    throw new Response("Not found", { status: 404 });
  }
  return new Response(new Uint8Array(backup.body), {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${backup.name}"`,
    },
  });
}
