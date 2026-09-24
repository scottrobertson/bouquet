import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/** An IPTV provider. Only Xtream Codes is supported for now. */
export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type", { enum: ["xtream"] })
    .notNull()
    .default("xtream"),
  serverUrl: text("server_url").notNull(),
  // The provider's real base URL, learned from the API's server_info on sync.
  // Used to build output stream URLs, so serverUrl can be a proxy if needed.
  streamBaseUrl: text("stream_base_url"),
  username: text("username").notNull(),
  password: text("password").notNull(),
  syncStatus: text("sync_status", {
    enum: ["idle", "syncing", "ok", "error"],
  })
    .notNull()
    .default("idle"),
  // Stream URL flavour written into the output M3U for this source's channels.
  outputFormat: text("output_format", { enum: ["ts", "m3u8"] })
    .notNull()
    .default("ts"),
  // When off, categories newly found on a sync arrive disabled (opt-in).
  autoImportGroups: integer("auto_import_groups", { mode: "boolean" })
    .notNull()
    .default(true),
  // When off, the source is paused: its channels drop out of playlist output
  // and the scheduler skips its sync and probe. Turning it back on restores
  // everything as it was, since nothing is deleted.
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  // How often the scheduler auto-syncs this source, in minutes. 0 = manual only.
  syncIntervalMinutes: integer("sync_interval_minutes").notNull().default(1440),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
  lastError: text("last_error"),
  channelCount: integer("channel_count").notNull().default(0),
  // Account details read from the provider on each sync. Null when the provider
  // doesn't report them.
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  maxConnections: integer("max_connections"),
  // Provider's account status, e.g. "Active" or "Expired".
  accountStatus: text("account_status"),
  // Set when categories are toggled, since stored programmes only cover the
  // channels in enabled categories. Cleared on the next successful sync.
  epgStale: integer("epg_stale", { mode: "boolean" }).notNull().default(false),
  // Probing runs ffprobe against each stream to record its quality. Off by
  // default since it opens real connections against the provider.
  probeEnabled: integer("probe_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  // How many streams to probe at once for this source. The provider's
  // maxConnections is the practical ceiling; we don't enforce it.
  probeConcurrency: integer("probe_concurrency").notNull().default(1),
  // How often the scheduler auto-probes this source, in minutes. 0 = manual only.
  probeIntervalMinutes: integer("probe_interval_minutes").notNull().default(1440),
  // How long to let ffprobe read a stream before giving up, in seconds. Also the
  // window used to measure bitrate when that's on.
  probeTimeoutSeconds: integer("probe_timeout_seconds").notNull().default(10),
  // Measure real bitrate by reading each stream for the read-time window. Off by
  // default since it makes probing much slower (it downloads several MB per
  // channel instead of just reading the header).
  probeMeasureBitrate: integer("probe_measure_bitrate", { mode: "boolean" })
    .notNull()
    .default(false),
  // Decode a few seconds of each stream and mark it failed if the picture is all
  // black. Catches dead channels that still look fine to ffprobe (valid video
  // track, resolution, codecs, but nothing on screen).
  probeDetectBlackScreen: integer("probe_detect_black_screen", { mode: "boolean" })
    .notNull()
    .default(true),
  probeStatus: text("probe_status", {
    enum: ["idle", "probing", "ok", "error"],
  })
    .notNull()
    .default("idle"),
  lastProbedAt: integer("last_probed_at", { mode: "timestamp" }),
  probeError: text("probe_error"),
  // Live progress counters for the current/last run, so the UI can show "42/300".
  probeTotal: integer("probe_total").notNull().default(0),
  probeDone: integer("probe_done").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/** Raw channel catalog pulled from a source. The source of truth.
    Keyed by (source_id, stream_id) so resync never disturbs user edits. */
export const sourceChannels = sqliteTable(
  "source_channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    streamId: text("stream_id").notNull(),
    name: text("name").notNull(),
    logo: text("logo"),
    epgChannelId: text("epg_channel_id"),
    categoryName: text("category_name"),
    // Provider order (index in get_live_streams). Keeps lists in the order the
    // provider returns, not alphabetical.
    position: integer("position").notNull().default(0),
    tvArchive: integer("tv_archive", { mode: "boolean" })
      .notNull()
      .default(false),
    // Days of catchup the provider keeps for this channel. 0 when none.
    tvArchiveDuration: integer("tv_archive_duration").notNull().default(0),
    available: integer("available", { mode: "boolean" })
      .notNull()
      .default(true),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    // Latest ffprobe result for this stream. Null status means never probed.
    // Stored here, not on playlist_channels, since a stream is shared across
    // playlists and we only probe it once.
    probedAt: integer("probed_at", { mode: "timestamp" }),
    // "queued" and "probing" are live states the editor shows while a probe is
    // in flight. The column is plain text (the enum is types only), so the new
    // values need no migration.
    probeStatus: text("probe_status", {
      enum: ["queued", "probing", "ok", "error", "timeout"],
    }),
    probeWidth: integer("probe_width"),
    probeHeight: integer("probe_height"),
    // Frame rate can be fractional, e.g. 29.97.
    probeFps: real("probe_fps"),
    probeVideoCodec: text("probe_video_codec"),
    probeAudioCodec: text("probe_audio_codec"),
    // Overall stream bitrate in kbps where the provider reports it.
    probeBitrate: integer("probe_bitrate"),
    probeError: text("probe_error"),
    // How many times in a row this stream's probe has failed. Reset to 0 on a
    // good probe. Drives the per-playlist auto-disable.
    consecutiveProbeFailures: integer("consecutive_probe_failures")
      .notNull()
      .default(0),
  },
  (t) => [
    unique("source_channels_source_stream").on(t.sourceId, t.streamId),
    index("source_channels_source").on(t.sourceId),
  ],
);

/** EPG channels available from a source's xmltv.php, for the matching dropdown. */
export const sourceEpgChannels = sqliteTable(
  "source_epg_channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    displayName: text("display_name"),
    icon: text("icon"),
  },
  (t) => [
    unique("source_epg_channels_source_channel").on(t.sourceId, t.channelId),
    index("source_epg_channels_source").on(t.sourceId),
  ],
);

/** Per-source category enable state. Disabled categories are hidden from the
    playlist browser and excluded from output. Seeded on sync; new categories
    default to enabled. */
export const sourceCategories = sqliteTable(
  "source_categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    unique("source_categories_source_name").on(t.sourceId, t.name),
    index("source_categories_source").on(t.sourceId),
  ],
);

/** A curated output playlist. */
export const playlists = sqliteTable("playlists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  outputToken: text("output_token").notNull().unique(),
  // Auto-name for a channel's alternates. {name} is the primary's name, {n} the
  // alternate number, {provider} the alternate's provider name and
  // {provider_letter} its first letter.
  altNameTemplate: text("alt_name_template")
    .notNull()
    .default("{name} (Alt {n})"),
  // Output name for every channel that isn't an alternate. {name} is the
  // channel's own name, {provider} its provider name and {provider_letter} that
  // name's first letter.
  channelNameTemplate: text("channel_name_template")
    .notNull()
    .default("{name}"),
  // Smart sort orders an alt group best-first from probe data. These pick what
  // "best" means. prefer = the top quality signal, resolution or bitrate; audio
  // = let surround audio break near-ties; availableFirst = sink dead/errored
  // streams below working ones.
  smartSortPrefer: text("smart_sort_prefer", { enum: ["resolution", "bitrate"] })
    .notNull()
    .default("resolution"),
  smartSortAudio: integer("smart_sort_audio", { mode: "boolean" })
    .notNull()
    .default(true),
  smartSortAvailableFirst: integer("smart_sort_available_first", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  // Turn a channel off once its stream fails this many probes in a row. 0 = off.
  // A failing primary promotes a working alternate first.
  autoDisableFailedProbesAfter: integer("auto_disable_failed_probes_after")
    .notNull()
    .default(3),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/** Where a playlist's generated M3U and EPG get pushed, so a player can point at
    those files instead of at Bouquet directly. A playlist can have several.
    `type` picks the backend; `config` holds that backend's connection settings and
    credentials (plaintext, same as source passwords). Credentials never leave this
    box, but the uploaded M3U embeds provider stream URLs (which carry the provider
    login), so treat the destination like the public output URLs. */
export const uploadDestinations = sqliteTable("upload_destinations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playlistId: integer("playlist_id")
    .notNull()
    .references(() => playlists.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type", { enum: ["s3", "local"] }).notNull(),
  config: text("config", { mode: "json" }).$type<DestinationConfig>().notNull(),
  // Object keys / paths the files are written to within the destination.
  m3uPath: text("m3u_path").notNull().default("playlist.m3u"),
  epgPath: text("epg_path").notNull().default("playlist.xml"),
  // Where the uploaded files are reachable (bucket public base, CDN, etc). Used
  // to build the uploaded M3U's url-tvg and shown to the user. Null = unknown.
  publicUrlBase: text("public_url_base"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  uploadStatus: text("upload_status", {
    enum: ["idle", "uploading", "ok", "error"],
  })
    .notNull()
    .default("idle"),
  lastUploadedAt: integer("last_uploaded_at", { mode: "timestamp" }),
  uploadError: text("upload_error"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/** A category (group) inside a playlist. When autoSourceId is set, it's an
    auto-sync group: its channels mirror one source category live (read-only),
    so there are no playlist_channels rows for it. */
export const playlistCategories = sqliteTable(
  "playlist_categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    playlistId: integer("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    autoSourceId: integer("auto_source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    autoCategoryName: text("auto_category_name"),
  },
  (t) => [index("playlist_categories_playlist").on(t.playlistId)],
);

/** A source channel placed into a playlist category, with per-playlist edits.
    Edits reference source_channel_id (stable) so they survive resync. */
export const playlistChannels = sqliteTable(
  "playlist_channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    playlistId: integer("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => playlistCategories.id, { onDelete: "cascade" }),
    sourceChannelId: integer("source_channel_id")
      .notNull()
      .references(() => sourceChannels.id, { onDelete: "cascade" }),
    customName: text("custom_name"),
    // Manual logo override. With none set, a non-default EPG pick lends its
    // logo, otherwise the source channel's own logo is used.
    customLogo: text("custom_logo"),
    position: integer("position").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // EPG to use for this channel. Defaults to the channel's own source +
    // its source_channels.epg_channel_id, set at insert time.
    epgSourceId: integer("epg_source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    epgChannelId: text("epg_channel_id"),
    // When set, this channel is an alternate of another playlist channel, its
    // primary. Primaries leave this null. An alternate always sits in the same
    // category as its primary. Set null on delete is a safety net; deleting a
    // primary promotes its first alternate instead.
    primaryChannelId: integer("primary_channel_id").references(
      (): AnySQLiteColumn => playlistChannels.id,
      { onDelete: "set null" },
    ),
    // Order among a primary's alternates. 0 for primaries.
    altPosition: integer("alt_position").notNull().default(0),
    // Set when auto-disabled after repeated probe failures, so the editor can
    // tell it apart from a channel the user turned off. Cleared on any manual
    // toggle.
    autoDisabledAt: integer("auto_disabled_at", { mode: "timestamp" }),
  },
  (t) => [
    index("playlist_channels_playlist").on(t.playlistId),
    index("playlist_channels_category").on(t.categoryId),
    index("playlist_channels_source_channel").on(t.sourceChannelId),
    index("playlist_channels_primary").on(t.primaryChannelId),
  ],
);

/** Programmes pulled per channel from the provider's get_simple_data_table at
    sync time. Unlike xmltv.php this includes already-aired programmes, so the
    guide and catchup can show recent history. Powers the guide and the EPG
    output, so both read the same data. Each sync replaces a channel's rows, so
    stored EPG mirrors what the provider currently serves. */
export const epgProgrammes = sqliteTable(
  "epg_programmes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    // The channel's epg id. Matches ResolvedChannel.tvgId.
    channelId: text("channel_id").notNull(),
    // Unix seconds. Range queries hit these.
    startTs: integer("start_ts").notNull(),
    stopTs: integer("stop_ts").notNull(),
    title: text("title"),
    subTitle: text("sub_title"),
    description: text("description"),
    category: text("category"),
    // Provider says this past programme can be replayed from the archive.
    hasArchive: integer("has_archive", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => [
    index("epg_programmes_lookup").on(t.sourceId, t.channelId, t.startTs),
    index("epg_programmes_source_stop").on(t.sourceId, t.stopTs),
  ],
);

/** Append-only log of what a sync added/removed for a source, for history. */
export const sourceChanges = sqliteTable(
  "source_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    // Groups every change from one sync run.
    syncedAt: integer("synced_at", { mode: "timestamp" }).notNull(),
    kind: text("kind", {
      enum: [
        "channel_added",
        "channel_removed",
        "channel_returned",
        "category_added",
        "category_removed",
      ],
    }).notNull(),
    // Snapshot of the name at the time, so history stays readable later.
    name: text("name").notNull(),
    categoryName: text("category_name"),
    streamId: text("stream_id"),
    // Playlists this change touched, snapshotted (id + name) at sync time so the
    // log stays accurate even if a playlist is later renamed or deleted.
    playlists: text("playlists", { mode: "json" }).$type<
      { id: number; name: string }[]
    >(),
  },
  (t) => [index("source_changes_source_synced").on(t.sourceId, t.syncedAt)],
);

export type Source = typeof sources.$inferSelect;
export type SourceChannel = typeof sourceChannels.$inferSelect;
export type SourceChange = typeof sourceChanges.$inferSelect;
export type SourceEpgChannel = typeof sourceEpgChannels.$inferSelect;
export type SourceCategory = typeof sourceCategories.$inferSelect;
export type EpgProgramme = typeof epgProgrammes.$inferSelect;
export type Playlist = typeof playlists.$inferSelect;
export type PlaylistCategory = typeof playlistCategories.$inferSelect;
export type PlaylistChannel = typeof playlistChannels.$inferSelect;
export type UploadDestination = typeof uploadDestinations.$inferSelect;

/** Per-backend connection settings for an upload destination, discriminated by
    the row's `type`. Credentials are stored plaintext. */
export type S3Config = {
  // Leave endpoint empty for real AWS S3; set it for S3-compatible stores
  // (R2, MinIO, Backblaze B2, DigitalOcean Spaces, Wasabi, Storj).
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // MinIO and some others need path-style URLs instead of the bucket subdomain.
  forcePathStyle?: boolean;
  // Prepended to every object key.
  prefix?: string;
};

export type LocalConfig = {
  // Directory the files are written into (e.g. a mounted volume served elsewhere).
  path: string;
};

export type DestinationConfig = S3Config | LocalConfig;
