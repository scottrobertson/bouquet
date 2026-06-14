import { describe, expect, it } from "vitest";
import { isSyncDue } from "~/services/sync/sync.server";

describe("isSyncDue", () => {
  const now = Date.UTC(2024, 0, 15, 12, 0, 0);

  it("is never due when the interval is manual only (0)", () => {
    expect(isSyncDue(null, 0, now)).toBe(false);
    expect(isSyncDue(new Date(now - 999 * 86_400_000), 0, now)).toBe(false);
  });

  it("is due when it has never synced", () => {
    expect(isSyncDue(null, 1440, now)).toBe(true);
  });

  it("is due once the interval has elapsed", () => {
    const lastSynced = new Date(now - 61 * 60_000);
    expect(isSyncDue(lastSynced, 60, now)).toBe(true);
  });

  it("is not due before the interval has elapsed", () => {
    const lastSynced = new Date(now - 59 * 60_000);
    expect(isSyncDue(lastSynced, 60, now)).toBe(false);
  });

  it("is due exactly at the interval boundary", () => {
    const lastSynced = new Date(now - 60 * 60_000);
    expect(isSyncDue(lastSynced, 60, now)).toBe(true);
  });
});
