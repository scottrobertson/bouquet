import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "~/db/index.server";
import {
  playlistCategories,
  playlistChannels,
  playlists,
  sourceChannels,
  sources,
} from "~/db/schema";
import {
  addChannels,
  bulkSort,
  makeAlternates,
  renameChannel,
} from "~/services/playlist/mutations.server";

let playlistId: number;
let categoryId: number;
let otherCategoryId: number;
let sourceId: number;

function addSourceChannel(streamId: string, name: string) {
  return db
    .insert(sourceChannels)
    .values({
      sourceId,
      streamId,
      name,
      epgChannelId: `${streamId}.epg`,
      categoryName: "UK",
      position: 0,
    })
    .returning({ id: sourceChannels.id })
    .get().id;
}

/** Display names of a category's channels in position order. */
function namesInOrder(catId: number) {
  return db
    .select({
      customName: playlistChannels.customName,
      sourceName: sourceChannels.name,
    })
    .from(playlistChannels)
    .innerJoin(
      sourceChannels,
      eq(playlistChannels.sourceChannelId, sourceChannels.id),
    )
    .where(eq(playlistChannels.categoryId, catId))
    .orderBy(asc(playlistChannels.position), asc(playlistChannels.id))
    .all()
    .map((r) => r.customName ?? r.sourceName);
}

function plId(sc: number) {
  return db
    .select({ id: playlistChannels.id })
    .from(playlistChannels)
    .where(eq(playlistChannels.sourceChannelId, sc))
    .get()!.id;
}

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
  otherCategoryId = db
    .insert(playlistCategories)
    .values({ playlistId, name: "US", position: 1 })
    .returning({ id: playlistCategories.id })
    .get().id;
});

describe("bulkSort", () => {
  it("sorts the selected channels A→Z", () => {
    const c = addSourceChannel("c", "Charlie");
    const a = addSourceChannel("a", "Alpha");
    const b = addSourceChannel("b", "Bravo");
    addChannels(playlistId, categoryId, [c, a, b]);

    bulkSort(playlistId, [plId(a), plId(b), plId(c)], "asc");

    expect(namesInOrder(categoryId)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("sorts Z→A", () => {
    const a = addSourceChannel("a", "Alpha");
    const b = addSourceChannel("b", "Bravo");
    const c = addSourceChannel("c", "Charlie");
    addChannels(playlistId, categoryId, [a, b, c]);

    bulkSort(playlistId, [plId(a), plId(b), plId(c)], "desc");

    expect(namesInOrder(categoryId)).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  it("sorts numbers naturally, not lexically", () => {
    const c2 = addSourceChannel("2", "ESPN 2");
    const c10 = addSourceChannel("10", "ESPN 10");
    const c1 = addSourceChannel("1", "ESPN 1");
    addChannels(playlistId, categoryId, [c2, c10, c1]);

    bulkSort(playlistId, [plId(c1), plId(c2), plId(c10)], "asc");

    expect(namesInOrder(categoryId)).toEqual(["ESPN 1", "ESPN 2", "ESPN 10"]);
  });

  it("only moves selected channels, leaving the rest in place", () => {
    const d = addSourceChannel("d", "Delta");
    const a = addSourceChannel("a", "Alpha");
    const c = addSourceChannel("c", "Charlie");
    const b = addSourceChannel("b", "Bravo");
    addChannels(playlistId, categoryId, [d, a, c, b]);

    // Sort only Delta and Charlie. They sit in slots 0 and 2, so those slots
    // get the sorted pair while Alpha (slot 1) and Bravo (slot 3) stay put.
    bulkSort(playlistId, [plId(d), plId(c)], "asc");

    expect(namesInOrder(categoryId)).toEqual([
      "Charlie",
      "Alpha",
      "Delta",
      "Bravo",
    ]);
  });

  it("sorts by custom name when set", () => {
    const a = addSourceChannel("a", "Alpha");
    const b = addSourceChannel("b", "Bravo");
    addChannels(playlistId, categoryId, [a, b]);
    // Rename Alpha so it sorts after Bravo.
    renameChannel(playlistId, plId(a), "Zulu");

    bulkSort(playlistId, [plId(a), plId(b)], "asc");

    expect(namesInOrder(categoryId)).toEqual(["Bravo", "Zulu"]);
  });

  it("sorts each category independently", () => {
    const ukB = addSourceChannel("ukb", "UK Bravo");
    const ukA = addSourceChannel("uka", "UK Alpha");
    addChannels(playlistId, categoryId, [ukB, ukA]);
    const usB = addSourceChannel("usb", "US Bravo");
    const usA = addSourceChannel("usa", "US Alpha");
    addChannels(playlistId, otherCategoryId, [usB, usA]);

    bulkSort(
      playlistId,
      [plId(ukB), plId(ukA), plId(usB), plId(usA)],
      "asc",
    );

    expect(namesInOrder(categoryId)).toEqual(["UK Alpha", "UK Bravo"]);
    expect(namesInOrder(otherCategoryId)).toEqual(["US Alpha", "US Bravo"]);
  });

  it("leaves alternates with their primary, not sorted on their own", () => {
    const a = addSourceChannel("a", "Alpha");
    const b = addSourceChannel("b", "Bravo");
    const c = addSourceChannel("c", "Charlie");
    addChannels(playlistId, categoryId, [a, b, c]);
    // Make Charlie an alternate of Alpha.
    makeAlternates(playlistId, plId(a), [plId(c)]);

    bulkSort(playlistId, [plId(a), plId(b), plId(c)], "desc");

    // Only the two primaries reorder. Charlie was selected too but stays put
    // because it's an alternate, so it keeps its slot below the primaries.
    expect(namesInOrder(categoryId)).toEqual(["Bravo", "Alpha", "Charlie"]);
  });
});
