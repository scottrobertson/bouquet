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
import { gunzipSync, gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sqlite } from "~/db/index.server";
import { env } from "~/lib/env.server";
import { invalidateAll } from "~/services/output/cache.server";

// A backup is a gzipped copy of the whole SQLite database. Restoring replaces
// everything, and the database's own migrations bring an older backup up to the
// current schema, so backups keep working across app upgrades (the same model
// Sonarr and Immich use). The source catalog is included; it's also rebuildable
// by re-syncing, but a full snapshot keeps restore simple and lossless.

export type BackupKind = "manual" | "auto" | "prerestore";

export type BackupInfo = {
  file: string;
  size: number;
  modifiedAt: string;
  valid: boolean;
  trigger: BackupKind | "unknown";
  createdAt: string | null;
  // Schema version (count of applied migrations) the backup was taken at.
  version: number | null;
  // Backup is from a newer schema than the running app, so it can't be restored
  // without upgrading first.
  isNewerThanApp: boolean;
};

const MIGRATIONS = "./drizzle";
const FILE_RE =
  /^bouquet-(manual|auto|prerestore)-v(\d+)-(\d{8})-(\d{6})\.db\.gz$/;

/** How many migrations have been applied to a database connection. */
function schemaVersion(db: Database.Database): number {
  try {
    const row = db
      .prepare("select count(*) as n from __drizzle_migrations")
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function currentSchemaVersion(): number {
  return schemaVersion(sqlite);
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

const sqlLiteral = (p: string) => p.replace(/'/g, "''");

/** Write a gzipped snapshot of the whole database and return its info. */
export function createBackup(trigger: BackupKind): { file: string; version: number } {
  ensureDir();
  const version = currentSchemaVersion();
  const file = `bouquet-${trigger}-v${version}-${stamp(new Date())}.db.gz`;

  // VACUUM INTO writes a clean, consistent single-file copy (WAL folded in).
  const tmp = join(env.backupsPath, `.tmp-${file}.db`);
  if (existsSync(tmp)) unlinkSync(tmp);
  sqlite.exec(`VACUUM INTO '${sqlLiteral(tmp)}'`);
  writeFileSync(join(env.backupsPath, file), gzipSync(readFileSync(tmp)));
  unlinkSync(tmp);

  return { file, version };
}

/** List backups newest first. Recognises our own files (parsing trigger, version
    and date from the name); anything else is flagged so it can still be deleted. */
export function listBackups(): BackupInfo[] {
  if (!existsSync(env.backupsPath)) return [];
  const current = currentSchemaVersion();

  return readdirSync(env.backupsPath)
    .filter((f) => f.endsWith(".db.gz") || f.endsWith(".json"))
    .filter((f) => !f.startsWith("."))
    .map((file) => {
      const stat = statSync(join(env.backupsPath, file));
      const m = FILE_RE.exec(file);
      const version = m ? Number(m[2]) : null;
      let createdAt: string | null = null;
      if (m) {
        const [, , , d, t] = m;
        const iso = new Date(
          Number(d.slice(0, 4)),
          Number(d.slice(4, 6)) - 1,
          Number(d.slice(6, 8)),
          Number(t.slice(0, 2)),
          Number(t.slice(2, 4)),
          Number(t.slice(4, 6)),
        );
        createdAt = Number.isNaN(iso.getTime()) ? null : iso.toISOString();
      }
      return {
        file,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        valid: m != null,
        trigger: (m?.[1] as BackupKind) ?? "unknown",
        createdAt,
        version,
        isNewerThanApp: version != null && version > current,
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Replace all data with the contents of a backup. Takes a safety backup first,
    upgrades the backup's schema forward if it's older, then copies every table
    into the live database in one transaction. */
export function restoreBackup(file: string): { safetyFile: string } {
  const full = resolveInside(file);
  if (!existsSync(full)) throw new Error("Backup not found");
  if (!file.endsWith(".db.gz")) {
    throw new Error("That file is not a Bouquet backup");
  }

  const tmp = join(env.backupsPath, ".tmp-restore.db");
  if (existsSync(tmp)) unlinkSync(tmp);
  try {
    writeFileSync(tmp, gunzipSync(readFileSync(full)));
  } catch {
    throw new Error("That backup could not be read");
  }

  // Validate it's a Bouquet database and read the version it was taken at.
  const backupDb = new Database(tmp);
  let backupVersion: number;
  try {
    const t = backupDb
      .prepare(
        "select count(*) as n from sqlite_master where type='table' and name='playlists'",
      )
      .get() as { n: number };
    if (!t || t.n === 0) throw new Error("not bouquet");
    backupVersion = schemaVersion(backupDb);
  } catch {
    backupDb.close();
    unlinkSync(tmp);
    throw new Error("That file is not a Bouquet backup");
  }

  const current = currentSchemaVersion();
  if (backupVersion > current) {
    backupDb.close();
    unlinkSync(tmp);
    throw new Error(
      `This backup is from a newer version of Bouquet (schema ${backupVersion}, this app is ${current}). Update the app, then restore.`,
    );
  }

  // Bring an older backup up to the current schema so the copy below lines up.
  try {
    migrate(drizzle(backupDb), { migrationsFolder: MIGRATIONS });
  } finally {
    backupDb.close();
  }

  // Reversible: snapshot the current state before we overwrite it.
  const { file: safetyFile } = createBackup("prerestore");

  const tables = (
    sqlite
      .prepare(
        "select name from sqlite_master where type='table' " +
          "and name not like 'sqlite_%' and name != '__drizzle_migrations'",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

  // FKs off for the wipe-and-copy so table order doesn't matter; back on after.
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(`ATTACH DATABASE '${sqlLiteral(tmp)}' AS restore`);
  try {
    sqlite.transaction(() => {
      for (const t of tables) sqlite.prepare(`DELETE FROM main."${t}"`).run();
      for (const t of tables) {
        sqlite.exec(`INSERT INTO main."${t}" SELECT * FROM restore."${t}"`);
      }
    })();
  } finally {
    sqlite.exec("DETACH DATABASE restore");
    sqlite.pragma("foreign_keys = ON");
  }
  unlinkSync(tmp);

  invalidateAll();
  return { safetyFile };
}

export function deleteBackup(file: string): void {
  unlinkSync(resolveInside(file));
}

/** Read a backup's raw bytes for download. Throws if it isn't in the folder. */
export function readBackup(file: string): { name: string; body: Buffer } {
  const full = resolveInside(file);
  if (!existsSync(full)) throw new Error("Backup not found");
  return { name: basename(full), body: readFileSync(full) };
}

/** Keep only the newest `keep` auto-backups. Manual, prerestore, and
    hand-dropped files are never touched. */
export function pruneAutoBackups(keep: number): void {
  if (!existsSync(env.backupsPath)) return;
  const autos = readdirSync(env.backupsPath)
    .filter((f) => /^bouquet-auto-.*\.db\.gz$/.test(f))
    .map((file) => ({
      file,
      mtime: statSync(join(env.backupsPath, file)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { file } of autos.slice(Math.max(0, keep))) {
    unlinkSync(join(env.backupsPath, file));
  }
}
