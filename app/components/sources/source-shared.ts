// How often the scheduler auto-syncs a source. 0 means manual only.
export const SYNC_INTERVAL_OPTIONS = [
  { value: 60, label: "Every hour" },
  { value: 360, label: "Every 6 hours" },
  { value: 720, label: "Every 12 hours" },
  { value: 1440, label: "Daily" },
  { value: 0, label: "Manual only" },
] as const;

/** Human label for a stored interval, e.g. "Daily" or "Manual only". */
export function syncIntervalLabel(minutes: number): string {
  return SYNC_INTERVAL_OPTIONS.find((o) => o.value === minutes)?.label ?? "Daily";
}

// How often the scheduler auto-probes a source. Quality rarely changes, so the
// intervals are longer than sync's. 0 means manual only.
export const PROBE_INTERVAL_OPTIONS = [
  { value: 1440, label: "Daily" },
  { value: 4320, label: "Every 3 days" },
  { value: 10080, label: "Weekly" },
  { value: 0, label: "Manual only" },
] as const;

/** How long ffprobe reads each stream before giving up. */
export const PROBE_TIMEOUT_OPTIONS = [
  { value: 5, label: "5 seconds" },
  { value: 10, label: "10 seconds" },
  { value: 20, label: "20 seconds" },
  { value: 30, label: "30 seconds" },
] as const;

export function probeIntervalLabel(minutes: number): string {
  return (
    PROBE_INTERVAL_OPTIONS.find((o) => o.value === minutes)?.label ?? "Daily"
  );
}

/** Account expiry as a short date like "12 Jul 2026". "Never" when the provider
    sets no expiry, "Unknown" before the first sync reads it. `expired` is true
    once the date has passed, so the UI can flag it. */
export function expiryLabel(date: Date | string | null | undefined): {
  text: string;
  expired: boolean;
} {
  if (date === undefined) return { text: "Unknown", expired: false };
  if (date === null) return { text: "Never", expired: false };
  const d = typeof date === "string" ? new Date(date) : date;
  return {
    text: d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
    expired: d.getTime() < Date.now(),
  };
}

/** Short relative time like "2h ago". Falls back to the date for old stuff. */
export function relativeTime(date: Date | string | null): string {
  if (!date) return "Never";
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "Just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}
