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
import { browserChannels } from "~/services/playlist/queries.server";

let playlistId: number;
let categoryId: number;
let sourceId: number;

function addSourceChannel(streamId: string, name: string, categoryName = "UK") {
  return db
    .insert(sourceChannels)
    .values({
      sourceId,
      streamId,
      name,
      epgChannelId: `${streamId}.epg`,
      categoryName,
      position: 0,
    })
    .returning({ id: sourceChannels.id })
    .get().id;
}

beforeEach(() => {
  db.delete(playlistChannels).run();
  db.delete(playlistCategories).run();
  db.delete(playlists).run();
  db.delete(sourceChannels).run();
  db.delete(sourceCategories).run();
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
});

describe("browserChannels alreadyAdded", () => {
  it("is zero when nothing matching is in the playlist", () => {
    addSourceChannel("a", "BBC One");
    addSourceChannel("b", "BBC Two");

    const res = browserChannels({ q: "BBC", excludePlaylistId: playlistId });
    expect(res.total).toBe(2);
    expect(res.alreadyAdded).toBe(0);
  });

  it("counts the matches the browser hides because the playlist has them", () => {
    const one = addSourceChannel("a", "BBC One");
    addSourceChannel("b", "BBC Two");
    addChannels(playlistId, categoryId, [one]);

    const res = browserChannels({ q: "BBC", excludePlaylistId: playlistId });
    expect(res.rows.map((r) => r.name)).toEqual(["BBC Two"]);
    expect(res.total).toBe(1);
    expect(res.alreadyAdded).toBe(1);
  });

  it("counts channels covered by an auto-sync category too", () => {
    addSourceChannel("a", "BBC One", "News");
    addSourceChannel("b", "BBC Two", "News");
    db.insert(playlistCategories)
      .values({
        playlistId,
        name: "Mirrored",
        position: 1,
        autoSourceId: sourceId,
        autoCategoryName: "News",
      })
      .run();

    const res = browserChannels({ q: "BBC", excludePlaylistId: playlistId });
    expect(res.total).toBe(0);
    expect(res.alreadyAdded).toBe(2);
  });

  it("only counts channels the filter matches", () => {
    const one = addSourceChannel("a", "BBC One");
    const sky = addSourceChannel("b", "Sky Sports");
    addChannels(playlistId, categoryId, [one, sky]);

    const res = browserChannels({ q: "BBC", excludePlaylistId: playlistId });
    expect(res.alreadyAdded).toBe(1);
  });

  it("stays zero when there is no playlist to exclude", () => {
    const one = addSourceChannel("a", "BBC One");
    addChannels(playlistId, categoryId, [one]);

    const res = browserChannels({ q: "BBC" });
    expect(res.total).toBe(1);
    expect(res.alreadyAdded).toBe(0);
  });
});
