const isProd = process.env.NODE_ENV === "production";

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
  databasePath: process.env.DATABASE_PATH ?? "./data/iptv.db",
  syncCron: process.env.SYNC_CRON ?? "0 4 * * *",
  port: Number(process.env.PORT ?? 3000),
};
