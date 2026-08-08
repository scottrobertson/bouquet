import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import * as ffprobe from "~/services/probe/ffprobe.server";
import {
  addedProbeRunner,
  channelsToProbe,
  channelsToProbeOnAdd,
  probeAddedChannels,
  probeSingleChannel,
} from "~/services/probe/probe.server";

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

describe("channelsToProbeOnAdd", () => {
  beforeEach(() => {
    db.update(sources).set({ probeEnabled: true }).where(eq(sources.id, sourceId)).run();
  });

  it("returns channels whose source has probing on", () => {
    const one = addSourceChannel("one");
    expect(channelsToProbeOnAdd([one]).map((c) => c.streamId)).toEqual(["one"]);
  });

  it("skips channels whose source has probing off", () => {
    db.update(sources).set({ probeEnabled: false }).where(eq(sources.id, sourceId)).run();
    const one = addSourceChannel("one");
    expect(channelsToProbeOnAdd([one])).toEqual([]);
  });

  it("skips channels from a disabled source", () => {
    db.update(sources).set({ enabled: false }).where(eq(sources.id, sourceId)).run();
    const one = addSourceChannel("one");
    expect(channelsToProbeOnAdd([one])).toEqual([]);
  });

  it("skips channels that already have a probe result", () => {
    const one = addSourceChannel("one");
    db.update(sourceChannels)
      .set({ probeStatus: "ok" })
      .where(eq(sourceChannels.id, one))
      .run();
    expect(channelsToProbeOnAdd([one])).toEqual([]);
  });

  it("skips unavailable channels", () => {
    const gone = addSourceChannel("gone", { available: false });
    expect(channelsToProbeOnAdd([gone])).toEqual([]);
  });
});

describe("probeAddedChannels", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    db.update(sources).set({ probeEnabled: true }).where(eq(sources.id, sourceId)).run();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("marks the channels as waiting before the run starts", () => {
    vi.spyOn(addedProbeRunner, "run").mockReturnValue(0);
    const a = addSourceChannel("a");

    probeAddedChannels([a]);

    const row = db
      .select({ probeStatus: sourceChannels.probeStatus })
      .from(sourceChannels)
      .where(eq(sourceChannels.id, a))
      .get();
    expect(row?.probeStatus).toBe("queued");
    vi.advanceTimersByTime(10_000);
  });

  it("collects a burst of adds into one probe run", () => {
    const run = vi.spyOn(addedProbeRunner, "run").mockReturnValue(0);
    const a = addSourceChannel("a");
    const b = addSourceChannel("b");

    probeAddedChannels([a]);
    probeAddedChannels([b]);
    vi.advanceTimersByTime(10_000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].map((c) => c.streamId).sort()).toEqual(["a", "b"]);
  });

  it("does not start a run when nothing needs probing", () => {
    const run = vi.spyOn(addedProbeRunner, "run").mockReturnValue(0);
    db.update(sources).set({ probeEnabled: false }).where(eq(sources.id, sourceId)).run();

    probeAddedChannels([addSourceChannel("a")]);
    vi.advanceTimersByTime(10_000);

    expect(run).not.toHaveBeenCalled();
  });
});

describe("storing a probe result", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps no quality for a stream that failed the black screen check", async () => {
    // ffprobe reads a black stream like any other, so this is the one failure
    // that arrives with a full set of numbers attached.
    vi.spyOn(ffprobe, "probeStream").mockResolvedValue({
      status: "ok",
      width: 3840,
      height: 2160,
      fps: 50,
      videoCodec: "hevc",
      audioCodec: "eac3",
      bitrate: 20000,
      error: null,
    });
    vi.spyOn(ffprobe, "detectBlackScreen").mockResolvedValue(true);
    db.update(sources)
      .set({ probeDetectBlackScreen: true })
      .where(eq(sources.id, sourceId))
      .run();
    const id = addSourceChannel("black");

    await probeSingleChannel(id);

    const row = db.select().from(sourceChannels).where(eq(sourceChannels.id, id)).get();
    expect(row?.probeStatus).toBe("error");
    expect(row?.probeError).toBe("Black screen");
    expect(row?.probeHeight).toBeNull();
    expect(row?.probeWidth).toBeNull();
    expect(row?.probeFps).toBeNull();
    expect(row?.probeVideoCodec).toBeNull();
    expect(row?.probeAudioCodec).toBeNull();
    expect(row?.probeBitrate).toBeNull();
  });

  it("stores the quality when the probe passes", async () => {
    vi.spyOn(ffprobe, "probeStream").mockResolvedValue({
      status: "ok",
      width: 1920,
      height: 1080,
      fps: 50,
      videoCodec: "h264",
      audioCodec: "aac",
      bitrate: 8000,
      error: null,
    });
    vi.spyOn(ffprobe, "detectBlackScreen").mockResolvedValue(false);
    const id = addSourceChannel("good");

    await probeSingleChannel(id);

    const row = db.select().from(sourceChannels).where(eq(sourceChannels.id, id)).get();
    expect(row?.probeStatus).toBe("ok");
    expect(row?.probeHeight).toBe(1080);
    expect(row?.probeBitrate).toBe(8000);
  });
});
