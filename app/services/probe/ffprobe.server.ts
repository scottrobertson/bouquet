// Wrapper around the ffprobe binary. We run it against a stream URL and read
// back the first video/audio stream so we can show channel quality.
import { spawn } from "node:child_process";
import { env } from "~/lib/env.server";

// ffmpeg 7+ rejects HLS segments with unusual or missing extensions, which
// breaks probing m3u8 streams from providers that redirect to odd segment URLs.
// -extension_picky 0 turns that check off. We pin ffmpeg 8 (static build in
// Docker), so the flag is always available.
function hlsRelaxArgs(hls: boolean | undefined): string[] {
  return hls ? ["-extension_picky", "0"] : [];
}

export interface ProbeResult {
  status: "ok" | "error" | "timeout";
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  // Overall stream bitrate in kbps, when the provider reports it.
  bitrate: number | null;
  error: string | null;
}

const EMPTY: Omit<ProbeResult, "status" | "error"> = {
  width: null,
  height: null,
  fps: null,
  videoCodec: null,
  audioCodec: null,
  bitrate: null,
};

// Frame rate comes back as a fraction like "50/1" or "30000/1001".
function parseFrameRate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [num, den] = value.split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  if (fps <= 0) return null;
  // Round to one decimal so 29.97 stays 29.97 but 25.0 reads as 25.
  return Math.round(fps * 100) / 100;
}

function toInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** Turn ffprobe's JSON into the fields we store. Pure so it's unit-testable
    without spawning a process. */
export function parseFfprobe(json: unknown): Omit<ProbeResult, "status" | "error"> {
  const streams = (json as any)?.streams;
  if (!Array.isArray(streams)) return { ...EMPTY };

  const video = streams.find((s: any) => s?.codec_type === "video");
  const audio = streams.find((s: any) => s?.codec_type === "audio");

  // Prefer avg_frame_rate, fall back to r_frame_rate.
  const fps =
    parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate);

  const bitrateBps = toInt((json as any)?.format?.bit_rate);

  return {
    width: toInt(video?.width),
    height: toInt(video?.height),
    fps,
    videoCodec: typeof video?.codec_name === "string" ? video.codec_name : null,
    audioCodec: typeof audio?.codec_name === "string" ? audio.codec_name : null,
    bitrate: bitrateBps != null ? Math.round(bitrateBps / 1000) : null,
  };
}

/** Run ffprobe against a stream URL, killing it after timeoutSeconds so a stuck
    stream never hangs a worker. Set hls for m3u8 streams so we relax ffmpeg's
    segment-extension check. */
export function probeStream(
  url: string,
  timeoutSeconds: number,
  opts: { hls?: boolean } = {},
): Promise<ProbeResult> {
  const args = [
    "-v",
    "error",
    ...hlsRelaxArgs(opts.hls),
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    url,
  ];

  return new Promise((resolve) => {
    const child = spawn(env.ffprobePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1, timeoutSeconds) * 1000);

    function finish(result: ProbeResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });

    // ffprobe missing or not executable.
    child.on("error", (err) => {
      finish({ ...EMPTY, status: "error", error: err.message });
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish({ ...EMPTY, status: "timeout", error: "Probe timed out" });
        return;
      }
      if (code !== 0) {
        const msg = stderr.trim().split("\n").pop() || `ffprobe exited ${code}`;
        finish({ ...EMPTY, status: "error", error: msg });
        return;
      }
      try {
        const parsed = parseFfprobe(JSON.parse(stdout));
        // A stream with no video track isn't a usable channel result.
        if (parsed.width == null && parsed.height == null) {
          finish({ ...parsed, status: "error", error: "No video stream found" });
          return;
        }
        finish({ ...parsed, status: "ok", error: null });
      } catch {
        finish({ ...EMPTY, status: "error", error: "Could not parse ffprobe output" });
      }
    });
  });
}

// A stream counts as black when near-black frames cover this much of what we
// actually decoded. High so brief fades or ad breaks don't trip it.
const BLACK_FRACTION = 0.9;

// Read a HH:MM:SS.ss timestamp into seconds.
function parseTimestamp(value: string): number {
  const [h, m, s] = value.split(":").map(Number);
  if (![h, m, s].every(Number.isFinite)) return 0;
  return h * 3600 + m * 60 + s;
}

/** Decide if blackdetect's output means the picture was all black. Sums every
    black run it logged and weighs it against how much we actually decoded (the
    last `time=` ffmpeg printed). Stays false if too little decoded, so a stream
    that stalls early is inconclusive rather than failed. Pure so it's testable
    without spawning ffmpeg. */
export function parseBlackdetect(stderr: string, window: number): boolean {
  let blackSeconds = 0;
  for (const m of stderr.matchAll(/black_duration:([\d.]+)/g)) {
    blackSeconds += Number(m[1]) || 0;
  }

  let decodedSeconds = 0;
  for (const m of stderr.matchAll(/time=(\d+:\d+:\d+\.\d+)/g)) {
    decodedSeconds = Math.max(decodedSeconds, parseTimestamp(m[1]));
  }

  // Need a meaningful chunk decoded before we trust the result.
  if (decodedSeconds < Math.min(1, window)) return false;
  return blackSeconds / decodedSeconds >= BLACK_FRACTION;
}

/** Read a stream for `seconds` with ffmpeg's blackdetect filter and return
    whether the picture is all black. Decodes video (audio dropped), so it's
    slower than a plain probe. Returns false on any error, so an inconclusive
    run never fails a channel. */
export function detectBlackScreen(
  url: string,
  seconds: number,
  opts: { hls?: boolean } = {},
): Promise<boolean> {
  const window = Math.max(1, seconds);
  const args = [
    "-hide_banner",
    ...hlsRelaxArgs(opts.hls),
    "-t",
    String(window),
    "-i",
    url,
    "-an",
    "-vf",
    "blackdetect=d=0.1",
    "-f",
    "null",
    "-",
  ];

  return new Promise<boolean>((resolve) => {
    const child = spawn(env.ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;

    // Hard stop in case -t doesn't end it, a little past the window so a healthy
    // stream finishes on its own first.
    const timer = setTimeout(() => child.kill("SIGKILL"), (window + 5) * 1000);
    function finish(v: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    }

    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () => finish(false));
    child.on("close", () => finish(parseBlackdetect(stderr, window)));
  });
}

/** kbps from bytes read over a window. Pure so it's unit-testable. */
export function bitrateKbps(bytes: number, seconds: number): number | null {
  if (bytes <= 0 || seconds <= 0) return null;
  return Math.round((bytes * 8) / seconds / 1000);
}

/** Measure a stream's real bitrate by reading it for `seconds` with ffmpeg and
    weighing the bytes. ffprobe can't give this for live streams (it reports
    N/A), so this is the only way to know the actual data rate. Returns kbps, or
    null if nothing came through. */
export function measureBitrate(
  url: string,
  seconds: number,
  opts: { hls?: boolean } = {},
): Promise<number | null> {
  const window = Math.max(1, seconds);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...hlsRelaxArgs(opts.hls),
    "-t",
    String(window),
    "-i",
    url,
    "-c",
    "copy",
    "-f",
    "mpegts",
    "pipe:1",
  ];

  return new Promise<number | null>((resolve) => {
    const child = spawn(env.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bytes = 0;
    let settled = false;

    // Hard stop in case -t doesn't end it (stuck stream). A little past the
    // window so a healthy stream finishes on its own first.
    const timer = setTimeout(() => child.kill("SIGKILL"), (window + 5) * 1000);
    function finish(v: number | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    }

    child.stdout.on("data", (d) => (bytes += d.length));
    child.stderr.on("data", () => {});
    child.on("error", () => finish(null));
    child.on("close", () => finish(bitrateKbps(bytes, window)));
  });
}
