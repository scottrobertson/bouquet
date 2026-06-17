// Wrapper around the ffprobe binary. We run it against a stream URL and read
// back the first video/audio stream so we can show channel quality.
import { spawn } from "node:child_process";
import { env } from "~/lib/env.server";

// ffmpeg 7 added a security check that rejects HLS segments with unusual
// extensions, which breaks probing m3u8 streams from providers that redirect to
// odd segment URLs. The -extension_picky 0 flag turns it off, but the flag only
// exists from 7 onwards, so detect the major version once and only pass it then.
let ffprobeMajorPromise: Promise<number> | null = null;
function ffprobeMajorVersion(): Promise<number> {
  if (!ffprobeMajorPromise) {
    ffprobeMajorPromise = new Promise((resolve) => {
      const child = spawn(env.ffprobePath, ["-hide_banner", "-version"]);
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("error", () => resolve(0));
      child.on("close", () => {
        const m = out.match(/version\s+n?(\d+)\./i);
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }
  return ffprobeMajorPromise;
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
    segment-extension check on versions that have it. */
export async function probeStream(
  url: string,
  timeoutSeconds: number,
  opts: { hls?: boolean } = {},
): Promise<ProbeResult> {
  const relaxHls = opts.hls && (await ffprobeMajorVersion()) >= 7;
  const args = [
    "-v",
    "error",
    ...(relaxHls ? ["-extension_picky", "0"] : []),
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
  return (async () => {
    const relaxHls = opts.hls && (await ffprobeMajorVersion()) >= 7;
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      ...(relaxHls ? ["-extension_picky", "0"] : []),
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
  })();
}
