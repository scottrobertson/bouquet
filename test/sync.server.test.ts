import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "~/db/index.server";
import {
  playlistCategories,
  playlistChannels,
  playlists,
  sourceChannels,
  sources,
} from "~/db/schema";
import { addChannels } from "~/services/playlist/mutations.server";
import { isSyncDue, pruneUnavailableChannels } from "~/services/sync/sync.server";

describe("isSyncDue", () => {
  const now = Date.UTC(2024, 0, 15, 12, 0, 0);

  it("is never due when the interval is manual only (0)", () => {
    expect(isSyncDue(null, 0, now)).toBe(false);
    expect(isSyncDue(new Date(now - 999 * 86_400_000), 0, now)).toBe(false);
  });

  it("is due when it has never synced", () => {
    expect(isSyncDue(null, 1440, now)).toBe(true);
  });

  it("is due once the interval has elapsed", () => {
    const lastSynced = new Date(now - 61 * 60_000);
    expect(isSyncDue(lastSynced, 60, now)).toBe(true);
  });

  it("is not due before the interval has elapsed", () => {
    const lastSynced = new Date(now - 59 * 60_000);
    expect(isSyncDue(lastSynced, 60, now)).toBe(false);
  });

  it("is due exactly at the interval boundary", () => {
    const lastSynced = new Date(now - 60 * 60_000);
    expect(isSyncDue(lastSynced, 60, now)).toBe(true);
  });
});

describe("pruneUnavailableChannels", () => {
  let sourceId: number;
  let otherSourceId: number;

  function addSourceChannel(
    srcId: number,
    streamId: string,
    name: string,
    available: boolean,
  ) {
    return db
      .insert(sourceChannels)
      .values({
        sourceId: srcId,
        streamId,
        name,
        categoryName: "UK",
        position: 0,
        available,
      })
      .returning({ id: sourceChannels.id })
      .get().id;
  }

  function channelIds(srcId: number) {
    return db
      .select({ id: sourceChannels.id })
      .from(sourceChannels)
      .where(eq(sourceChannels.sourceId, srcId))
      .all()
      .map((r) => r.id);
  }

  beforeEach(() => {
    db.delete(playlistChannels).run();
    db.delete(playlistCategories).run();
    db.delete(playlists).run();
    db.delete(sourceChannels).run();
    db.delete(sources).run();

    sourceId = db
      .insert(sources)
      .values({ name: "Main", serverUrl: "http://s", username: "u", password: "p" })
      .returning({ id: sources.id })
      .get().id;
    otherSourceId = db
      .insert(sources)
      .values({ name: "Other", serverUrl: "http://o", username: "u", password: "p" })
      .returning({ id: sources.id })
      .get().id;
  });

  it("deletes unavailable channels that no playlist uses", () => {
    const dead = addSourceChannel(sourceId, "a", "Dead", false);
    const alive = addSourceChannel(sourceId, "b", "Alive", true);

    expect(pruneUnavailableChannels(sourceId)).toBe(1);
    expect(channelIds(sourceId)).toEqual([alive]);
    expect(channelIds(sourceId)).not.toContain(dead);
  });

  it("keeps an unavailable channel that a playlist uses", () => {
    const dead = addSourceChannel(sourceId, "a", "Dead but added", false);
    const playlistId = db
      .insert(playlists)
      .values({ name: "PL", outputToken: "tok" })
      .returning({ id: playlists.id })
      .get().id;
    const categoryId = db
      .insert(playlistCategories)
      .values({ playlistId, name: "UK", position: 0 })
      .returning({ id: playlistCategories.id })
      .get().id;
    addChannels(playlistId, categoryId, [dead]);

    expect(pruneUnavailableChannels(sourceId)).toBe(0);
    expect(channelIds(sourceId)).toEqual([dead]);
  });

  it("only touches the given source", () => {
    addSourceChannel(sourceId, "a", "Dead", false);
    const otherDead = addSourceChannel(otherSourceId, "a", "Other dead", false);

    expect(pruneUnavailableChannels(sourceId)).toBe(1);
    expect(channelIds(otherSourceId)).toEqual([otherDead]);
  });
});
