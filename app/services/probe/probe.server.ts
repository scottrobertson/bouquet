import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "~/db/index.server";
import {
  playlistCategories,
  playlistChannels,
  sourceCategories,
  sourceChannels,
  sources,
  type Source,
} from "~/db/schema";
import { bumpSource } from "~/services/events.server";
import {
  autoDisableFailedChannels,
  reviveRecoveredChannels,
} from "~/services/playlist/mutations.server";
import { isIntervalDue, mapPool } from "~/lib/pool";
import { qualityParts } from "~/lib/quality";
import {
  detectBlackScreen,
  measureBitrate,
  probeStream,
} from "~/services/probe/ffprobe.server";
import { buildStreamUrl, type XtreamCreds } from "~/services/xtream/client.server";

// A channel to probe: the bits we need to build its URL and store the result,
// plus the provider's category so a failure log names it. Providers file
// channels by category, so that's what you quote when reporting a dead stream.
type ProbeTarget = {
  id: number;
  streamId: string;
  name: string;
  categoryName: string | null;
};

/** The source channels worth auto-probing: those used by an enabled playlist
    channel, still available, and not hidden by a disabled source category.
    Mirrors what actually ends up in output, plus auto-disabled channels so a
    stream that comes back gets noticed and revived. Deduped, so a channel in
    several playlists is probed once. Manual probes use a wider net (see below). */
export function channelsToProbe(sourceId: number): ProbeTarget[] {
  return db
    .selectDistinct({
      id: sourceChannels.id,
      streamId: sourceChannels.streamId,
      name: sourceChannels.name,
      categoryName: sourceChannels.categoryName,
    })
    .from(sourceChannels)
    .innerJoin(
      playlistChannels,
      eq(playlistChannels.sourceChannelId, sourceChannels.id),
    )
    .leftJoin(
      sourceCategories,
      and(
        eq(sourceCategories.sourceId, sourceChannels.sourceId),
        eq(sourceCategories.name, sourceChannels.categoryName),
      ),
    )
    .where(
      and(
        eq(sourceChannels.sourceId, sourceId),
        eq(sourceChannels.available, true),
        or(
          eq(playlistChannels.enabled, true),
          isNotNull(playlistChannels.autoDisabledAt),
        ),
        or(isNull(sourceCategories.id), eq(sourceCategories.enabled, true)),
      ),
    )
    .all();
}

function credsFor(source: Source): XtreamCreds {
  return {
    // The provider's real base URL if we learned one, else the configured URL.
    serverUrl: source.streamBaseUrl ?? source.serverUrl,
    username: source.username,
    password: source.password,
  };
}

/** Probe one channel and write the result onto its source channel row. Returns
    whether it succeeded. When measureBitrate is set and the probe worked, also
    reads the stream for the read-time window to get its real bitrate, since
    ffprobe can't report that for live streams. Shared by every probe path. */
async function probeAndStore(
  source: Source,
  ch: ProbeTarget,
  measureBitrateToo: boolean,
): Promise<boolean> {
  const hls = source.outputFormat === "m3u8";
  const url = buildStreamUrl(credsFor(source), ch.streamId, source.outputFormat);

  // Flip the row to "probing" the moment we start, so the editor shows it as
  // live instead of waiting on the whole run.
  db.update(sourceChannels)
    .set({ probeStatus: "probing" })
    .where(eq(sourceChannels.id, ch.id))
    .run();
  bumpSource(source.id);

  const r = await probeStream(url, source.probeTimeoutSeconds, { hls });

  let bitrate = r.bitrate;
  if (r.status === "ok" && measureBitrateToo) {
    bitrate = (await measureBitrate(url, source.probeTimeoutSeconds, { hls })) ?? r.bitrate;
  }

  // ffprobe only sees stream metadata, so a stream with a valid video track but
  // a black picture still reads as ok. Decode a bit and fail it if it's black.
  if (r.status === "ok" && source.probeDetectBlackScreen) {
    if (await detectBlackScreen(url, source.probeTimeoutSeconds, { hls })) {
      r.status = "error";
      r.error = "Black screen";
    }
  }

  if (r.status === "ok") {
    const quality = qualityParts({
      probeStatus: r.status,
      probeWidth: r.width,
      probeHeight: r.height,
      probeFps: r.fps,
      probeVideoCodec: r.videoCodec,
      probeAudioCodec: r.audioCodec,
      probeBitrate: bitrate,
    }).join(" · ");
    console.log(`[probe] ${source.name}: "${ch.name}" ok: ${quality}`);
  } else {
    const category = ch.categoryName ?? "Uncategorised";
    console.warn(
      `[probe] ${source.name}: "${ch.name}" in "${category}" ${r.status}: ${r.error}`,
    );
  }

  // Only keep the measurements when the probe passed. A black screen is read by
  // ffprobe like any other stream, so it would otherwise leave a full set of
  // numbers on a channel we know is broken, and everything that ranks or
  // displays quality would treat it as a good stream.
  const quality =
    r.status === "ok"
      ? {
          probeWidth: r.width,
          probeHeight: r.height,
          probeFps: r.fps,
          probeVideoCodec: r.videoCodec,
          probeAudioCodec: r.audioCodec,
          probeBitrate: bitrate,
        }
      : {
          probeWidth: null,
          probeHeight: null,
          probeFps: null,
          probeVideoCodec: null,
          probeAudioCodec: null,
          probeBitrate: null,
        };

  db.update(sourceChannels)
    .set({
      probedAt: new Date(),
      probeStatus: r.status,
      ...quality,
      probeError: r.error,
      consecutiveProbeFailures:
        r.status === "ok" ? 0 : sql`${sourceChannels.consecutiveProbeFailures} + 1`,
    })
    .where(eq(sourceChannels.id, ch.id))
    .run();

  return r.status === "ok";
}

/** Probe a fixed list of channels for one source, tracking progress and status
    on the source so the UI can show "42/300". */
async function probeChannelList(
  source: Source,
  channels: ProbeTarget[],
): Promise<void> {
  db.update(sources)
    .set({ probeStatus: "probing", probeTotal: channels.length, probeDone: 0, probeError: null })
    .where(eq(sources.id, source.id))
    .run();

  // Light the whole batch up as "queued" right away, so the editor shows every
  // row waiting and they flip to "probing" then their result as the pool works.
  if (channels.length > 0) {
    db.update(sourceChannels)
      .set({ probeStatus: "queued" })
      .where(
        inArray(
          sourceChannels.id,
          channels.map((c) => c.id),
        ),
      )
      .run();
  }
  bumpSource(source.id);

  console.log(
    `[probe] ${source.name}: probing ${channels.length} channels, concurrency ${source.probeConcurrency}`,
  );

  let ok = 0;
  let failed = 0;
  await mapPool(channels, source.probeConcurrency, async (ch) => {
    (await probeAndStore(source, ch, source.probeMeasureBitrate)) ? ok++ : failed++;
    db.update(sources)
      .set({ probeDone: sql`${sources.probeDone} + 1` })
      .where(eq(sources.id, source.id))
      .run();
    bumpSource(source.id);
  });

  console.log(`[probe] ${source.name}: done, ${ok} ok, ${failed} failed`);

  // Turn off channels whose streak just crossed their playlist's threshold, and
  // bring back auto-disabled ones that probe ok again, before the final bump so
  // the editor shows it all in the same refresh.
  autoDisableFailedChannels(channels.map((c) => c.id));
  reviveRecoveredChannels(channels.map((c) => c.id));

  db.update(sources)
    .set({ probeStatus: "ok", lastProbedAt: new Date(), probeError: null })
    .where(eq(sources.id, source.id))
    .run();
  bumpSource(source.id);
}

/** Kick a background probe of one source, without waiting. Probes the channels
    from this source used in any playlist (the same set the scheduler uses). */
export function startProbe(sourceId: number): void {
  db.update(sources)
    .set({ probeStatus: "probing", probeTotal: 0, probeDone: 0, probeError: null })
    .where(eq(sources.id, sourceId))
    .run();
  bumpSource(sourceId);
  void runProbe(sourceId).catch((err) => markError(sourceId, err));
}

export async function runProbe(sourceId: number): Promise<void> {
  const source = db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!source) return;
  await probeChannelList(source, channelsToProbe(sourceId));
}

/** Probe a single channel right now, ignoring the available/category/enabled
    filters and the source's probe setting. Used by the per-channel button.
    Foreground so the caller can revalidate once it's written. */
export async function probeSingleChannel(sourceChannelId: number): Promise<void> {
  const ch = db
    .select({
      id: sourceChannels.id,
      streamId: sourceChannels.streamId,
      name: sourceChannels.name,
      categoryName: sourceChannels.categoryName,
      sourceId: sourceChannels.sourceId,
    })
    .from(sourceChannels)
    .where(eq(sourceChannels.id, sourceChannelId))
    .get();
  if (!ch) return;
  const source = db.select().from(sources).where(eq(sources.id, ch.sourceId)).get();
  if (!source) return;
  await probeAndStore(source, ch, source.probeMeasureBitrate);
  autoDisableFailedChannels([ch.id]);
  reviveRecoveredChannels([ch.id]);
}

/** Enabled channels placed in a playlist (optionally one category), with their
    source, ignoring the available/category filters so a manual probe covers
    everything the user sees in the editor. Ordered the same way the editor lists
    them so the probe marches down the list instead of jumping around.
    `only` narrows to channels never probed ("missing") or whose last probe
    failed ("failed"). Channels on a switched-off source are always left out:
    the user turned that provider off, so we shouldn't be opening streams on it. */
function playlistProbeTargets(
  playlistId: number,
  opts: { categoryId?: number; only?: "missing" | "failed" | "autoDisabled" } = {},
) {
  const { categoryId, only } = opts;
  const filters = [
    eq(playlistChannels.playlistId, playlistId),
    eq(sources.enabled, true),
  ];
  // Auto-disabled channels are turned off, so target them by their marker. Every
  // other probe only looks at enabled channels.
  if (only === "autoDisabled") {
    filters.push(isNotNull(playlistChannels.autoDisabledAt));
  } else {
    filters.push(eq(playlistChannels.enabled, true));
  }
  if (categoryId != null) filters.push(eq(playlistChannels.categoryId, categoryId));
  if (only === "missing") filters.push(isNull(sourceChannels.probeStatus));
  if (only === "failed") {
    filters.push(inArray(sourceChannels.probeStatus, ["error", "timeout"]));
  }
  return db
    .selectDistinct({
      sourceId: sourceChannels.sourceId,
      id: sourceChannels.id,
      streamId: sourceChannels.streamId,
      name: sourceChannels.name,
      categoryName: sourceChannels.categoryName,
      categoryPosition: playlistCategories.position,
      categoryId: playlistCategories.id,
      channelPosition: playlistChannels.position,
      channelId: playlistChannels.id,
    })
    .from(playlistChannels)
    .innerJoin(
      sourceChannels,
      eq(playlistChannels.sourceChannelId, sourceChannels.id),
    )
    .innerJoin(
      playlistCategories,
      eq(playlistChannels.categoryId, playlistCategories.id),
    )
    .innerJoin(sources, eq(sourceChannels.sourceId, sources.id))
    .where(and(...filters))
    .orderBy(
      asc(playlistCategories.position),
      asc(playlistCategories.id),
      asc(playlistChannels.position),
      asc(playlistChannels.id),
    )
    .all();
}

/** Fan a set of probe targets out across their sources, so each source runs at
    its own concurrency. Keeps each source's channels in the order given. */
function startProbeTargets(
  targets: (ProbeTarget & { sourceId: number })[],
): number {
  const bySource = new Map<number, ProbeTarget[]>();
  for (const t of targets) {
    const list = bySource.get(t.sourceId) ?? [];
    list.push({ id: t.id, streamId: t.streamId, name: t.name, categoryName: t.categoryName });
    bySource.set(t.sourceId, list);
  }

  for (const [sourceId, channels] of bySource) {
    const source = db.select().from(sources).where(eq(sources.id, sourceId)).get();
    if (!source) continue;
    void probeChannelList(source, channels).catch((err) => markError(sourceId, err));
  }
  return targets.length;
}

/** Kick a background probe of every channel in a playlist, grouped by source so
    each runs at its own concurrency. Ignores the source's probe setting and the
    available/category filters. Returns how many channels were queued. */
export function startProbePlaylist(playlistId: number): number {
  return startProbeTargets(playlistProbeTargets(playlistId));
}

/** Kick a background probe of only the playlist's channels that have never been
    probed. */
export function startProbeMissing(playlistId: number): number {
  return startProbeTargets(playlistProbeTargets(playlistId, { only: "missing" }));
}

/** Wipe probe results for every channel in a playlist, so they read as unprobed
    again. Probe data lives on the shared source channel, so this also clears it
    for any other playlist using the same stream. Returns how many were cleared. */
export function clearPlaylistProbes(playlistId: number): number {
  const rows = db
    .selectDistinct({
      id: sourceChannels.id,
      sourceId: sourceChannels.sourceId,
    })
    .from(playlistChannels)
    .innerJoin(sourceChannels, eq(playlistChannels.sourceChannelId, sourceChannels.id))
    .where(eq(playlistChannels.playlistId, playlistId))
    .all();
  if (rows.length === 0) return 0;

  db.update(sourceChannels)
    .set({
      probeStatus: null,
      probedAt: null,
      probeWidth: null,
      probeHeight: null,
      probeFps: null,
      probeVideoCodec: null,
      probeAudioCodec: null,
      probeBitrate: null,
      probeError: null,
    })
    .where(inArray(sourceChannels.id, rows.map((r) => r.id)))
    .run();

  for (const sourceId of new Set(rows.map((r) => r.sourceId))) bumpSource(sourceId);
  return rows.length;
}

/** Kick a background probe of only the playlist's channels whose last probe
    failed (errored or timed out). */
export function startProbeFailed(playlistId: number): number {
  return startProbeTargets(playlistProbeTargets(playlistId, { only: "failed" }));
}

/** Kick a background probe of the playlist's auto-disabled channels, turning any
    that work again back on. */
export function startProbeAutoDisabled(playlistId: number): number {
  return startProbeTargets(playlistProbeTargets(playlistId, { only: "autoDisabled" }));
}

/** Kick a background probe of every channel in one playlist category. Same rules
    as a full playlist probe, just scoped to the category. */
export function startProbeCategory(playlistId: number, categoryId: number): number {
  return startProbeTargets(playlistProbeTargets(playlistId, { categoryId }));
}

/** Kick a background probe of a specific set of source channels, grouped by
    source so each runs at its own concurrency. Ignores the source's probe
    setting and the available/category filters, but skips channels on a
    switched-off source. Returns how many were queued. */
export function startProbeChannels(sourceChannelIds: number[]): number {
  if (sourceChannelIds.length === 0) return 0;
  const rows = db
    .select({
      id: sourceChannels.id,
      streamId: sourceChannels.streamId,
      name: sourceChannels.name,
      categoryName: sourceChannels.categoryName,
      sourceId: sourceChannels.sourceId,
    })
    .from(sourceChannels)
    .innerJoin(sources, eq(sourceChannels.sourceId, sources.id))
    .where(and(inArray(sourceChannels.id, sourceChannelIds), eq(sources.enabled, true)))
    .all();

  // inArray ignores the order of the ids, so put the rows back into the order
  // they were asked for, then the per-source batches probe in that order.
  const order = new Map(sourceChannelIds.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const bySource = new Map<number, ProbeTarget[]>();
  for (const r of rows) {
    const list = bySource.get(r.sourceId) ?? [];
    list.push({ id: r.id, streamId: r.streamId, name: r.name, categoryName: r.categoryName });
    bySource.set(r.sourceId, list);
  }

  for (const [sourceId, channels] of bySource) {
    const source = db.select().from(sources).where(eq(sources.id, sourceId)).get();
    if (!source) continue;
    void probeChannelList(source, channels).catch((err) => markError(sourceId, err));
  }
  return rows.length;
}

// SQLite caps how many values one query can bind, so id lists get looked up in
// batches.
const ID_CHUNK = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// How long to wait before probing streams that were just added, so dropping
// channels in one at a time still ends up as a single probe run.
const ADDED_DEBOUNCE_MS = 3000;

// Held on globalThis so a dev HMR reload doesn't lose channels waiting to probe.
const addedState = globalThis as unknown as {
  __probeAddedTargets?: Map<number, ProbeTarget & { sourceId: number }>;
  __probeAddedTimer?: ReturnType<typeof setTimeout>;
};

/** Of the channels just added, the ones worth probing: their source is on and
    has probing turned on, the stream is still available, and we have no probe
    result for it yet. */
export function channelsToProbeOnAdd(
  sourceChannelIds: number[],
): (ProbeTarget & { sourceId: number })[] {
  const out: (ProbeTarget & { sourceId: number })[] = [];
  for (const ids of chunk(sourceChannelIds, ID_CHUNK)) {
    out.push(
      ...db
        .select({
          id: sourceChannels.id,
          streamId: sourceChannels.streamId,
          name: sourceChannels.name,
          categoryName: sourceChannels.categoryName,
          sourceId: sourceChannels.sourceId,
        })
        .from(sourceChannels)
        .innerJoin(sources, eq(sources.id, sourceChannels.sourceId))
        .where(
          and(
            inArray(sourceChannels.id, ids),
            eq(sources.enabled, true),
            eq(sources.probeEnabled, true),
            eq(sourceChannels.available, true),
            isNull(sourceChannels.probeStatus),
          ),
        )
        .all(),
    );
  }
  return out;
}

// Indirection so the debounce timer's target can be observed in tests.
export const addedProbeRunner = { run: startProbeTargets };

/** Probe streams that were just added to a playlist, so their quality shows up
    without waiting for the next scheduled probe. Adds within a few seconds of
    each other are collected into one run. */
export function probeAddedChannels(sourceChannelIds: number[]): void {
  if (sourceChannelIds.length === 0) return;
  const targets = channelsToProbeOnAdd(sourceChannelIds);
  if (targets.length === 0) return;

  // Mark them waiting straight away, before the delay below. The editor only
  // listens for live probe results while something is probing, so if the rows
  // still read as unprobed when the page reloads after the add, the quality
  // wouldn't appear until you reloaded by hand.
  for (const ids of chunk(targets.map((t) => t.id), ID_CHUNK)) {
    db.update(sourceChannels)
      .set({ probeStatus: "queued" })
      .where(inArray(sourceChannels.id, ids))
      .run();
  }
  for (const sourceId of new Set(targets.map((t) => t.sourceId))) bumpSource(sourceId);

  const pending = (addedState.__probeAddedTargets ??= new Map());
  for (const t of targets) pending.set(t.id, t);

  if (addedState.__probeAddedTimer) clearTimeout(addedState.__probeAddedTimer);
  addedState.__probeAddedTimer = setTimeout(() => {
    addedState.__probeAddedTimer = undefined;
    const batch = [...pending.values()];
    pending.clear();
    if (batch.length === 0) return;
    try {
      console.log(`[probe] probing ${batch.length} newly added channel(s)`);
      addedProbeRunner.run(batch);
    } catch (err) {
      console.error("[probe] probing added channels failed", err);
    }
  }, ADDED_DEBOUNCE_MS);
}

/** Probe a whole alternate group: the primary plus all its alternates. Their
    streams often come from different sources, so this fans out across them. */
export function startProbeGroup(
  playlistId: number,
  primaryPlaylistChannelId: number,
): number {
  const ids = db
    .select({ scid: playlistChannels.sourceChannelId })
    .from(playlistChannels)
    .where(
      and(
        eq(playlistChannels.playlistId, playlistId),
        or(
          eq(playlistChannels.id, primaryPlaylistChannelId),
          eq(playlistChannels.primaryChannelId, primaryPlaylistChannelId),
        ),
      ),
    )
    // Primary first (its primaryChannelId is null, which sorts first), then the
    // alternates in their own order, matching how the group reads in the editor.
    .orderBy(asc(playlistChannels.primaryChannelId), asc(playlistChannels.altPosition), asc(playlistChannels.id))
    .all()
    .map((r) => r.scid);
  return startProbeChannels(ids);
}

function markError(sourceId: number, err: unknown): void {
  db.update(sources)
    .set({
      probeStatus: "error",
      probeError: err instanceof Error ? err.message : "Probe failed",
    })
    .where(eq(sources.id, sourceId))
    .run();
  bumpSource(sourceId);
}

/** Has this source's probe interval elapsed? */
export function isProbeDue(
  lastProbedAt: Date | null,
  intervalMinutes: number,
  now: number,
): boolean {
  return isIntervalDue(lastProbedAt, intervalMinutes, now);
}

/** Probe the sources whose interval has elapsed, one at a time. Run hourly by
    the cron job; most ticks probe nothing. Mirrors syncDueSources. */
export async function probeDueSources(): Promise<void> {
  const now = Date.now();
  const all = db
    .select({
      id: sources.id,
      enabled: sources.enabled,
      probeEnabled: sources.probeEnabled,
      lastProbedAt: sources.lastProbedAt,
      probeIntervalMinutes: sources.probeIntervalMinutes,
    })
    .from(sources)
    .all();
  const due = all.filter(
    (s) =>
      s.enabled &&
      s.probeEnabled &&
      isProbeDue(s.lastProbedAt, s.probeIntervalMinutes, now),
  );
  console.log(`[probe] ${due.length} of ${all.length} sources due`);
  for (const s of due) {
    await runProbe(s.id);
  }
}
