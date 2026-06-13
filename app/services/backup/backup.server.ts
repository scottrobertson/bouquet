import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { sqlite } from "~/db/index.server";
import { env } from "~/lib/env.server";
import { invalidateAll } from "~/services/output/cache.server";

// Tables captured in a backup, in an order safe to insert (parents first). We
// dump and reinsert raw rows via the sqlite connection so values round-trip
// exactly, with no ORM type coercion.
const TABLES = [
  "sources",
  "source_categories",
  "source_channels",
  "playlists",
  "playlist_categories",
  "playlist_channels",
] as const;

type TableName = (typeof TABLES)[number];
export type BackupKind = "manual" | "auto" | "prerestore";

export type BackupMeta = {
  app: string;
  formatVersion: number;
  schemaVersion: number;
  createdAt: string;
  trigger: BackupKind;
  counts: Record<string, number>;
};

type BackupFile = {
  meta: BackupMeta;
  tables: Record<string, Record<string, unknown>[]>;
};

export type BackupInfo = {
  file: string;
  size: number;
  modifiedAt: string;
  valid: boolean;
  trigger: BackupKind | "unknown";
  createdAt: string | null;
  counts: Record<string, number> | null;
  schemaVersion: number | null;
  schemaMismatch: boolean;
};

const FORMAT_VERSION = 1;
// Don't try to parse absurdly large files when listing; just show them.
const MAX_PARSE_BYTES = 100 * 1024 * 1024;

/** How many migrations have been applied. Recorded in each backup so we can
    refuse to restore one taken against a different schema. */
function currentSchemaVersion(): number {
  try {
    const row = sqlite
      .prepare("select count(*) as n from __drizzle_migrations")
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function ensureDir() {
  if (!existsSync(env.backupsPath)) {
    mkdirSync(env.backupsPath, { recursive: true });
  }
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Resolve to a plain file inside the backups directory (basename strips any
    path, so a caller can't escape the folder). */
function resolveInside(file: string): string {
  const full = resolve(env.backupsPath, basename(file));
  if (!full.startsWith(resolve(env.backupsPath) + sep)) {
    throw new Error("Invalid backup filename");
  }
  return full;
}

function dumpRows(table: TableName): Record<string, unknown>[] {
  // Only the source channels a playlist actually uses, not the whole catalog.
  const queryBuilt =
    table === "source_channels"
      ? "select * from source_channels where id in (select distinct source_channel_id from playlist_channels)"
      : `select * from ${table}`;
  return sqlite.prepare(queryBuilt).all() as Record<string, unknown>[];
}

/** Write a backup file and return its info. */
export function createBackup(trigger: BackupKind): { file: string; meta: BackupMeta } {
  ensureDir();
  const tables: Record<string, Record<string, unknown>[]> = {};
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = dumpRows(t);
    tables[t] = rows;
    counts[t] = rows.length;
  }

  const meta: BackupMeta = {
    app: "bouquet",
    formatVersion: FORMAT_VERSION,
    schemaVersion: currentSchemaVersion(),
    createdAt: new Date().toISOString(),
    trigger,
    counts,
  };

  const file = `bouquet-${trigger}-${stamp(new Date())}.json`;
  writeFileSync(join(env.backupsPath, file), JSON.stringify({ meta, tables }));
  return { file, meta };
}

/** List every .json in the backups directory, newest first. Hand-dropped files
    show up too; unparseable ones are flagged invalid (still deletable). */
export function listBackups(): BackupInfo[] {
  if (!existsSync(env.backupsPath)) return [];
  const current = currentSchemaVersion();

  const items = readdirSync(env.backupsPath)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const stat = statSync(join(env.backupsPath, file));
      const info: BackupInfo = {
        file,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        valid: false,
        trigger: "unknown",
        createdAt: null,
        counts: null,
        schemaVersion: null,
        schemaMismatch: false,
      };
      if (stat.size <= MAX_PARSE_BYTES) {
        try {
          const parsed = JSON.parse(
            readFileSync(join(env.backupsPath, file), "utf8"),
          ) as Partial<BackupFile>;
          if (parsed.tables && typeof parsed.tables === "object") {
            info.valid = true;
            const m = parsed.meta;
            if (m) {
              info.trigger = m.trigger ?? "unknown";
              info.createdAt = m.createdAt ?? null;
              info.counts = m.counts ?? null;
              info.schemaVersion = m.schemaVersion ?? null;
              info.schemaMismatch =
                m.schemaVersion != null && m.schemaVersion !== current;
            }
          }
        } catch {
          // Leave it flagged invalid.
        }
      }
      return info;
    });

  return items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function insertRows(table: TableName, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const stmt = sqlite.prepare(
    `insert into ${table} (${cols.map((c) => `"${c}"`).join(", ")}) ` +
      `values (${cols.map(() => "?").join(", ")})`,
  );
  for (const row of rows) {
    stmt.run(
      cols.map((c) => {
        const v = row[c];
        // JSON may carry booleans; SQLite wants 0/1.
        if (v === true) return 1;
        if (v === false) return 0;
        return v as never;
      }),
    );
  }
}

/** Replace all data with the contents of a backup file. Takes a safety backup
    first, then wipes and reinserts inside one transaction. */
export function restoreBackup(file: string): { safetyFile: string } {
  const full = resolveInside(file);
  if (!existsSync(full)) throw new Error("Backup not found");

  let parsed: BackupFile;
  try {
    parsed = JSON.parse(readFileSync(full, "utf8")) as BackupFile;
  } catch {
    throw new Error("That file is not valid JSON");
  }
  if (!parsed.tables || typeof parsed.tables !== "object") {
    throw new Error("That file is not a Bouquet backup");
  }

  const sv = parsed.meta?.schemaVersion;
  const current = currentSchemaVersion();
  if (sv != null && sv !== current) {
    throw new Error(
      `This backup is from a different schema version (backup ${sv}, current ${current}). Restore aborted.`,
    );
  }

  // Reversible: keep a snapshot of the current state before we wipe it.
  const { file: safetyFile } = createBackup("prerestore");

  const run = sqlite.transaction(() => {
    // Deleting the roots cascades to every child table.
    sqlite.prepare("delete from sources").run();
    sqlite.prepare("delete from playlists").run();
    for (const t of TABLES) insertRows(t, parsed.tables[t] ?? []);
  });
  run();

  invalidateAll();
  return { safetyFile };
}

export function deleteBackup(file: string): void {
  unlinkSync(resolveInside(file));
}

/** Read a backup's raw JSON for download. Throws if it isn't in the folder. */
export function readBackup(file: string): { name: string; body: string } {
  const full = resolveInside(file);
  if (!existsSync(full)) throw new Error("Backup not found");
  return { name: basename(full), body: readFileSync(full, "utf8") };
}

/** Keep only the newest `keep` auto-backups. Manual, prerestore, and
    hand-dropped files are never touched. */
export function pruneAutoBackups(keep: number): void {
  if (!existsSync(env.backupsPath)) return;
  const autos = readdirSync(env.backupsPath)
    .filter((f) => /^bouquet-auto-.*\.json$/.test(f))
    .map((file) => ({
      file,
      mtime: statSync(join(env.backupsPath, file)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { file } of autos.slice(Math.max(0, keep))) {
    unlinkSync(join(env.backupsPath, file));
  }
}
