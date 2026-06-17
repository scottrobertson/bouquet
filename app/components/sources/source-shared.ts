import { z } from "zod";

// How often the scheduler auto-syncs a source. 0 means manual only.
export const SYNC_INTERVAL_OPTIONS = [
  { value: 60, label: "Every hour" },
  { value: 360, label: "Every 6 hours" },
  { value: 720, label: "Every 12 hours" },
  { value: 1440, label: "Daily" },
  { value: 0, label: "Manual only" },
] as const;

const SYNC_INTERVAL_VALUES = SYNC_INTERVAL_OPTIONS.map((o) => o.value);

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

const PROBE_INTERVAL_VALUES = PROBE_INTERVAL_OPTIONS.map((o) => o.value);

/** How long ffprobe reads each stream before giving up. */
export const PROBE_TIMEOUT_OPTIONS = [
  { value: 5, label: "5 seconds" },
  { value: 10, label: "10 seconds" },
  { value: 20, label: "20 seconds" },
  { value: 30, label: "30 seconds" },
] as const;

const PROBE_TIMEOUT_VALUES = PROBE_TIMEOUT_OPTIONS.map((o) => o.value);

export function probeIntervalLabel(minutes: number): string {
  return (
    PROBE_INTERVAL_OPTIONS.find((o) => o.value === minutes)?.label ?? "Daily"
  );
}

export const sourceSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  serverUrl: z.string().trim().min(1, "Server URL is required").url("Enter a valid URL"),
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  outputFormat: z.enum(["ts", "m3u8"]).catch("ts"),
  // Checkbox: "on" when ticked, absent otherwise.
  autoImportGroups: z.preprocess((v) => v === "on" || v === true, z.boolean()),
  // One of the preset intervals; anything else falls back to daily.
  syncIntervalMinutes: z.coerce
    .number()
    .refine((n) => SYNC_INTERVAL_VALUES.includes(n as never))
    .catch(1440),
  probeEnabled: z.preprocess((v) => v === "on" || v === true, z.boolean()),
  // At least 1. The provider's connection limit is the practical ceiling; we
  // don't enforce it, but cap at 20 to avoid silly values.
  probeConcurrency: z.coerce.number().int().min(1).max(20).catch(1),
  probeIntervalMinutes: z.coerce
    .number()
    .refine((n) => PROBE_INTERVAL_VALUES.includes(n as never))
    .catch(1440),
  probeTimeoutSeconds: z.coerce
    .number()
    .refine((n) => PROBE_TIMEOUT_VALUES.includes(n as never))
    .catch(10),
  probeMeasureBitrate: z.preprocess((v) => v === "on" || v === true, z.boolean()),
});

export type SourceInput = z.infer<typeof sourceSchema>;

/** Parse a source form's fields. Shared by the new and edit routes so they
    always read the same set of fields. */
export function parseSourceForm(form: FormData) {
  return sourceSchema.safeParse({
    name: form.get("name"),
    serverUrl: form.get("serverUrl"),
    username: form.get("username"),
    password: form.get("password"),
    outputFormat: form.get("outputFormat"),
    autoImportGroups: form.get("autoImportGroups"),
    syncIntervalMinutes: form.get("syncIntervalMinutes"),
    probeEnabled: form.get("probeEnabled"),
    probeConcurrency: form.get("probeConcurrency"),
    probeIntervalMinutes: form.get("probeIntervalMinutes"),
    probeTimeoutSeconds: form.get("probeTimeoutSeconds"),
    probeMeasureBitrate: form.get("probeMeasureBitrate"),
  });
}

/** Pull just the host (and port) out of a server URL for compact display. */
export function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
