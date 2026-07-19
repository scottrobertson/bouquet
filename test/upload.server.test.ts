import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/db/index.server";
import type { UploadDestination } from "~/db/schema";
import { playlists, uploadDestinations } from "~/db/schema";
import { buildTarget } from "~/services/upload/storage.server";
import {
  requestUploadSoon,
  uploadDestination,
  uploadRunner,
} from "~/services/upload/upload.server";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bouquet-upload-"));
}

beforeEach(() => {
  db.delete(uploadDestinations).run();
  db.delete(playlists).run();
});

describe("buildTarget", () => {
  it("writes a file through the local adapter", async () => {
    const dir = tempDir();
    const target = buildTarget({
      type: "local",
      config: { path: dir },
    } as UploadDestination);

    await target.write("nested/hello.txt", "hi there");

    expect(readFileSync(join(dir, "nested/hello.txt"), "utf8")).toBe("hi there");
  });

  it("builds an S3 target from config without throwing", () => {
    expect(() =>
      buildTarget({
        type: "s3",
        config: {
          region: "us-east-1",
          bucket: "my-bucket",
          accessKeyId: "key",
          secretAccessKey: "secret",
          endpoint: "http://localhost:9000",
          forcePathStyle: true,
        },
      } as UploadDestination),
    ).not.toThrow();
  });
});

describe("uploadDestination", () => {
  it("writes the M3U and EPG and points url-tvg at the destination's public EPG", async () => {
    const dir = tempDir();
    const playlist = db
      .insert(playlists)
      .values({ name: "Test", outputToken: "tok-upload" })
      .returning({ id: playlists.id })
      .get();

    const dest = db
      .insert(uploadDestinations)
      .values({
        playlistId: playlist.id,
        name: "Local",
        type: "local",
        config: { path: dir },
        m3uPath: "playlist.m3u",
        epgPath: "guide.xml",
        publicUrlBase: "https://cdn.example.com/iptv",
      })
      .returning({ id: uploadDestinations.id })
      .get();

    await uploadDestination(dest.id);

    const m3u = readFileSync(join(dir, "playlist.m3u"), "utf8");
    expect(m3u).toContain(
      'url-tvg="https://cdn.example.com/iptv/guide.xml"',
    );
    // The EPG lands too, as a valid XMLTV document.
    const epg = readFileSync(join(dir, "guide.xml"), "utf8");
    expect(epg).toContain("<tv");

    const row = db
      .select()
      .from(uploadDestinations)
      .where(eq(uploadDestinations.id, dest.id))
      .get()!;
    expect(row.uploadStatus).toBe("ok");
    expect(row.lastUploadedAt).not.toBeNull();
    expect(row.uploadError).toBeNull();
  });

  it("records an error and doesn't throw when the target fails", async () => {
    const playlist = db
      .insert(playlists)
      .values({ name: "Bad", outputToken: "tok-bad" })
      .returning({ id: playlists.id })
      .get();

    // Root the storage at a regular file, so writing a child path under it
    // fails fast with ENOTDIR on every OS. An unwritable dir path behaves
    // differently across platforms (macOS vs Linux /proc) and can hang.
    const notADir = join(tempDir(), "not-a-dir");
    writeFileSync(notADir, "x");
    const dest = db
      .insert(uploadDestinations)
      .values({
        playlistId: playlist.id,
        name: "Broken",
        type: "local",
        config: { path: notADir },
      })
      .returning({ id: uploadDestinations.id })
      .get();

    await expect(uploadDestination(dest.id)).resolves.toBeUndefined();

    const row = db
      .select()
      .from(uploadDestinations)
      .where(eq(uploadDestinations.id, dest.id))
      .get()!;
    expect(row.uploadStatus).toBe("error");
    expect(row.uploadError).toBeTruthy();
  });
});

describe("requestUploadSoon", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("collapses repeated calls into a single upload run", () => {
    vi.useFakeTimers();
    const run = vi.spyOn(uploadRunner, "run").mockResolvedValue(undefined);

    requestUploadSoon();
    requestUploadSoon();
    requestUploadSoon();

    vi.advanceTimersByTime(6000);

    expect(run).toHaveBeenCalledTimes(1);
  });
});
