import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "~/db/index.server";
import {
  playlistCategories,
  playlistChannels,
  playlists,
  sourceCategories,
  sourceChannels,
  sources,
} from "~/db/schema";
import { addChannels } from "~/services/playlist/mutations.server";
import { channelsToProbe } from "~/services/probe/probe.server";

let sourceId: number;
let playlistId: number;
let categoryId: number;

function addSourceChannel(
  streamId: string,
  opts: { categoryName?: string | null; available?: boolean } = {},
) {
  return db
    .insert(sourceChannels)
    .values({
      sourceId,
      streamId,
      name: `Channel ${streamId}`,
      categoryName: opts.categoryName ?? "UK",
      available: opts.available ?? true,
      position: 0,
    })
    .returning({ id: sourceChannels.id })
    .get().id;
}

beforeEach(() => {
  db.delete(playlistChannels).run();
  db.delete(playlistCategories).run();
  db.delete(playlists).run();
  db.delete(sourceCategories).run();
  db.delete(sourceChannels).run();
  db.delete(sources).run();

  sourceId = db
    .insert(sources)
    .values({ name: "Main", serverUrl: "http://s", username: "u", password: "p" })
    .returning({ id: sources.id })
    .get().id;
  playlistId = db
    .insert(playlists)
    .values({ name: "PL", outputToken: "tok" })
    .returning({ id: playlists.id })
    .get().id;
  categoryId = db
    .insert(playlistCategories)
    .values({ playlistId, name: "UK", position: 0 })
    .returning({ id: playlistCategories.id })
    .get().id;
});

describe("channelsToProbe", () => {
  it("returns only channels used in a playlist", () => {
    const used = addSourceChannel("used");
    addSourceChannel("unused"); // never added to a playlist
    addChannels(playlistId, categoryId, [used]);

    const result = channelsToProbe(sourceId);
    expect(result.map((c) => c.streamId)).toEqual(["used"]);
  });

  it("dedupes a channel that appears in two playlists", () => {
    const used = addSourceChannel("used");
    addChannels(playlistId, categoryId, [used]);

    const pl2 = db
      .insert(playlists)
      .values({ name: "PL2", outputToken: "tok2" })
      .returning({ id: playlists.id })
      .get().id;
    const cat2 = db
      .insert(playlistCategories)
      .values({ playlistId: pl2, name: "UK", position: 0 })
      .returning({ id: playlistCategories.id })
      .get().id;
    addChannels(pl2, cat2, [used]);

    expect(channelsToProbe(sourceId)).toHaveLength(1);
  });

  it("skips unavailable channels and disabled playlist channels", () => {
    const gone = addSourceChannel("gone", { available: false });
    const off = addSourceChannel("off");
    addChannels(playlistId, categoryId, [gone, off]);
    db.update(playlistChannels)
      .set({ enabled: false })
      .where(eq(playlistChannels.sourceChannelId, off))
      .run();

    expect(channelsToProbe(sourceId)).toEqual([]);
  });

  it("includes auto-disabled channels so they can recover", () => {
    const dead = addSourceChannel("dead");
    addChannels(playlistId, categoryId, [dead]);
    db.update(playlistChannels)
      .set({ enabled: false, autoDisabledAt: new Date() })
      .where(eq(playlistChannels.sourceChannelId, dead))
      .run();

    expect(channelsToProbe(sourceId).map((c) => c.streamId)).toEqual(["dead"]);
  });

  it("skips channels in a disabled source category", () => {
    const used = addSourceChannel("used", { categoryName: "Adult" });
    addChannels(playlistId, categoryId, [used]);
    db.insert(sourceCategories)
      .values({ sourceId, name: "Adult", enabled: false })
      .run();

    expect(channelsToProbe(sourceId)).toEqual([]);
  });
});
