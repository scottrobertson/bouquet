/** Orders an alt group's streams best-first from probe data. "Best" is meant to
    be objective: more pixels and more frames are unambiguously better, and for a
    given codec more bitrate means less compression. Codecs differ in efficiency,
    so bitrate is normalised to a rough h264-equivalent before comparing, and the
    estimate is bucketed so measurement noise can't reorder near-identical
    streams. Audio and liveness only ever break ties. */

export type SmartSortConfig = {
  // The top quality signal. "resolution" ranks the resolution bucket first;
  // "bitrate" ranks the normalised bitrate first.
  prefer: "resolution" | "bitrate";
  // Use audio codec to break ties (surround-capable over stereo).
  audio: boolean;
  // Put working streams above never-probed, and both above dead/errored ones.
  availableFirst: boolean;
};

/** Only the fields the sort reads, so DB rows and test fixtures both fit. */
export type SmartSortStream = {
  available: boolean;
  // Whether the channel's whole source is enabled. An off source keeps the
  // channel out of output, so it can't be a sensible primary.
  sourceEnabled: boolean;
  // Set when we turned this channel off after repeated probe failures.
  autoDisabledAt: Date | null;
  probeStatus: "queued" | "probing" | "ok" | "error" | "timeout" | null;
  probeWidth: number | null;
  probeHeight: number | null;
  probeFps: number | null;
  probeVideoCodec: string | null;
  probeAudioCodec: string | null;
  probeBitrate: number | null;
};

// Newer codecs deliver the same picture at a lower bitrate, so we convert every
// bitrate to a rough h264-equivalent before comparing. Factors are ballpark and
// vary by content, which is why the result is only used in coarse buckets. This
// table is the source of truth: the lookup below and the preview's explainer
// both read it, so editing a factor updates both.
export const CODEC_EFFICIENCY_TABLE: {
  label: string;
  codecs: string[];
  factor: number;
}[] = [
  { label: "AV1", codecs: ["av1"], factor: 2 },
  { label: "HEVC / H.265 / VP9", codecs: ["h265", "hevc", "vp9"], factor: 1.7 },
  { label: "H.264", codecs: ["h264", "avc"], factor: 1 },
  { label: "MPEG-2", codecs: ["mpeg2", "mpeg2video"], factor: 0.5 },
];

const CODEC_EFFICIENCY: Record<string, number> = Object.fromEntries(
  CODEC_EFFICIENCY_TABLE.flatMap((row) =>
    row.codecs.map((c) => [c, row.factor]),
  ),
);

// Bitrate is a measured estimate, so treat anything within half a Mbps as equal.
const BITRATE_BUCKET_KBPS = 500;

// Surround-capable codecs over stereo aac over old/low ones.
const AUDIO_RANK: Record<string, number> = {
  truehd: 4,
  eac3: 3,
  ac3: 3,
  dts: 3,
  aac: 2,
  mp2: 1,
  mp3: 1,
};

function codecFactor(codec: string | null): number {
  if (!codec) return 1;
  return CODEC_EFFICIENCY[codec.toLowerCase()] ?? 1;
}

function effectiveBitrate(s: SmartSortStream): number {
  if (!s.probeBitrate || s.probeBitrate <= 0) return 0;
  const eq = s.probeBitrate * codecFactor(s.probeVideoCodec);
  return Math.round(eq / BITRATE_BUCKET_KBPS);
}

// Coarse resolution rank by height, so 1920x1080 and 1916x1080 tie.
function resolutionRank(s: SmartSortStream): number {
  const h = s.probeHeight ?? 0;
  if (h >= 4320) return 5;
  if (h >= 2160) return 4;
  if (h >= 1080) return 3;
  if (h >= 720) return 2;
  if (h > 0) return 1;
  return 0;
}

// High frame rate (50/60) reads as smoother, which matters most for sport.
function fpsRank(s: SmartSortStream): number {
  const f = s.probeFps ?? 0;
  if (f >= 48) return 2;
  if (f >= 24) return 1;
  if (f > 0) return 0.5;
  return 0;
}

function audioRank(s: SmartSortStream): number {
  if (!s.probeAudioCodec) return 0;
  return AUDIO_RANK[s.probeAudioCodec.toLowerCase()] ?? 1;
}

// Working first, then never-probed (unknown, might be fine), then a failed probe
// (we tried and it broke), then gone from the provider, then a switched-off
// source, then auto-disabled last since we already gave up on those. A
// never-probed stream sits above a failed one on purpose: no result yet beats a
// known failure. Source off sits above auto-disabled because the stream itself
// may be fine once the source comes back on.
export type Liveness =
  | "working"
  | "unprobed"
  | "failed"
  | "unavailable"
  | "sourceOff"
  | "autoDisabled";

const LIVENESS_RANK: Record<Liveness, number> = {
  working: 5,
  unprobed: 4,
  failed: 3,
  unavailable: 2,
  sourceOff: 1,
  autoDisabled: 0,
};

function liveness(s: SmartSortStream): Liveness {
  if (s.autoDisabledAt != null) return "autoDisabled";
  if (!s.sourceEnabled) return "sourceOff";
  if (!s.available) return "unavailable";
  if (s.probeStatus === "error" || s.probeStatus === "timeout") return "failed";
  if (s.probeStatus === "ok") return "working";
  return "unprobed";
}

function livenessRank(s: SmartSortStream): number {
  return LIVENESS_RANK[liveness(s)];
}

// Ordered comparison keys, all "higher is better". The first key that differs
// decides the order.
function sortKeys(s: SmartSortStream, config: SmartSortConfig): number[] {
  const keys: number[] = [];
  if (config.availableFirst) keys.push(livenessRank(s));
  const res = resolutionRank(s);
  const fps = fpsRank(s);
  const bitrate = effectiveBitrate(s);
  if (config.prefer === "bitrate") keys.push(bitrate, res, fps);
  else keys.push(res, fps, bitrate);
  if (config.audio) keys.push(audioRank(s));
  // Raw measured bitrate as a final tiebreaker, so streams that bucketed the
  // same still order by their actual numbers.
  keys.push(s.probeBitrate ?? 0);
  return keys;
}

export function compareStreams(
  a: SmartSortStream,
  b: SmartSortStream,
  config: SmartSortConfig,
): number {
  const ka = sortKeys(a, config);
  const kb = sortKeys(b, config);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return kb[i] - ka[i];
  }
  return 0;
}

/** Best-first copy of the streams. Ties keep their input order (stable sort). */
export function smartSort<T extends SmartSortStream>(
  streams: T[],
  config: SmartSortConfig,
): T[] {
  return [...streams].sort((a, b) => compareStreams(a, b, config));
}

/** Whether smart sort would change this group. Pass the members in the order
    they're in now, primary first. Lets the editor flag groups worth sorting
    without opening the preview on each one. */
export function needsSmartSort(
  members: SmartSortStream[],
  config: SmartSortConfig,
): boolean {
  if (members.length < 2) return false;
  const sorted = smartSort(members, config);
  return sorted.some((s, i) => s !== members[i]);
}

/** The values that fed the sort, in display-ready form, so the preview can show
    why a stream ranks where it does. */
export type SmartSortFactors = {
  liveness: Liveness;
  resolutionRank: number;
  fpsRank: number;
  rawBitrateKbps: number | null;
  // h264-equivalent bitrate, un-bucketed. Differs from raw only when the codec
  // got an efficiency credit.
  normalisedBitrateKbps: number | null;
  audioRank: number;
  codecAdjusted: boolean;
};

export function factorsFor(s: SmartSortStream): SmartSortFactors {
  const factor = codecFactor(s.probeVideoCodec);
  const raw = s.probeBitrate && s.probeBitrate > 0 ? s.probeBitrate : null;
  return {
    liveness: liveness(s),
    resolutionRank: resolutionRank(s),
    fpsRank: fpsRank(s),
    rawBitrateKbps: raw,
    normalisedBitrateKbps: raw != null ? Math.round(raw * factor) : null,
    audioRank: audioRank(s),
    codecAdjusted: factor !== 1 && raw != null,
  };
}

/** Best-first, each stream annotated with the factors that ranked it. Same order
    as smartSort, so the preview matches what applying will do. */
export function explainSmartSort<T extends SmartSortStream>(
  streams: T[],
  config: SmartSortConfig,
): Array<T & { factors: SmartSortFactors }> {
  return smartSort(streams, config).map((s) => ({ ...s, factors: factorsFor(s) }));
}
