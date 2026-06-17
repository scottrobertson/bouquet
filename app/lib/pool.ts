/** Run `fn` over `items` with at most `limit` in flight at once. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, limit), items.length) },
      () => worker(),
    ),
  );
  return out;
}

/** Has this source's interval elapsed since it last ran? A 0 interval means
    manual only, so it's never due from the scheduler. */
export function isIntervalDue(
  lastAt: Date | null,
  intervalMinutes: number,
  now: number,
): boolean {
  if (intervalMinutes <= 0) return false;
  if (!lastAt) return true;
  return now - lastAt.getTime() >= intervalMinutes * 60_000;
}
