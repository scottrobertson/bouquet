import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { env } from "~/lib/env.server";
import * as schema from "./schema";

// Reuse the connection and the "already migrated" flag across HMR reloads.
const globalForDb = globalThis as unknown as {
  __sqlite?: Database.Database;
  __migrated?: boolean;
};

function createConnection() {
  const dir = dirname(env.databasePath);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(env.databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

const sqlite = globalForDb.__sqlite ?? createConnection();
globalForDb.__sqlite = sqlite;

// Raw connection, exposed for backup/restore which dump and reinsert rows
// directly to keep exact fidelity (no ORM type coercion).
export { sqlite };
export const db = drizzle(sqlite, { schema });

// Migrate once per process. Idempotent (drizzle tracks applied migrations) and
// runs before any query, so the schema is always ready.
if (!globalForDb.__migrated) {
  migrate(db, { migrationsFolder: "./drizzle" });
  globalForDb.__migrated = true;
}
