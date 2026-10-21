import { describe, expect, it } from "vitest";
import {
  factorsFor,
  needsSmartSort,
  smartSort,
  type SmartSortConfig,
  type SmartSortStream,
} from "~/lib/smart-sort";

// The editor runs this sort in the browser to flag groups worth sorting, and
// the server runs its own copy to apply it. These cases match the server's
// tests in server/src/smart_sort.rs, so the two can't drift apart.

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

  it("keeps raw bitrate as the final tiebreaker when audio is off", () => {
    const order = smartSort(tnt, { ...DEFAULT, audio: false }).map((s) => s.name);
    expect(order.indexOf("primary")).toBeLessThan(order.indexOf("alt5"));
  });

  it("normalises HEVC bitrate so it isn't punished for needing fewer bits", () => {
    const pair = [
      stream("hevc", 1080, 50, "hevc", "aac", 5),
      stream("h264", 1080, 50, "h264", "aac", 7),
    ];
    expect(smartSort(pair, DEFAULT)[0].name).toBe("hevc");
  });

  it("ranks resolution first by default, bitrate first on request", () => {
    const pair = [
      stream("hd", 720, 50, "h264", "aac", 12),
      stream("fhd", 1080, 50, "h264", "aac", 6),
    ];
    expect(smartSort(pair, DEFAULT)[0].name).toBe("fhd");
    expect(smartSort(pair, { ...DEFAULT, prefer: "bitrate" })[0].name).toBe("hd");
  });

  it("orders working over unprobed over failed over unavailable over auto-disabled over source-off", () => {
    const list = [
      stream("sourceOff", 1080, 50, "h264", "aac", 10, { sourceEnabled: false }),
      stream("autoDisabled", 1080, 50, "h264", "aac", 10, {
        autoDisabledAt: "2026-01-01T00:00:00.000Z",
      }),
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
      "autoDisabled",
      "sourceOff",
    ]);
  });

  it("ignores leftover numbers on a stream whose last probe didn't pass", () => {
    const list = [
      stream("plain", 1080, 50, "h264", "aac", 6, { probeStatus: null }),
      stream("stale4k", 2160, 50, "hevc", "eac3", 20, { probeStatus: "queued" }),
    ];
    expect(smartSort(list, DEFAULT).map((s) => s.name)).toEqual(["plain", "stale4k"]);
    expect(needsSmartSort(list, DEFAULT)).toBe(false);
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

  it("only flags a dead primary while availableFirst is on", () => {
    const list = [
      stream("primary", 1080, 50, "h264", "aac", 6, { available: false }),
      stream("alt1", 1080, 50, "h264", "aac", 6),
    ];
    expect(needsSmartSort(list, DEFAULT)).toBe(true);
    expect(needsSmartSort(list, { ...DEFAULT, availableFirst: false })).toBe(false);
  });

  it("is false for a channel with no alternates", () => {
    expect(needsSmartSort([stream("solo", 1080, 50, "h264", "aac", 6)], DEFAULT)).toBe(false);
  });
});

describe("factorsFor", () => {
  it("reports the normalised bitrate for an efficient codec", () => {
    const f = factorsFor(stream("x", 1080, 50, "hevc", "aac", 4));
    expect(f.codecAdjusted).toBe(true);
    expect(f.rawBitrateKbps).toBe(4000);
    expect(f.normalisedBitrateKbps).toBe(6800);
  });

  it("reports no bitrate for a stream whose last probe didn't pass", () => {
    const f = factorsFor(stream("x", 1080, 50, "h264", "aac", 8, { probeStatus: "queued" }));
    expect(f.rawBitrateKbps).toBeNull();
    expect(f.resolutionRank).toBe(0);
  });
});
