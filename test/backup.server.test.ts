import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "~/db/index.server";
import { playlists, sources } from "~/db/schema";
import { env } from "~/lib/env.server";
import {
  createBackup,
  listBackups,
  restoreBackup,
} from "~/services/backup/backup.server";

function source() {
  db.insert(sources)
    .values({ name: "Main", serverUrl: "http://s", username: "u", password: "p" })
    .run();
}

beforeEach(() => {
  db.delete(playlists).run();
  db.delete(sources).run();
  if (existsSync(env.backupsPath)) {
    for (const f of readdirSync(env.backupsPath)) rmSync(join(env.backupsPath, f));
  }
});

describe("backup", () => {
  it("restores the whole database from a snapshot", () => {
    source();
    db.insert(playlists).values({ name: "Keep me", outputToken: "tok-keep" }).run();

    const { file, version } = createBackup("manual");
    expect(version).toBeGreaterThan(0);
    expect(existsSync(join(env.backupsPath, file))).toBe(true);

    // Change everything after the backup.
    db.delete(playlists).run();
    db.insert(playlists).values({ name: "Different", outputToken: "tok-diff" }).run();

    restoreBackup(file);

    expect(db.select({ n: playlists.name }).from(playlists).all().map((p) => p.n)).toEqual([
      "Keep me",
    ]);
    expect(db.select().from(sources).all()).toHaveLength(1);
  });

  it("lists a created backup as valid with its version", () => {
    source();
    const { file, version } = createBackup("manual");
    const info = listBackups().find((b) => b.file === file)!;
    expect(info.valid).toBe(true);
    expect(info.trigger).toBe("manual");
    expect(info.version).toBe(version);
    expect(info.isNewerThanApp).toBe(false);
  });

  it("refuses to restore a backup from a newer schema", () => {
    source();
    const { file } = createBackup("manual");

    // Forge a backup whose schema is one migration ahead of this app.
    const plain = gunzipSync(readFileSync(join(env.backupsPath, file)));
    const forgePath = join(env.backupsPath, "forge.db");
    writeFileSync(forgePath, plain);
    const fdb = new Database(forgePath);
    fdb.prepare(
      "insert into __drizzle_migrations (hash, created_at) values (?, ?)",
    ).run("forged", 1);
    fdb.close();
    const newer = "bouquet-manual-v999-20990101-000000.db.gz";
    writeFileSync(join(env.backupsPath, newer), gzipSync(readFileSync(forgePath)));

    expect(() => restoreBackup(newer)).toThrow(/newer version/i);
  });
});
