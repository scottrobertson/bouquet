import { sql } from "drizzle-orm";
import {
  index,
  integer,
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
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
  lastError: text("last_error"),
  channelCount: integer("channel_count").notNull().default(0),
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
    available: integer("available", { mode: "boolean" })
      .notNull()
      .default(true),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
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
    customLogo: text("custom_logo"),
    position: integer("position").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // EPG to use for this channel. Defaults to the channel's own source +
    // its source_channels.epg_channel_id, set at insert time.
    epgSourceId: integer("epg_source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    epgChannelId: text("epg_channel_id"),
  },
  (t) => [
    index("playlist_channels_playlist").on(t.playlistId),
    index("playlist_channels_category").on(t.categoryId),
    index("playlist_channels_source_channel").on(t.sourceChannelId),
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
export type Playlist = typeof playlists.$inferSelect;
export type PlaylistCategory = typeof playlistCategories.$inferSelect;
export type PlaylistChannel = typeof playlistChannels.$inferSelect;
