// Shared geometry for the guide grid. Pure functions so the time-to-pixel math
// stays testable and consistent across the axis, rows, and now line.

export const PX_PER_MIN = 6; // 360px per hour
export const PX_PER_MS = PX_PER_MIN / 60_000;
export const ROW_H = 56;
export const CHANNEL_COL_W = 440;
export const HEADER_H = 36;
export const MIN_BLOCK_W = 28;
export const HALF_HOUR_MS = 30 * 60_000;

export function xForMs(ms: number, startMs: number): number {
  return (ms - startMs) * PX_PER_MS;
}

export function widthForMs(startMs: number, stopMs: number): number {
  return (stopMs - startMs) * PX_PER_MS;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// Half-hour tick times spanning [startMs, endMs], aligned to :00 and :30.
export function halfHourTicks(startMs: number, endMs: number): number[] {
  const first = Math.ceil(startMs / HALF_HOUR_MS) * HALF_HOUR_MS;
  const ticks: number[] = [];
  for (let t = first; t <= endMs; t += HALF_HOUR_MS) ticks.push(t);
  return ticks;
}
