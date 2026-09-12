import { join } from "node:path";

const isProd = process.env.NODE_ENV === "production";

// Everything we persist (the SQLite db and backups) lives under here.
const configPath = process.env.CONFIG_PATH ?? "./data";

export const env = {
  isProd,
  configPath,
  databasePath: join(configPath, "bouquet.db"),
  backupsPath: join(configPath, "backups"),
  // Hourly tick; the endpoint syncs only sources whose interval has elapsed.
  syncCron: process.env.SYNC_CRON ?? "0 * * * *",
  // Same hourly tick for probing; the endpoint probes only due sources.
  probeCron: process.env.PROBE_CRON ?? "0 * * * *",
  backupCron: process.env.BACKUP_CRON ?? "0 3 * * *",
  backupKeep: Number(process.env.BACKUP_KEEP ?? 14),
  // ffprobe/ffmpeg binaries used to read stream quality. Override if not on PATH.
  ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  port: Number(process.env.PORT ?? 3000),
};
