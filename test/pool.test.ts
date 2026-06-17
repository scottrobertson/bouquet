import { describe, expect, it } from "vitest";
import { mapPool } from "~/lib/pool";

/** Resolves after a tick, tracking how many calls overlap. */
function tracker() {
  let active = 0;
  let max = 0;
  return {
    get max() {
      return max;
    },
    async run<T>(value: T): Promise<T> {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return value;
    },
  };
}

describe("mapPool", () => {
  it("runs at most `limit` tasks at once", async () => {
    const t = tracker();
    await mapPool([1, 2, 3, 4, 5, 6], 2, (n) => t.run(n));
    expect(t.max).toBe(2);
  });

  it("uses a single worker when limit is 1", async () => {
    const t = tracker();
    await mapPool([1, 2, 3], 1, (n) => t.run(n));
    expect(t.max).toBe(1);
  });

  it("returns results in input order", async () => {
    const out = await mapPool([1, 2, 3, 4], 3, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it("never exceeds the item count even with a high limit", async () => {
    const t = tracker();
    await mapPool([1, 2], 10, (n) => t.run(n));
    expect(t.max).toBe(2);
  });
});
