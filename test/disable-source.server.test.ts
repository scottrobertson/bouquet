import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "~/db/index.server";
import {
  playlistCategories,
  playlistChannels,
  playlists,
  sourceChannels,
  sources,
} from "~/db/schema";
import { getPlaylistOutput } from "~/services/output/queries.server";
import { addChannels } from "~/services/playlist/mutations.server";

let playlistId: number;
let categoryId: number;
let sourceId: number;

beforeEach(() => {
  db.delete(playlistChannels).run();
  db.delete(playlistCategories).run();
  db.delete(playlists).run();
  db.delete(sourceChannels).run();
  db.delete(sources).run();

  sourceId = db
    .insert(sources)
    .values({
      name: "Main",
      serverUrl: "http://s",
      streamBaseUrl: "http://s",
      username: "u",
      password: "p",
    })
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

  const channelId = db
    .insert(sourceChannels)
    .values({
      sourceId,
      streamId: "a",
      name: "Channel A",
      categoryName: "UK",
      position: 0,
    })
    .returning({ id: sourceChannels.id })
    .get().id;
  addChannels(playlistId, categoryId, [channelId]);
});

const setEnabled = (enabled: boolean) =>
  db.update(sources).set({ enabled }).where(eq(sources.id, sourceId)).run();

describe("disabling a source", () => {
  it("drops its channels from output but keeps them when re-enabled", async () => {
    const before = (await getPlaylistOutput("tok"))!.channels;
    expect(before.map((c) => c.displayName)).toEqual(["Channel A"]);

    setEnabled(false);
    expect((await getPlaylistOutput("tok"))!.channels).toEqual([]);

    // The playlist channel rows are untouched, so re-enabling restores output.
    expect(
      db.select().from(playlistChannels).where(eq(playlistChannels.playlistId, playlistId)).all(),
    ).toHaveLength(1);

    setEnabled(true);
    expect((await getPlaylistOutput("tok"))!.channels.map((c) => c.displayName)).toEqual([
      "Channel A",
    ]);
  });
});
