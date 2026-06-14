import { join } from "node:path";

const isProd = process.env.NODE_ENV === "production";

// Everything we persist (the SQLite db and backups) lives under here.
const configPath = process.env.CONFIG_PATH ?? "./data";

function required(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isProd) {
    throw new Error(`Missing required env var ${name}`);
  }
  // Dev convenience only. Production refuses to start without these set.
  console.warn(`[env] ${name} not set, using insecure dev default`);
  return devFallback;
}

export const env = {
  isProd,
  appPassword: required("APP_PASSWORD", "admin"),
  sessionSecret: required("SESSION_SECRET", "dev-insecure-session-secret"),
  configPath,
  databasePath: join(configPath, "bouquet.db"),
  backupsPath: join(configPath, "backups"),
  // Hourly tick; the endpoint syncs only sources whose interval has elapsed.
  syncCron: process.env.SYNC_CRON ?? "0 * * * *",
  backupCron: process.env.BACKUP_CRON ?? "0 3 * * *",
  backupKeep: Number(process.env.BACKUP_KEEP ?? 14),
  port: Number(process.env.PORT ?? 3000),
};
