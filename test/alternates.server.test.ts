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
import { buildM3u } from "~/services/output/m3u.server";
import { getPlaylistOutput } from "~/services/output/queries.server";
import {
  addChannels,
  bulkRemove,
  makeAlternates,
  promoteAlternate,
  removeChannel,
  renameChannel,
  reorderAlternates,
  setEpg,
  toggleChannel,
} from "~/services/playlist/mutations.server";

let playlistId: number;
let categoryId: number;
let sourceId: number;

/** Add a source channel and return its id. */
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

/** The playlist channel rows for the playlist, in id order. */
function playlistRows() {
  return db
    .select()
    .from(playlistChannels)
    .where(eq(playlistChannels.playlistId, playlistId))
    .all();
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
});

/** Add three channels to the category and return their playlist channel ids. */
function seedThree() {
  const a = addSourceChannel("a", "Channel A");
  const b = addSourceChannel("b", "Channel B");
  const c = addSourceChannel("c", "Channel C");
  addChannels(playlistId, categoryId, [a, b, c]);
  const rows = playlistRows();
  const bySource = (sc: number) => rows.find((r) => r.sourceChannelId === sc)!.id;
  return { pcA: bySource(a), pcB: bySource(b), pcC: bySource(c) };
}

describe("makeAlternates", () => {
  it("nests channels under a primary, inheriting EPG and clearing names", () => {
    const { pcA, pcB, pcC } = seedThree();
    setEpg(playlistId, pcA, sourceId, "bbc.epg");
    renameChannel(playlistId, pcB, "Custom B"); // should be cleared on grouping

    makeAlternates(playlistId, pcA, [pcB, pcC]);

    const rows = playlistRows();
    const b = rows.find((r) => r.id === pcB)!;
    const c = rows.find((r) => r.id === pcC)!;
    expect(b.primaryChannelId).toBe(pcA);
    expect(c.primaryChannelId).toBe(pcA);
    expect(b.altPosition).toBe(0);
    expect(c.altPosition).toBe(1);
    expect(b.epgChannelId).toBe("bbc.epg");
    expect(b.epgSourceId).toBe(sourceId);
    expect(b.customName).toBeNull();
  });

  it("refuses to nest an alternate under another alternate", () => {
    const { pcA, pcB, pcC } = seedThree();
    makeAlternates(playlistId, pcA, [pcB]);
    // pcB is now an alternate, so it can't become a primary.
    makeAlternates(playlistId, pcB, [pcC]);
    const c = playlistRows().find((r) => r.id === pcC)!;
    expect(c.primaryChannelId).toBeNull();
  });

  it("folds another channel into an existing group, appended at the end", () => {
    const d = addSourceChannel("d", "Channel D");
    addChannels(playlistId, categoryId, [d]);
    const pcD = playlistRows().find((r) => r.sourceChannelId === d)!.id;
    const { pcA, pcB, pcC } = seedThree();
    makeAlternates(playlistId, pcA, [pcB, pcC]);

    // Move standalone D into A's group.
    makeAlternates(playlistId, pcA, [pcD]);

    const rows = playlistRows();
    expect(rows.find((r) => r.id === pcD)!.primaryChannelId).toBe(pcA);
    expect(rows.find((r) => r.id === pcD)!.altPosition).toBe(2);
  });

  it("moves an alternate to another group and renumbers the old one", () => {
    const d = addSourceChannel("d", "Channel D");
    addChannels(playlistId, categoryId, [d]);
    const pcD = playlistRows().find((r) => r.sourceChannelId === d)!.id;
    const { pcA, pcB, pcC } = seedThree();
    // A has alternates B, C; D is a separate primary.
    makeAlternates(playlistId, pcA, [pcB, pcC]);

    // Move B (alt position 0 under A) to D's group.
    makeAlternates(playlistId, pcD, [pcB]);

    const rows = playlistRows();
    expect(rows.find((r) => r.id === pcB)!.primaryChannelId).toBe(pcD);
    // C was at position 1 under A; with B gone it renumbers to 0.
    expect(rows.find((r) => r.id === pcC)!.altPosition).toBe(0);
  });
});

describe("output", () => {
  it("emits primary then alternates, auto-named and adjacent", async () => {
    const { pcA, pcB, pcC } = seedThree();
    setEpg(playlistId, pcA, sourceId, "bbc.epg");
    renameChannel(playlistId, pcA, "BBC One");
    makeAlternates(playlistId, pcA, [pcB, pcC]);

    const out = await getPlaylistOutput("tok");
    const names = out!.channels.map((c) => c.displayName);
    expect(names).toEqual(["BBC One", "BBC One (Alt 1)", "BBC One (Alt 2)"]);
    // Alternates inherit the primary's guide.
    expect(out!.channels.every((c) => c.tvgId === "bbc.epg")).toBe(true);
    // Each alternate is still its own line in the M3U.
    const m3u = buildM3u(out!.channels, "http://host/epg");
    expect(m3u.match(/#EXTINF/g)?.length).toBe(3);
  });

  it("ignores attempts to rename an alternate", async () => {
    const { pcA, pcB, pcC } = seedThree();
    renameChannel(playlistId, pcA, "BBC One");
    makeAlternates(playlistId, pcA, [pcB, pcC]);
    renameChannel(playlistId, pcB, "My Backup"); // no-op for alternates

    const out = await getPlaylistOutput("tok");
    expect(out!.channels.map((c) => c.displayName)).toEqual([
      "BBC One",
      "BBC One (Alt 1)",
      "BBC One (Alt 2)",
    ]);
  });

  it("ignores a leftover custom name on an alternate", async () => {
    const { pcA, pcB, pcC } = seedThree();
    renameChannel(playlistId, pcA, "BBC One");
    makeAlternates(playlistId, pcA, [pcB, pcC]);
    // Simulate legacy data: an alternate with a stored custom name.
    db.update(playlistChannels)
      .set({ customName: "Old Backup Name" })
      .where(eq(playlistChannels.id, pcB))
      .run();

    const out = await getPlaylistOutput("tok");
    expect(out!.channels.map((c) => c.displayName)).toEqual([
      "BBC One",
      "BBC One (Alt 1)",
      "BBC One (Alt 2)",
    ]);
  });

  it("alternates always use the primary's EPG, ignoring their own", async () => {
    const { pcA, pcB, pcC } = seedThree();
    setEpg(playlistId, pcA, sourceId, "bbc.epg");
    makeAlternates(playlistId, pcA, [pcB, pcC]);
    // Changing the primary's EPG after grouping should carry to the alternates.
    setEpg(playlistId, pcA, sourceId, "bbc2.epg");
    // A divergent EPG stored on an alternate (legacy/edge) must be ignored.
    db.update(playlistChannels)
      .set({ epgChannelId: "rogue.epg" })
      .where(eq(playlistChannels.id, pcB))
      .run();

    const out = await getPlaylistOutput("tok");
    expect(out!.channels.every((c) => c.tvgId === "bbc2.epg")).toBe(true);
  });

  it("alternates always use the primary's logo, ignoring their own", async () => {
    const { pcA, pcB, pcC } = seedThree();
    db.update(playlistChannels)
      .set({ customLogo: "http://logo/primary.png" })
      .where(eq(playlistChannels.id, pcA))
      .run();
    makeAlternates(playlistId, pcA, [pcB, pcC]);
    db.update(playlistChannels)
      .set({ customLogo: "http://logo/rogue.png" })
      .where(eq(playlistChannels.id, pcB))
      .run();

    const out = await getPlaylistOutput("tok");
    expect(out!.channels.every((c) => c.logo === "http://logo/primary.png")).toBe(
      true,
    );
  });

  it("a disabled primary takes its whole group out of output", async () => {
    const { pcA, pcB, pcC } = seedThree();
    renameChannel(playlistId, pcA, "BBC One");
    makeAlternates(playlistId, pcA, [pcB, pcC]);

    toggleChannel(playlistId, pcA, false);

    const out = await getPlaylistOutput("tok");
    // Primary and both alternates are gone, so no orphaned backups.
    expect(out!.channels.map((c) => c.displayName)).toEqual([]);
  });

  it("re-enabling the primary brings back alternates in their own state", async () => {
    const { pcA, pcB, pcC } = seedThree();
    renameChannel(playlistId, pcA, "BBC One");
    makeAlternates(playlistId, pcA, [pcB, pcC]);
    // One alternate is individually off; gating must not lose that.
    toggleChannel(playlistId, pcC, false);

    toggleChannel(playlistId, pcA, false);
    expect((await getPlaylistOutput("tok"))!.channels).toHaveLength(0);

    toggleChannel(playlistId, pcA, true);
    const out = await getPlaylistOutput("tok");
    expect(out!.channels.map((c) => c.displayName)).toEqual([
      "BBC One",
      "BBC One (Alt 1)",
    ]);
  });

  it("renames every alternate when the primary is renamed", async () => {
    const { pcA, pcB, pcC } = seedThree();
    makeAlternates(playlistId, pcA, [pcB, pcC]);
    renameChannel(playlistId, pcA, "Sky One");

    const out = await getPlaylistOutput("tok");
    expect(out!.channels.map((c) => c.displayName)).toEqual([
      "Sky One",
      "Sky One (Alt 1)",
      "Sky One (Alt 2)",
    ]);
  });
});

describe("removeChannel on a primary", () => {
  it("promotes the first alternate, reverting to its own name", async () => {
    const { pcA, pcB, pcC } = seedThree();
    renameChannel(playlistId, pcA, "BBC One");
    makeAlternates(playlistId, pcA, [pcB, pcC]);

    removeChannel(playlistId, pcA);

    const rows = playlistRows();
    expect(rows.find((r) => r.id === pcA)).toBeUndefined();
    const b = rows.find((r) => r.id === pcB)!;
    const c = rows.find((r) => r.id === pcC)!;
    expect(b.primaryChannelId).toBeNull();
    expect(b.customName).toBeNull();
    expect(c.primaryChannelId).toBe(pcB);
    expect(c.altPosition).toBe(0);

    const out = await getPlaylistOutput("tok");
    expect(out!.channels.map((d) => d.displayName)).toEqual([
      "Channel B",
      "Channel B (Alt 1)",
    ]);
  });

  it("promoteAlternate reverts the new primary and re-names the rest", async () => {
    const { pcA, pcB, pcC } = seedThree();
    renameChannel(playlistId, pcA, "BBC One");
    makeAlternates(playlistId, pcA, [pcB, pcC]);

    promoteAlternate(playlistId, pcB);

    const rows = playlistRows();
    expect(rows.find((r) => r.id === pcB)!.primaryChannelId).toBeNull();
    expect(rows.find((r) => r.id === pcB)!.customName).toBeNull();
    expect(rows.find((r) => r.id === pcA)!.primaryChannelId).toBe(pcB);
    expect(rows.find((r) => r.id === pcA)!.customName).toBeNull();

    const out = await getPlaylistOutput("tok");
    expect(out!.channels.map((d) => d.displayName)).toEqual([
      "Channel B",
      "Channel B (Alt 1)",
      "Channel B (Alt 2)",
    ]);
  });

  it("deletes a whole group at once without a foreign key error", () => {
    const { pcA, pcB, pcC } = seedThree();
    makeAlternates(playlistId, pcA, [pcB, pcC]);

    bulkRemove(playlistId, [pcA, pcB, pcC]);

    expect(playlistRows()).toHaveLength(0);
  });
});

describe("reorderAlternates", () => {
  it("reorders a primary's alternates", () => {
    const { pcA, pcB, pcC } = seedThree();
    makeAlternates(playlistId, pcA, [pcB, pcC]);

    reorderAlternates(playlistId, pcA, [pcC, pcB]);

    const rows = playlistRows();
    expect(rows.find((r) => r.id === pcC)!.altPosition).toBe(0);
    expect(rows.find((r) => r.id === pcB)!.altPosition).toBe(1);
  });
});
