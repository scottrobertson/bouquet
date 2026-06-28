import cron from "node-cron";

import { env } from "~/lib/env.server";
import { createBackup, pruneAutoBackups } from "~/services/backup/backup.server";
import { probeDueSources } from "~/services/probe/probe.server";
import { syncDueSources } from "~/services/sync/sync.server";

// Cron ticks hourly and each job only acts on what's actually due, so the
// per-source interval is what controls real timing.
//
// node-cron doesn't stop a run starting while the last one is still going, and
// a sync can outlast the tick, so we skip a tick if the job is still running.
function schedule(label: string, expression: string, run: () => Promise<void>) {
  if (!cron.validate(expression)) {
    console.warn(`[cron] invalid ${label} cron "${expression}", disabled`);
    return;
  }

  let running = false;
  cron.schedule(expression, async () => {
    if (running) {
      console.warn(`[cron] ${label} still running, skipping this tick`);
      return;
    }
    running = true;
    try {
      await run();
      console.log(`[cron] ${label} done`);
    } catch (err) {
      console.error(`[cron] ${label} failed`, err);
    } finally {
      running = false;
    }
  });
  console.log(`[cron] scheduled ${label}: ${expression}`);
}

// Boots node-cron in-process. Called once when the server bundle loads (from
// entry.server). Dev runs `react-router dev`, which never loads this path, but
// guard on isProd anyway so the scheduler can't start outside production.
export function startScheduler() {
  if (!env.isProd) return;

  schedule("sync", env.syncCron, () => syncDueSources());
  schedule("probe", env.probeCron, () => probeDueSources());
  schedule("backup", env.backupCron, async () => {
    createBackup("auto");
    pruneAutoBackups(env.backupKeep);
  });
}
