import { describe, expect, it } from "vitest";
import {
  bitrateKbps,
  parseBlackdetect,
  parseFfprobe,
} from "~/services/probe/ffprobe.server";

describe("parseFfprobe", () => {
  it("reads resolution, fps and codecs from a video+audio stream", () => {
    const json = {
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          avg_frame_rate: "50/1",
        },
        { codec_type: "audio", codec_name: "aac" },
      ],
      format: { bit_rate: "8200000" },
    };
    expect(parseFfprobe(json)).toEqual({
      width: 1920,
      height: 1080,
      fps: 50,
      videoCodec: "h264",
      audioCodec: "aac",
      bitrate: 8200,
    });
  });

  it("handles fractional frame rates", () => {
    const json = {
      streams: [
        {
          codec_type: "video",
          codec_name: "hevc",
          width: 1280,
          height: 720,
          avg_frame_rate: "30000/1001",
        },
      ],
    };
    expect(parseFfprobe(json).fps).toBe(29.97);
  });

  it("falls back to r_frame_rate when avg is unusable", () => {
    const json = {
      streams: [
        {
          codec_type: "video",
          width: 720,
          height: 576,
          avg_frame_rate: "0/0",
          r_frame_rate: "25/1",
        },
      ],
    };
    expect(parseFfprobe(json).fps).toBe(25);
  });

  it("returns nulls for audio-only or garbage input", () => {
    expect(parseFfprobe({ streams: [{ codec_type: "audio", codec_name: "mp3" }] })).toEqual({
      width: null,
      height: null,
      fps: null,
      videoCodec: null,
      audioCodec: "mp3",
      bitrate: null,
    });
    expect(parseFfprobe(null).width).toBe(null);
    expect(parseFfprobe({}).videoCodec).toBe(null);
  });
});

describe("parseBlackdetect", () => {
  // A run that was black almost the whole window.
  const allBlack = [
    "[blackdetect @ 0x1] black_start:0 black_end:9.8 black_duration:9.8",
    "frame=  250 fps= 25 q=-0.0 size=N/A time=00:00:10.00 bitrate=N/A speed=1x",
  ].join("\n");

  it("flags a stream that's black for nearly the whole window", () => {
    expect(parseBlackdetect(allBlack, 10)).toBe(true);
  });

  it("ignores a brief black blip on an otherwise normal stream", () => {
    const blip = [
      "[blackdetect @ 0x1] black_start:2 black_end:2.6 black_duration:0.6",
      "frame=  250 fps= 25 q=-0.0 size=N/A time=00:00:10.00 bitrate=N/A speed=1x",
    ].join("\n");
    expect(parseBlackdetect(blip, 10)).toBe(false);
  });

  it("stays false when no black was detected", () => {
    const clean = "frame=  250 fps= 25 q=-0.0 size=N/A time=00:00:10.00 bitrate=N/A speed=1x";
    expect(parseBlackdetect(clean, 10)).toBe(false);
  });

  it("stays false when too little decoded to judge", () => {
    const stalled = "[blackdetect @ 0x1] black_start:0 black_end:0.4 black_duration:0.4";
    expect(parseBlackdetect(stalled, 10)).toBe(false);
  });

  it("sums multiple black runs across the window", () => {
    const runs = [
      "[blackdetect @ 0x1] black_start:0 black_end:5 black_duration:5",
      "[blackdetect @ 0x1] black_start:5.2 black_end:10 black_duration:4.5",
      "frame=  250 fps= 25 q=-0.0 size=N/A time=00:00:10.00 bitrate=N/A speed=1x",
    ].join("\n");
    expect(parseBlackdetect(runs, 10)).toBe(true);
  });
});

describe("bitrateKbps", () => {
  it("converts bytes over a window to kbps", () => {
    // 5.5 MB over 6s ≈ 7.4 Mbps
    expect(bitrateKbps(5_538_104, 6)).toBe(7384);
  });

  it("returns null for no data or zero window", () => {
    expect(bitrateKbps(0, 6)).toBe(null);
    expect(bitrateKbps(1000, 0)).toBe(null);
  });
});
