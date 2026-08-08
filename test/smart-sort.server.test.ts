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
import {
  addChannels,
  makeAlternates,
  renameChannel,
  setEpg,
  smartSortGroup,
} from "~/services/playlist/mutations.server";
import { getAltGroupStreams } from "~/services/playlist/queries.server";
import {
  factorsFor,
  needsSmartSort,
  smartSort,
  type SmartSortConfig,
  type SmartSortStream,
} from "~/services/playlist/smart-sort";

const DEFAULT: SmartSortConfig = {
  prefer: "resolution",
  audio: true,
  availableFirst: true,
};

/** A probed stream fixture. Bitrate is kbps, like the DB. */
function stream(
  name: string,
  height: number,
  fps: number,
  vcodec: string,
  acodec: string,
  bitrateMbps: number,
  extra: Partial<SmartSortStream> = {},
): SmartSortStream & { name: string } {
  return {
    name,
    available: true,
    sourceEnabled: true,
    autoDisabledAt: null,
    probeStatus: "ok",
    probeWidth: Math.round((height * 16) / 9),
    probeHeight: height,
    probeFps: fps,
    probeVideoCodec: vcodec,
    probeAudioCodec: acodec,
    probeBitrate: Math.round(bitrateMbps * 1000),
    ...extra,
  };
}

describe("smartSort scoring", () => {
  // The TNT Sports group from the design discussion: all 1080/50, so codec,
  // bitrate and audio decide it.
  const tnt = [
    stream("primary", 1080, 50, "h264", "aac", 7.5),
    stream("alt1", 1080, 50, "h264", "eac3", 9.9),
    stream("alt2", 1080, 50, "h264", "aac", 6.2),
    stream("alt3", 1080, 50, "hevc", "aac", 2.7),
    stream("alt4", 1080, 50, "h264", "aac", 6.9),
    stream("alt5", 1080, 50, "h264", "eac3", 7.4),
  ];

  it("orders the TNT group best-first", () => {
    const order = smartSort(tnt, DEFAULT).map((s) => s.name);
    expect(order).toEqual(["alt1", "alt5", "primary", "alt4", "alt2", "alt3"]);
  });

  it("treats a sub-bucket bitrate gap as a tie and lets audio break it", () => {
    // primary 7.5 and alt5 7.4 bucket the same, so eac3 puts alt5 ahead.
    const order = smartSort(tnt, DEFAULT).map((s) => s.name);
    expect(order.indexOf("alt5")).toBeLessThan(order.indexOf("primary"));
  });

  it("keeps raw bitrate as the final tiebreaker when audio is off", () => {
    const order = smartSort(tnt, { ...DEFAULT, audio: false }).map((s) => s.name);
    // Without audio, 7.5 edges 7.4, so the primary goes back above alt5.
    expect(order.indexOf("primary")).toBeLessThan(order.indexOf("alt5"));
  });

  it("normalises HEVC bitrate so it isn't punished for needing fewer bits", () => {
    const pair = [
      stream("hevc", 1080, 50, "hevc", "aac", 5),
      stream("h264", 1080, 50, "h264", "aac", 7),
    ];
    // 5 Mbps HEVC ≈ 8.5 Mbps h264, so it beats the 7 Mbps h264 stream.
    expect(smartSort(pair, DEFAULT)[0].name).toBe("hevc");
  });

  it("ranks higher resolution first by default", () => {
    const pair = [
      stream("hd", 720, 50, "h264", "aac", 12),
      stream("fhd", 1080, 50, "h264", "aac", 6),
    ];
    expect(smartSort(pair, DEFAULT)[0].name).toBe("fhd");
  });

  it("can rank by bitrate first instead", () => {
    const pair = [
      stream("hd", 720, 50, "h264", "aac", 12),
      stream("fhd", 1080, 50, "h264", "aac", 6),
    ];
    expect(smartSort(pair, { ...DEFAULT, prefer: "bitrate" })[0].name).toBe("hd");
  });

  it("sinks dead and errored streams below working ones", () => {
    const list = [
      stream("dead", 1080, 50, "h264", "aac", 10, { available: false }),
      stream("errored", 1080, 50, "h264", "aac", 9, { probeStatus: "error" }),
      stream("working", 720, 30, "h264", "aac", 3),
    ];
    expect(smartSort(list, DEFAULT)[0].name).toBe("working");
  });

  it("orders working over unprobed over failed over unavailable over source-off over auto-disabled", () => {
    const list = [
      stream("autoDisabled", 1080, 50, "h264", "aac", 10, {
        autoDisabledAt: new Date(0),
      }),
      stream("sourceOff", 1080, 50, "h264", "aac", 10, { sourceEnabled: false }),
      stream("unavailable", 1080, 50, "h264", "aac", 10, { available: false }),
      stream("failed", 1080, 50, "h264", "aac", 10, { probeStatus: "timeout" }),
      stream("unprobed", 1080, 50, "h264", "aac", 10, { probeStatus: null }),
      stream("working", 720, 30, "h264", "aac", 2),
    ];
    expect(smartSort(list, DEFAULT).map((s) => s.name)).toEqual([
      "working",
      "unprobed",
      "failed",
      "unavailable",
      "sourceOff",
      "autoDisabled",
    ]);
  });

  it("sinks an auto-disabled stream below a plain failed one", () => {
    // Both failed their probe, but we already gave up on the auto-disabled one.
    const list = [
      stream("autoDisabled", 1080, 50, "h264", "aac", 10, {
        probeStatus: "error",
        autoDisabledAt: new Date(0),
      }),
      stream("failed", 1080, 50, "h264", "aac", 10, { probeStatus: "error" }),
    ];
    expect(smartSort(list, DEFAULT).map((s) => s.name)).toEqual([
      "failed",
      "autoDisabled",
    ]);
  });

  it("keeps a working stream on top even if availableFirst is off, when it wins on quality", () => {
    const list = [
      stream("dead", 720, 30, "h264", "aac", 3, { available: false }),
      stream("working", 1080, 50, "h264", "eac3", 9),
    ];
    expect(smartSort(list, { ...DEFAULT, availableFirst: false })[0].name).toBe(
      "working",
    );
  });
});

describe("needsSmartSort", () => {
  it("is false when the group is already best-first", () => {
    const list = [
      stream("primary", 1080, 50, "h264", "eac3", 9),
      stream("alt1", 1080, 50, "h264", "aac", 6),
      stream("alt2", 720, 25, "h264", "aac", 3),
    ];
    expect(needsSmartSort(list, DEFAULT)).toBe(false);
  });

  it("is true when a better stream sits below the primary", () => {
    const list = [
      stream("primary", 720, 25, "h264", "aac", 3),
      stream("alt1", 1080, 50, "h264", "eac3", 9),
    ];
    expect(needsSmartSort(list, DEFAULT)).toBe(true);
  });

  it("is true when only the alternates below the primary are out of order", () => {
    const list = [
      stream("primary", 1080, 50, "h264", "eac3", 9),
      stream("alt1", 720, 25, "h264", "aac", 3),
      stream("alt2", 1080, 25, "h264", "aac", 5),
    ];
    expect(needsSmartSort(list, DEFAULT)).toBe(true);
  });

  it("is false when nothing has been probed, so the editor stays quiet", () => {
    const unprobed = (name: string): SmartSortStream & { name: string } => ({
      name,
      available: true,
      sourceEnabled: true,
      autoDisabledAt: null,
      probeStatus: null,
      probeWidth: null,
      probeHeight: null,
      probeFps: null,
      probeVideoCodec: null,
      probeAudioCodec: null,
      probeBitrate: null,
    });
    expect(
      needsSmartSort([unprobed("primary"), unprobed("alt1")], DEFAULT),
    ).toBe(false);
  });

  it("only flags a dead primary while availableFirst is on", () => {
    // Same quality on both, so liveness is the only thing that could reorder it.
    const list = [
      stream("primary", 1080, 50, "h264", "aac", 6, { available: false }),
      stream("alt1", 1080, 50, "h264", "aac", 6),
    ];
    expect(needsSmartSort(list, DEFAULT)).toBe(true);
    expect(needsSmartSort(list, { ...DEFAULT, availableFirst: false })).toBe(
      false,
    );
  });

  it("is false for a channel with no alternates", () => {
    expect(needsSmartSort([stream("solo", 1080, 50, "h264", "aac", 6)], DEFAULT)).toBe(
      false,
    );
  });
});

describe("factorsFor (preview breakdown)", () => {
  it("reports the normalised bitrate for an efficient codec", () => {
    const f = factorsFor(stream("x", 1080, 50, "hevc", "aac", 4));
    expect(f.codecAdjusted).toBe(true);
    expect(f.rawBitrateKbps).toBe(4000);
    expect(f.normalisedBitrateKbps).toBe(6800); // 4000 * 1.7
  });

  it("leaves h264 bitrate unadjusted", () => {
    const f = factorsFor(stream("x", 1080, 50, "h264", "aac", 8));
    expect(f.codecAdjusted).toBe(false);
    expect(f.normalisedBitrateKbps).toBe(8000);
  });

  it("labels liveness", () => {
    expect(factorsFor(stream("a", 1080, 50, "h264", "aac", 8)).liveness).toBe(
      "working",
    );
    expect(
      factorsFor(stream("b", 1080, 50, "h264", "aac", 8, { available: false }))
        .liveness,
    ).toBe("unavailable");
    expect(
      factorsFor(stream("c", 1080, 50, "h264", "aac", 8, { probeStatus: null }))
        .liveness,
    ).toBe("unprobed");
    expect(
      factorsFor(stream("d", 1080, 50, "h264", "aac", 8, { probeStatus: "error" }))
        .liveness,
    ).toBe("failed");
    expect(
      factorsFor(
        stream("e", 1080, 50, "h264", "aac", 8, {
          probeStatus: "error",
          autoDisabledAt: new Date(0),
        }),
      ).liveness,
    ).toBe("autoDisabled");
    expect(
      factorsFor(stream("f", 1080, 50, "h264", "aac", 8, { sourceEnabled: false }))
        .liveness,
    ).toBe("sourceOff");
  });
});

describe("smartSortGroup mutation", () => {
  let playlistId: number;
  let categoryId: number;
  let sourceId: number;

  function addSourceChannel(
    streamId: string,
    name: string,
    probe: Partial<typeof sourceChannels.$inferInsert>,
  ) {
    return db
      .insert(sourceChannels)
      .values({
        sourceId,
        streamId,
        name,
        epgChannelId: `${streamId}.epg`,
        categoryName: "UK",
        position: 0,
        probeStatus: "ok",
        ...probe,
      })
      .returning({ id: sourceChannels.id })
      .get().id;
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

  const DB_CONFIG: SmartSortConfig = DEFAULT;

  it("promotes the best stream and keeps the group's name and guide", () => {
    // The primary is a mediocre stream; one alternate is clearly better.
    const a = addSourceChannel("a", "Primary", {
      probeHeight: 1080,
      probeFps: 50,
      probeVideoCodec: "h264",
      probeAudioCodec: "aac",
      probeBitrate: 6000,
    });
    const b = addSourceChannel("b", "Backup", {
      probeHeight: 1080,
      probeFps: 50,
      probeVideoCodec: "h264",
      probeAudioCodec: "eac3",
      probeBitrate: 12000,
    });
    addChannels(playlistId, categoryId, [a, b]);
    const rows = db
      .select()
      .from(playlistChannels)
      .where(eq(playlistChannels.playlistId, playlistId))
      .all();
    const pcA = rows.find((r) => r.sourceChannelId === a)!.id;
    const pcB = rows.find((r) => r.sourceChannelId === b)!.id;

    renameChannel(playlistId, pcA, "Sky Sports");
    setEpg(playlistId, pcA, sourceId, "custom.epg");
    makeAlternates(playlistId, pcA, [pcB]);

    smartSortGroup(playlistId, pcA, DB_CONFIG);

    const after = db
      .select()
      .from(playlistChannels)
      .where(eq(playlistChannels.playlistId, playlistId))
      .all();
    const newPrimary = after.find((r) => r.primaryChannelId == null)!;
    // The better stream (b) is now the primary.
    expect(newPrimary.id).toBe(pcB);
    // The group's name and guide carried over, so output doesn't shift.
    expect(newPrimary.customName).toBe("Sky Sports");
    expect(newPrimary.epgChannelId).toBe("custom.epg");
    // The old primary is now its alternate, auto-named.
    const oldPrimary = after.find((r) => r.id === pcA)!;
    expect(oldPrimary.primaryChannelId).toBe(pcB);
    expect(oldPrimary.altPosition).toBe(0);
    expect(oldPrimary.customName).toBeNull();
  });

  it("just reorders alternates when the primary is already best", () => {
    const a = addSourceChannel("a", "Primary", {
      probeHeight: 1080,
      probeFps: 50,
      probeVideoCodec: "h264",
      probeAudioCodec: "eac3",
      probeBitrate: 12000,
    });
    const b = addSourceChannel("b", "Mid", {
      probeHeight: 1080,
      probeFps: 50,
      probeVideoCodec: "h264",
      probeAudioCodec: "aac",
      probeBitrate: 5000,
    });
    const c = addSourceChannel("c", "Good", {
      probeHeight: 1080,
      probeFps: 50,
      probeVideoCodec: "h264",
      probeAudioCodec: "aac",
      probeBitrate: 8000,
    });
    addChannels(playlistId, categoryId, [a, b, c]);
    const rows = db
      .select()
      .from(playlistChannels)
      .where(eq(playlistChannels.playlistId, playlistId))
      .all();
    const id = (sc: number) => rows.find((r) => r.sourceChannelId === sc)!.id;
    makeAlternates(playlistId, id(a), [id(b), id(c)]);

    smartSortGroup(playlistId, id(a), DB_CONFIG);

    const after = db
      .select()
      .from(playlistChannels)
      .where(eq(playlistChannels.playlistId, playlistId))
      .all();
    // Primary unchanged, alternates reordered so the higher-bitrate one (c) wins.
    expect(after.find((r) => r.primaryChannelId == null)!.id).toBe(id(a));
    expect(after.find((r) => r.id === id(c))!.altPosition).toBe(0);
    expect(after.find((r) => r.id === id(b))!.altPosition).toBe(1);
  });

  it("sinks an auto-disabled alternate to the bottom of the group", () => {
    const a = addSourceChannel("a", "Primary", {
      probeHeight: 1080,
      probeFps: 50,
      probeVideoCodec: "h264",
      probeAudioCodec: "aac",
      probeBitrate: 6000,
    });
    // A great stream on paper, but we auto-disabled it after it kept failing.
    const b = addSourceChannel("b", "Auto off", {
      probeStatus: "error",
      probeHeight: 2160,
      probeFps: 50,
      probeVideoCodec: "hevc",
      probeAudioCodec: "eac3",
      probeBitrate: 20000,
    });
    addChannels(playlistId, categoryId, [a, b]);
    const rows = db
      .select()
      .from(playlistChannels)
      .where(eq(playlistChannels.playlistId, playlistId))
      .all();
    const id = (sc: number) => rows.find((r) => r.sourceChannelId === sc)!.id;
    makeAlternates(playlistId, id(a), [id(b)]);
    db.update(playlistChannels)
      .set({ enabled: false, autoDisabledAt: new Date(0) })
      .where(eq(playlistChannels.id, id(b)))
      .run();

    smartSortGroup(playlistId, id(a), DB_CONFIG);

    const after = db
      .select()
      .from(playlistChannels)
      .where(eq(playlistChannels.playlistId, playlistId))
      .all();
    // The auto-disabled stream stays an alternate despite its better quality.
    expect(after.find((r) => r.primaryChannelId == null)!.id).toBe(id(a));
    expect(after.find((r) => r.id === id(b))!.altPosition).toBe(0);
  });

  it("keeps a stream from a switched-off source out of the primary slot", () => {
    const a = addSourceChannel("a", "Primary", {
      probeHeight: 1080,
      probeFps: 50,
      probeVideoCodec: "h264",
      probeAudioCodec: "aac",
      probeBitrate: 6000,
    });
    // A better stream, but its whole source is disabled so it can't be output.
    const offSourceId = db
      .insert(sources)
      .values({
        name: "Off",
        serverUrl: "http://s2",
        streamBaseUrl: "http://s2",
        username: "u",
        password: "p",
        enabled: false,
      })
      .returning({ id: sources.id })
      .get().id;
    const b = db
      .insert(sourceChannels)
      .values({
        sourceId: offSourceId,
        streamId: "b",
        name: "Better",
        epgChannelId: "b.epg",
        categoryName: "UK",
        position: 0,
        probeStatus: "ok",
        probeHeight: 2160,
        probeFps: 50,
        probeVideoCodec: "hevc",
        probeAudioCodec: "eac3",
        probeBitrate: 20000,
      })
      .returning({ id: sourceChannels.id })
      .get().id;
    addChannels(playlistId, categoryId, [a, b]);
    const rows = db
      .select()
      .from(playlistChannels)
      .where(eq(playlistChannels.playlistId, playlistId))
      .all();
    const id = (sc: number) => rows.find((r) => r.sourceChannelId === sc)!.id;
    makeAlternates(playlistId, id(a), [id(b)]);

    smartSortGroup(playlistId, id(a), DB_CONFIG);

    const after = db
      .select()
      .from(playlistChannels)
      .where(eq(playlistChannels.playlistId, playlistId))
      .all();
    expect(after.find((r) => r.primaryChannelId == null)!.id).toBe(id(a));
    expect(after.find((r) => r.id === id(b))!.altPosition).toBe(0);
  });

  it("getAltGroupStreams returns the primary first, then alternates in order", () => {
    const a = addSourceChannel("a", "Primary", {});
    const b = addSourceChannel("b", "Alt 1", {});
    const c = addSourceChannel("c", "Alt 2", {});
    addChannels(playlistId, categoryId, [a, b, c]);
    const rows = db
      .select()
      .from(playlistChannels)
      .where(eq(playlistChannels.playlistId, playlistId))
      .all();
    const id = (sc: number) => rows.find((r) => r.sourceChannelId === sc)!.id;
    makeAlternates(playlistId, id(a), [id(b), id(c)]);

    const group = getAltGroupStreams(playlistId, id(a));
    expect(group.map((g) => g.id)).toEqual([id(a), id(b), id(c)]);
    expect(group[0].primaryChannelId).toBeNull();
  });
});
