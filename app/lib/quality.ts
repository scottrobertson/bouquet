export interface ProbeQuality {
  probeStatus: "queued" | "probing" | "ok" | "error" | "timeout" | null;
  probeWidth: number | null;
  probeHeight: number | null;
  probeFps: number | null;
  probeVideoCodec: string | null;
  probeAudioCodec: string | null;
  probeBitrate: number | null;
}

export type ResolutionTier = "uhd" | "fhd" | "hd" | "sd";

/** Short resolution label by height, e.g. "4K", "1080", "720". */
export function resolutionLabel(
  width: number | null,
  height: number | null,
): string | null {
  if (height && height > 0) {
    if (height >= 4320) return "8K";
    if (height >= 2160) return "4K";
    return String(height);
  }
  if (width && width > 0) return `${width}w`;
  return null;
}

/** Quality tier from height, used to colour the resolution badge. */
export function resolutionTier(height: number | null): ResolutionTier | null {
  if (!height || height <= 0) return null;
  if (height >= 2160) return "uhd";
  if (height >= 1080) return "fhd";
  if (height >= 720) return "hd";
  return "sd";
}

/** Frame rate label, trimming a trailing ".0" so 25.0 reads as "25fps". */
function fpsLabel(fps: number | null): string | null {
  if (!fps || fps <= 0) return null;
  const rounded = Math.round(fps * 100) / 100;
  return `${rounded}fps`;
}

/** Bitrate label in kbps/Mbps, e.g. "850 kbps" or "8.2 Mbps". */
function bitrateLabel(kbps: number | null): string | null {
  if (!kbps || kbps <= 0) return null;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${kbps} kbps`;
}

/** Flat quality summary, in display order. Used for log lines. Empty when the
    probe didn't succeed. */
export function qualityParts(q: ProbeQuality): string[] {
  if (q.probeStatus !== "ok") return [];
  return [
    resolutionLabel(q.probeWidth, q.probeHeight),
    fpsLabel(q.probeFps),
    q.probeVideoCodec,
    q.probeAudioCodec,
    bitrateLabel(q.probeBitrate),
  ].filter((p): p is string => !!p);
}

export interface QualityMeta {
  // The resolution badge, with its tier for colouring.
  resolution: { label: string; tier: ResolutionTier | null } | null;
  // fps and codecs, shown muted.
  details: string[];
  // Highlighted since it's the real quality signal.
  bitrate: string | null;
}

/** Structured quality for the editor row, so each piece can be styled. Null when
    there's nothing useful to show. */
export function qualityMeta(q: ProbeQuality): QualityMeta | null {
  if (q.probeStatus !== "ok") return null;
  const label = resolutionLabel(q.probeWidth, q.probeHeight);
  const details = [fpsLabel(q.probeFps), q.probeVideoCodec, q.probeAudioCodec].filter(
    (p): p is string => !!p,
  );
  const bitrate = bitrateLabel(q.probeBitrate);
  if (!label && details.length === 0 && !bitrate) return null;
  return {
    resolution: label ? { label, tier: resolutionTier(q.probeHeight) } : null,
    details,
    bitrate,
  };
}
