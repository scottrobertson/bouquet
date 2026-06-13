import { z } from "zod";

export const sourceSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  serverUrl: z.string().trim().min(1, "Server URL is required").url("Enter a valid URL"),
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

export type SourceInput = z.infer<typeof sourceSchema>;

/** Pull just the host (and port) out of a server URL for compact display. */
export function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
