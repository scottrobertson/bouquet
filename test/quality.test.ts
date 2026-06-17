import { describe, expect, it } from "vitest";
import { qualityMeta, qualityParts, resolutionLabel, resolutionTier } from "~/lib/quality";

describe("resolutionLabel", () => {
  it("shortens common heights", () => {
    expect(resolutionLabel(1920, 1080)).toBe("1080");
    expect(resolutionLabel(3840, 2160)).toBe("4K");
    expect(resolutionLabel(7680, 4320)).toBe("8K");
  });
  it("returns null when nothing is known", () => {
    expect(resolutionLabel(null, null)).toBe(null);
  });
});

describe("resolutionTier", () => {
  it("maps height to a tier", () => {
    expect(resolutionTier(2160)).toBe("uhd");
    expect(resolutionTier(1080)).toBe("fhd");
    expect(resolutionTier(720)).toBe("hd");
    expect(resolutionTier(576)).toBe("sd");
    expect(resolutionTier(null)).toBe(null);
  });
});

describe("qualityParts", () => {
  const ok = {
    probeStatus: "ok" as const,
    probeWidth: 1920,
    probeHeight: 1080,
    probeFps: 50,
    probeVideoCodec: "h264",
    probeAudioCodec: "aac",
    probeBitrate: 8200,
  };

  it("builds an ordered summary", () => {
    expect(qualityParts(ok)).toEqual(["1080", "50fps", "h264", "aac", "8.2 Mbps"]);
  });

  it("is empty when the probe did not succeed", () => {
    expect(qualityParts({ ...ok, probeStatus: "error" })).toEqual([]);
  });
});

describe("qualityMeta", () => {
  const ok = {
    probeStatus: "ok" as const,
    probeWidth: 1920,
    probeHeight: 1080,
    probeFps: 50,
    probeVideoCodec: "h264",
    probeAudioCodec: "aac",
    probeBitrate: 8200,
  };

  it("splits resolution, details and bitrate", () => {
    expect(qualityMeta(ok)).toEqual({
      resolution: { label: "1080", tier: "fhd" },
      details: ["50fps", "h264", "aac"],
      bitrate: "8.2 Mbps",
    });
  });

  it("shows kbps under 1 Mbps", () => {
    expect(qualityMeta({ ...ok, probeBitrate: 850 })?.bitrate).toBe("850 kbps");
  });

  it("is null when the probe did not succeed", () => {
    expect(qualityMeta({ ...ok, probeStatus: "error" })).toBe(null);
    expect(qualityMeta({ ...ok, probeStatus: null })).toBe(null);
  });
});
