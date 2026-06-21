import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "~/db/index.server";
import {
  playlistCategories,
  playlistChannels,
  playlists,
  sourceChannels,
  sources,
} from "~/db/schema";
import {
  addChannels,
  autoDisableFailedChannels,
  makeAlternates,
  reviveRecoveredChannels,
  toggleChannel,
} from "~/services/playlist/mutations.server";

let playlistId: number;
let categoryId: number;
let sourceId: number;

function addSourceChannel(
  streamId: string,
  name: string,
  probe: { status?: "ok" | "error" | "timeout" | null; failures?: number } = {},
) {
  return db
    .insert(sourceChannels)
    .values({
      sourceId,
      streamId,
      name,
      categoryName: "UK",
      position: 0,
      probeStatus: probe.status ?? null,
      consecutiveProbeFailures: probe.failures ?? 0,
    })
    .returning({ id: sourceChannels.id })
    .get().id;
}

function pcRow(id: number) {
  return db.select().from(playlistChannels).where(eq(playlistChannels.id, id)).get()!;
}

function pcId(sourceChannelId: number) {
  return db
    .select({ id: playlistChannels.id })
    .from(playlistChannels)
    .where(eq(playlistChannels.sourceChannelId, sourceChannelId))
    .get()!.id;
}

function setThreshold(n: number) {
  db.update(playlists)
    .set({ autoDisableFailedProbesAfter: n })
    .where(eq(playlists.id, playlistId))
    .run();
}

beforeEach(() => {
  db.delete(playlistChannels).run();
  db.delete(playlistCategories).run();
  db.delete(playlists).run();
  db.delete(sourceChannels).run();
  db.delete(sources).run();

  sourceId = db
    .insert(sources)
    .values({ name: "Main", serverUrl: "http://s", username: "u", password: "p" })
    .returning({ id: sources.id })
    .get().id;
  playlistId = db
    .insert(playlists)
    .values({ name: "PL", outputToken: "tok" })
    .returning({ id: playlists.id })
    .get().id;
  categoryId = db
    .insert(playlistCategories)
    .values({ playlistId, name: "UK", position: 0 })
    .returning({ id: playlistCategories.id })
    .get().id;
});

describe("autoDisableFailedChannels", () => {
  it("disables a channel once its streak hits the threshold and marks it", () => {
    const a = addSourceChannel("a", "Channel A", { status: "error", failures: 3 });
    addChannels(playlistId, categoryId, [a]);

    autoDisableFailedChannels([a]);

    const row = pcRow(pcId(a));
    expect(row.enabled).toBe(false);
    expect(row.autoDisabledAt).toBeInstanceOf(Date);
  });

  it("leaves a channel below the threshold alone", () => {
    const a = addSourceChannel("a", "Channel A", { status: "error", failures: 2 });
    addChannels(playlistId, categoryId, [a]);

    autoDisableFailedChannels([a]);

    expect(pcRow(pcId(a)).enabled).toBe(true);
  });

  it("does nothing when the playlist has auto-disable off", () => {
    setThreshold(0);
    const a = addSourceChannel("a", "Channel A", { status: "error", failures: 9 });
    addChannels(playlistId, categoryId, [a]);

    autoDisableFailedChannels([a]);

    expect(pcRow(pcId(a)).enabled).toBe(true);
  });

  it("promotes a working enabled alternate when the primary fails", () => {
    const a = addSourceChannel("a", "Primary", { status: "error", failures: 3 });
    const b = addSourceChannel("b", "Alt good", { status: "ok", failures: 0 });
    addChannels(playlistId, categoryId, [a, b]);
    const pcA = pcId(a);
    const pcB = pcId(b);
    makeAlternates(playlistId, pcA, [pcB]);

    autoDisableFailedChannels([a, b]);

    const newPrimary = pcRow(pcB);
    const oldPrimary = pcRow(pcA);
    // B took over as primary and stays on.
    expect(newPrimary.primaryChannelId).toBeNull();
    expect(newPrimary.enabled).toBe(true);
    // A is now a disabled alternate under B.
    expect(oldPrimary.primaryChannelId).toBe(pcB);
    expect(oldPrimary.enabled).toBe(false);
    expect(oldPrimary.autoDisabledAt).toBeInstanceOf(Date);
  });

  it("just disables the primary when no alternate is working", () => {
    const a = addSourceChannel("a", "Primary", { status: "error", failures: 3 });
    const b = addSourceChannel("b", "Alt bad", { status: "error", failures: 3 });
    addChannels(playlistId, categoryId, [a, b]);
    const pcA = pcId(a);
    const pcB = pcId(b);
    makeAlternates(playlistId, pcA, [pcB]);

    autoDisableFailedChannels([a, b]);

    // A stays primary, both off.
    expect(pcRow(pcA).primaryChannelId).toBeNull();
    expect(pcRow(pcA).enabled).toBe(false);
    expect(pcRow(pcB).enabled).toBe(false);
  });

  it("clears the marker and resets the streak when re-enabled", () => {
    const a = addSourceChannel("a", "Channel A", { status: "error", failures: 3 });
    addChannels(playlistId, categoryId, [a]);
    const pcA = pcId(a);
    autoDisableFailedChannels([a]);
    expect(pcRow(pcA).enabled).toBe(false);

    toggleChannel(playlistId, pcA, true);

    expect(pcRow(pcA).enabled).toBe(true);
    expect(pcRow(pcA).autoDisabledAt).toBeNull();
    const sc = db
      .select({ f: sourceChannels.consecutiveProbeFailures })
      .from(sourceChannels)
      .where(eq(sourceChannels.id, a))
      .get()!;
    expect(sc.f).toBe(0);
  });
});

/** Mark a source channel's latest probe result, as a re-probe would. */
function setProbeStatus(sourceChannelId: number, status: "ok" | "error") {
  db.update(sourceChannels)
    .set({ probeStatus: status })
    .where(eq(sourceChannels.id, sourceChannelId))
    .run();
}

describe("reviveRecoveredChannels", () => {
  it("turns an auto-disabled channel back on when it now probes ok", () => {
    const a = addSourceChannel("a", "Channel A", { status: "error", failures: 3 });
    addChannels(playlistId, categoryId, [a]);
    const pcA = pcId(a);
    autoDisableFailedChannels([a]);
    setProbeStatus(a, "ok");

    reviveRecoveredChannels(playlistId, [a]);

    expect(pcRow(pcA).enabled).toBe(true);
    expect(pcRow(pcA).autoDisabledAt).toBeNull();
  });

  it("leaves an auto-disabled channel off if it still fails", () => {
    const a = addSourceChannel("a", "Channel A", { status: "error", failures: 3 });
    addChannels(playlistId, categoryId, [a]);
    const pcA = pcId(a);
    autoDisableFailedChannels([a]);

    reviveRecoveredChannels(playlistId, [a]);

    expect(pcRow(pcA).enabled).toBe(false);
    expect(pcRow(pcA).autoDisabledAt).toBeInstanceOf(Date);
  });

  it("ignores channels that were turned off by hand, not auto-disabled", () => {
    const a = addSourceChannel("a", "Channel A", { status: "ok" });
    addChannels(playlistId, categoryId, [a]);
    const pcA = pcId(a);
    toggleChannel(playlistId, pcA, false);

    reviveRecoveredChannels(playlistId, [a]);

    expect(pcRow(pcA).enabled).toBe(false);
  });
});
