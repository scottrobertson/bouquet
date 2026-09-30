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
import {
  addAlternates,
  addChannels,
  bulkAddPrefix,
  bulkAddSuffix,
  bulkMove,
  bulkReplace,
  bulkResetEpg,
  bulkToggle,
  createAutoCategory,
  createCategory,
  deleteCategory,
  makeAlternates,
  renameCategory,
  renameChannel,
  reorderCategories,
  reorderChannels,
  setEpg,
  ungroupAlternate,
  ungroupPrimary,
} from "~/services/playlist/mutations.server";

let sourceId: number;
let playlistId: number;
let categoryId: number;

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

function addPlaylist(outputToken: string) {
  return db
    .insert(playlists)
    .values({ name: outputToken, outputToken })
    .returning({ id: playlists.id })
    .get().id;
}

function addCategory(pid: number, name: string, position = 0) {
  return db
    .insert(playlistCategories)
    .values({ playlistId: pid, name, position })
    .returning({ id: playlistCategories.id })
    .get().id;
}

/** Add source channels to a category and return their playlist channel ids,
    in the order given. */
function seed(catId: number, names: string[], pid = playlistId) {
  const scids = names.map((n) => addSourceChannel(n.toLowerCase(), n));
  addChannels(pid, catId, scids);
  return scids.map((sc) => channelBySource(pid, catId, sc).id);
}

function channelBySource(pid: number, catId: number, scid: number) {
  return db
    .select()
    .from(playlistChannels)
    .where(eq(playlistChannels.playlistId, pid))
    .all()
    .find((r) => r.sourceChannelId === scid && r.categoryId === catId)!;
}

function row(id: number) {
  return db
    .select()
    .from(playlistChannels)
    .where(eq(playlistChannels.id, id))
    .get();
}

function category(id: number) {
  return db
    .select()
    .from(playlistCategories)
    .where(eq(playlistCategories.id, id))
    .get();
}

/** Primary channel ids in a category, in display order. */
function order(catId: number) {
  return db
    .select()
    .from(playlistChannels)
    .where(eq(playlistChannels.categoryId, catId))
    .all()
    .filter((r) => r.primaryChannelId == null)
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map((r) => r.id);
}

async function outputNames() {
  const out = await getPlaylistOutput("tok");
  return out!.channels.map((c) => c.displayName);
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
  playlistId = addPlaylist("tok");
  categoryId = addCategory(playlistId, "UK");
});

describe("createCategory", () => {
  it("trims the name and adds it after the existing categories", () => {
    const created = createCategory(playlistId, "  Sport  ")!;
    expect(created.name).toBe("Sport");
    expect(created.position).toBe(1);
    expect(created.autoSourceId).toBeNull();
  });

  it("refuses a blank name", () => {
    expect(createCategory(playlistId, "   ")).toBeNull();
    expect(db.select().from(playlistCategories).all()).toHaveLength(1);
  });
});

describe("createAutoCategory", () => {
  it("links the new category to the source category it mirrors", async () => {
    addSourceChannel("a", "Channel A");
    const created = createAutoCategory(playlistId, sourceId, "UK", " Auto UK ")!;
    expect(created.name).toBe("Auto UK");
    expect(created.position).toBe(1);
    expect(created.autoSourceId).toBe(sourceId);
    expect(created.autoCategoryName).toBe("UK");
    expect(await outputNames()).toEqual(["Channel A"]);
  });

  it("refuses a blank name or source category", () => {
    expect(createAutoCategory(playlistId, sourceId, "UK", " ")).toBeNull();
    expect(createAutoCategory(playlistId, sourceId, " ", "Auto")).toBeNull();
    expect(db.select().from(playlistCategories).all()).toHaveLength(1);
  });
});

describe("renameCategory", () => {
  it("trims the new name", () => {
    renameCategory(playlistId, categoryId, "  News ");
    expect(category(categoryId)!.name).toBe("News");
  });

  it("ignores a blank name", () => {
    renameCategory(playlistId, categoryId, "  ");
    expect(category(categoryId)!.name).toBe("UK");
  });

  it("ignores a category from another playlist", () => {
    const other = addPlaylist("other");
    renameCategory(other, categoryId, "Hijacked");
    expect(category(categoryId)!.name).toBe("UK");
  });
});

describe("deleteCategory", () => {
  it("deletes the category with its channels, alternates included", () => {
    const [a, b, c] = seed(categoryId, ["A", "B", "C"]);
    makeAlternates(playlistId, a, [b]);

    deleteCategory(playlistId, categoryId);

    expect(category(categoryId)).toBeUndefined();
    expect(row(a)).toBeUndefined();
    expect(row(b)).toBeUndefined();
    expect(row(c)).toBeUndefined();
  });

  it("leaves other categories alone", () => {
    const sport = addCategory(playlistId, "Sport", 1);
    const [s] = seed(sport, ["S"]);
    seed(categoryId, ["A"]);

    deleteCategory(playlistId, categoryId);

    expect(row(s)).toBeDefined();
  });

  it("ignores a category from another playlist", () => {
    const other = addPlaylist("other");
    deleteCategory(other, categoryId);
    expect(category(categoryId)).toBeDefined();
  });
});

describe("reorderCategories", () => {
  it("saves the order given and skips ids from other playlists", () => {
    const sport = addCategory(playlistId, "Sport", 1);
    const news = addCategory(playlistId, "News", 2);
    const foreign = addCategory(addPlaylist("other"), "Theirs", 5);

    reorderCategories(playlistId, [news, foreign, categoryId, sport]);

    expect(category(news)!.position).toBe(0);
    expect(category(categoryId)!.position).toBe(2);
    expect(category(sport)!.position).toBe(3);
    expect(category(foreign)!.position).toBe(5);
  });
});

describe("reorderChannels", () => {
  it("moves a channel into another category at the dropped spot", () => {
    const sport = addCategory(playlistId, "Sport", 1);
    const [a, b] = seed(categoryId, ["A", "B"]);
    const [s1, s2] = seed(sport, ["S1", "S2"]);

    reorderChannels(playlistId, a, sport, {
      [categoryId]: [b],
      [sport]: [s1, a, s2],
    });

    expect(row(a)!.categoryId).toBe(sport);
    expect(order(sport)).toEqual([s1, a, s2]);
    expect(order(categoryId)).toEqual([b]);
  });

  it("brings a primary's alternates along to the new category", () => {
    const sport = addCategory(playlistId, "Sport", 1);
    const [a, b, c] = seed(categoryId, ["A", "B", "C"]);
    makeAlternates(playlistId, a, [b, c]);

    reorderChannels(playlistId, a, sport, { [sport]: [a] });

    expect(row(b)!.categoryId).toBe(sport);
    expect(row(c)!.categoryId).toBe(sport);
  });

  it("refuses to drop into an auto-sync category", () => {
    const auto = createAutoCategory(playlistId, sourceId, "UK", "Auto")!;
    const [a] = seed(categoryId, ["A"]);

    reorderChannels(playlistId, a, auto.id, { [auto.id]: [a] });

    expect(row(a)!.categoryId).toBe(categoryId);
  });

  it("leaves channels from other playlists alone", () => {
    const other = addPlaylist("other");
    const otherCat = addCategory(other, "Theirs");
    const [theirs] = seed(otherCat, ["T"], other);
    const [a, b] = seed(categoryId, ["A", "B"]);

    reorderChannels(playlistId, a, categoryId, { [categoryId]: [b, theirs, a] });

    expect(row(theirs)!.categoryId).toBe(otherCat);
    expect(row(theirs)!.position).toBe(0);
    expect(order(categoryId)).toEqual([b, a]);
  });
});

describe("bulkToggle", () => {
  it("turns channels off and clears the auto-disable marker", () => {
    const [a, b] = seed(categoryId, ["A", "B"]);
    db.update(playlistChannels)
      .set({ autoDisabledAt: new Date() })
      .where(eq(playlistChannels.id, a))
      .run();

    bulkToggle(playlistId, [a, b], false);

    expect(row(a)!.enabled).toBe(false);
    expect(row(a)!.autoDisabledAt).toBeNull();
    expect(row(b)!.enabled).toBe(false);
  });

  it("gives re-enabled streams a clean failure streak", () => {
    const [a] = seed(categoryId, ["A"]);
    bulkToggle(playlistId, [a], false);
    db.update(sourceChannels).set({ consecutiveProbeFailures: 4 }).run();

    bulkToggle(playlistId, [a], true);

    expect(row(a)!.enabled).toBe(true);
    const sc = db.select().from(sourceChannels).get()!;
    expect(sc.consecutiveProbeFailures).toBe(0);
  });

  it("ignores channels from other playlists", () => {
    const other = addPlaylist("other");
    const [theirs] = seed(addCategory(other, "Theirs"), ["T"], other);

    bulkToggle(playlistId, [theirs], false);

    expect(row(theirs)!.enabled).toBe(true);
  });
});

describe("bulkMove", () => {
  it("adds the channels to the end of the target category", () => {
    const sport = addCategory(playlistId, "Sport", 1);
    const [a, b] = seed(categoryId, ["A", "B"]);
    const [s] = seed(sport, ["S"]);

    bulkMove(playlistId, [a, b], sport);

    expect(order(sport)).toEqual([s, a, b]);
    expect(order(categoryId)).toEqual([]);
  });

  it("brings a primary's alternates along", () => {
    const sport = addCategory(playlistId, "Sport", 1);
    const [a, b] = seed(categoryId, ["A", "B"]);
    makeAlternates(playlistId, a, [b]);

    bulkMove(playlistId, [a], sport);

    expect(row(b)!.categoryId).toBe(sport);
    expect(row(b)!.primaryChannelId).toBe(a);
  });

  it("keeps an alternate with its primary when moved alone", () => {
    const sport = addCategory(playlistId, "Sport", 1);
    const [a, b] = seed(categoryId, ["A", "B"]);
    makeAlternates(playlistId, a, [b]);

    bulkMove(playlistId, [b], sport);

    expect(row(b)!.categoryId).toBe(categoryId);
  });

  it("refuses to move into an auto-sync category", () => {
    const auto = createAutoCategory(playlistId, sourceId, "UK", "Auto")!;
    const [a] = seed(categoryId, ["A"]);

    bulkMove(playlistId, [a], auto.id);

    expect(row(a)!.categoryId).toBe(categoryId);
  });
});

describe("bulk rename", () => {
  it("adds a prefix to the name shown, custom or not", () => {
    const [a, b] = seed(categoryId, ["BBC One", "BBC Two"]);
    renameChannel(playlistId, b, "Two");

    bulkAddPrefix(playlistId, [a, b], "UK: ");

    expect(row(a)!.customName).toBe("UK: BBC One");
    expect(row(b)!.customName).toBe("UK: Two");
  });

  it("adds a suffix", () => {
    const [a] = seed(categoryId, ["BBC One"]);
    bulkAddSuffix(playlistId, [a], " HD");
    expect(row(a)!.customName).toBe("BBC One HD");
  });

  it("replaces text literally, not as a pattern", () => {
    const [a] = seed(categoryId, ["Sky (UK) Sports (UK)"]);
    bulkReplace(playlistId, [a], "(UK)", "[GB]");
    expect(row(a)!.customName).toBe("Sky [GB] Sports [GB]");
  });

  it("drops the custom name once a rename lands back on the provider's name", () => {
    const [a] = seed(categoryId, ["BBC One"]);
    bulkAddSuffix(playlistId, [a], " HD");

    bulkReplace(playlistId, [a], " HD", "");

    expect(row(a)!.customName).toBeNull();
  });

  it("does nothing with an empty prefix, suffix or search", () => {
    const [a] = seed(categoryId, ["BBC One"]);
    bulkAddPrefix(playlistId, [a], "");
    bulkAddSuffix(playlistId, [a], "");
    bulkReplace(playlistId, [a], "", "x");
    expect(row(a)!.customName).toBeNull();
  });

  it("skips alternates, which are named from their primary", async () => {
    const [a, b] = seed(categoryId, ["BBC One", "BBC One Backup"]);
    makeAlternates(playlistId, a, [b]);

    bulkAddPrefix(playlistId, [a, b], "UK: ");

    expect(row(b)!.customName).toBeNull();
    expect(await outputNames()).toEqual(["UK: BBC One", "UK: BBC One (Alt 1)"]);
  });
});

describe("addAlternates", () => {
  it("adds provider channels after the group's current alternates", () => {
    const [a, b] = seed(categoryId, ["A", "B"]);
    setEpg(playlistId, a, sourceId, "group.epg");
    makeAlternates(playlistId, a, [b]);
    const x = addSourceChannel("x", "X");
    const y = addSourceChannel("y", "Y");

    const added = addAlternates(playlistId, a, [y, x]);

    expect(added).toEqual([y, x]);
    const rowY = channelBySource(playlistId, categoryId, y);
    const rowX = channelBySource(playlistId, categoryId, x);
    expect(rowY.primaryChannelId).toBe(a);
    expect(rowY.altPosition).toBe(1);
    expect(rowX.altPosition).toBe(2);
    expect(rowX.epgChannelId).toBe("group.epg");
  });

  it("skips channels already in the category", () => {
    const [a] = seed(categoryId, ["A", "B"]);
    const b = db.select().from(sourceChannels).all().find((r) => r.name === "B")!;

    expect(addAlternates(playlistId, a, [b.id])).toEqual([]);
  });

  it("refuses an alternate as the primary", () => {
    const [a, b] = seed(categoryId, ["A", "B"]);
    makeAlternates(playlistId, a, [b]);
    const x = addSourceChannel("x", "X");

    expect(addAlternates(playlistId, b, [x])).toEqual([]);
  });
});

describe("ungroupAlternate", () => {
  it("puts the alternate at the end of the category and renumbers the rest", () => {
    const [a, b, c, d] = seed(categoryId, ["A", "B", "C", "D"]);
    makeAlternates(playlistId, a, [b, c]);

    ungroupAlternate(playlistId, b);

    expect(row(b)!.primaryChannelId).toBeNull();
    expect(row(c)!.altPosition).toBe(0);
    expect(order(categoryId)).toEqual([a, d, b]);
  });

  it("does nothing to a channel that isn't an alternate", () => {
    const [a, b] = seed(categoryId, ["A", "B"]);
    ungroupAlternate(playlistId, a);
    expect(order(categoryId)).toEqual([a, b]);
  });
});

describe("ungroupPrimary", () => {
  it("turns every alternate back into its own channel at the end", async () => {
    const [a, b, c, d] = seed(categoryId, ["A", "B", "C", "D"]);
    makeAlternates(playlistId, a, [b, c]);

    ungroupPrimary(playlistId, a);

    expect(row(b)!.primaryChannelId).toBeNull();
    expect(row(c)!.primaryChannelId).toBeNull();
    const ordered = order(categoryId);
    expect(ordered.slice(0, 2)).toEqual([a, d]);
    expect(ordered.slice(2).sort()).toEqual([b, c].sort());
    expect(new Set([row(b)!.position, row(c)!.position]).size).toBe(2);
    expect(await outputNames()).toHaveLength(4);
  });
});

describe("bulkResetEpg", () => {
  it("puts each channel back on its own guide, leaving alternates alone", () => {
    const [a, b, c] = seed(categoryId, ["A", "B", "C"]);
    setEpg(playlistId, a, sourceId, "custom.epg");
    setEpg(playlistId, c, null, null);
    makeAlternates(playlistId, a, [b]);

    bulkResetEpg(playlistId, [a, b, c]);

    expect(row(a)!.epgChannelId).toBe("a.epg");
    expect(row(c)!.epgChannelId).toBe("c.epg");
    expect(row(c)!.epgSourceId).toBe(sourceId);
    // The alternate still carries the guide it got from its primary.
    expect(row(b)!.epgChannelId).toBe("custom.epg");
  });
});
