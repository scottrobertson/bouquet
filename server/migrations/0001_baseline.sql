-- The schema as the TypeScript app left it after its 25 drizzle migrations,
-- copied from a live database. Column order matters: restore copies tables
-- with SELECT *, so it has to match databases built by those migrations.

-- An IPTV provider. Only Xtream Codes is supported for now.
-- stream_base_url is the provider's real base URL from the API's server_info,
-- used for output stream URLs so server_url can be a proxy.
-- sync_interval_minutes and probe_interval_minutes of 0 mean manual only.
-- epg_stale is set when categories are toggled, since stored programmes only
-- cover enabled categories, and cleared on the next good sync.
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'xtream' NOT NULL,
	`server_url` text NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL,
	`sync_status` text DEFAULT 'idle' NOT NULL,
	`last_synced_at` integer,
	`last_error` text,
	`channel_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
, `output_format` text DEFAULT 'ts' NOT NULL, `auto_import_groups` integer DEFAULT true NOT NULL, `stream_base_url` text, `epg_stale` integer DEFAULT false NOT NULL, `sync_interval_minutes` integer DEFAULT 1440 NOT NULL, `expires_at` integer, `max_connections` integer, `account_status` text, `probe_enabled` integer DEFAULT false NOT NULL, `probe_concurrency` integer DEFAULT 1 NOT NULL, `probe_interval_minutes` integer DEFAULT 1440 NOT NULL, `probe_timeout_seconds` integer DEFAULT 10 NOT NULL, `probe_status` text DEFAULT 'idle' NOT NULL, `last_probed_at` integer, `probe_error` text, `probe_total` integer DEFAULT 0 NOT NULL, `probe_done` integer DEFAULT 0 NOT NULL, `probe_measure_bitrate` integer DEFAULT false NOT NULL, `probe_detect_black_screen` integer DEFAULT true NOT NULL, `enabled` integer DEFAULT true NOT NULL, `notes` text);

-- Raw channel catalog pulled from a source, keyed by (source_id, stream_id) so
-- a resync never disturbs user edits. position is the provider's own order.
-- The probe_* columns hold the latest ffprobe result; a null probe_status means
-- never probed. They live here, not on playlist_channels, because one stream is
-- shared by every playlist that uses it.
CREATE TABLE `source_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`stream_id` text NOT NULL,
	`name` text NOT NULL,
	`logo` text,
	`epg_channel_id` text,
	`category_name` text,
	`tv_archive` integer DEFAULT false NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL, `position` integer DEFAULT 0 NOT NULL, `tv_archive_duration` integer DEFAULT 0 NOT NULL, `probed_at` integer, `probe_status` text, `probe_width` integer, `probe_height` integer, `probe_fps` real, `probe_video_codec` text, `probe_audio_codec` text, `probe_bitrate` integer, `probe_error` text, `consecutive_probe_failures` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `source_channels_source` ON `source_channels` (`source_id`);
CREATE UNIQUE INDEX `source_channels_source_stream` ON `source_channels` (`source_id`,`stream_id`);

-- EPG channels a source offers, for the EPG picker.
CREATE TABLE `source_epg_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`display_name` text,
	`icon` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `source_epg_channels_source` ON `source_epg_channels` (`source_id`);
CREATE UNIQUE INDEX `source_epg_channels_source_channel` ON `source_epg_channels` (`source_id`,`channel_id`);

-- Whether each source category is switched on. Disabled categories are hidden
-- from the playlist browser and left out of output.
CREATE TABLE `source_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `source_categories_source` ON `source_categories` (`source_id`);
CREATE UNIQUE INDEX `source_categories_source_name` ON `source_categories` (`source_id`,`name`);

-- A curated output playlist. auto_disable_failed_probes_after of 0 means off.
CREATE TABLE `playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`output_token` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
, `alt_name_template` text DEFAULT '{name} (Alt {n})' NOT NULL, `smart_sort_prefer` text DEFAULT 'resolution' NOT NULL, `smart_sort_audio` integer DEFAULT true NOT NULL, `smart_sort_available_first` integer DEFAULT true NOT NULL, `auto_disable_failed_probes_after` integer DEFAULT 3 NOT NULL, `channel_name_template` text DEFAULT '{name}' NOT NULL);
CREATE UNIQUE INDEX `playlists_output_token_unique` ON `playlists` (`output_token`);

-- Where a playlist's M3U and EPG get pushed after a sync. config is JSON
-- holding the backend's settings and credentials, in plain text.
CREATE TABLE `upload_destinations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`m3u_path` text DEFAULT 'playlist.m3u' NOT NULL,
	`epg_path` text DEFAULT 'playlist.xml' NOT NULL,
	`public_url_base` text,
	`enabled` integer DEFAULT true NOT NULL,
	`upload_status` text DEFAULT 'idle' NOT NULL,
	`last_uploaded_at` integer,
	`upload_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade
);

-- A group inside a playlist. With auto_source_id set it's an auto-sync group
-- that mirrors one source category live and has no playlist_channels rows.
CREATE TABLE `playlist_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL, `auto_source_id` integer REFERENCES sources(id) ON DELETE SET NULL, `auto_category_name` text,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `playlist_categories_playlist` ON `playlist_categories` (`playlist_id`);

-- A source channel placed in a playlist, with that playlist's own edits.
-- primary_channel_id makes it an alternate of another channel in the same
-- category. Deleting a primary promotes its first alternate in code, which is
-- why this foreign key has no ON DELETE rule.
-- auto_disabled_at marks channels switched off after repeated probe failures.
CREATE TABLE `playlist_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`source_channel_id` integer NOT NULL,
	`custom_name` text,
	`custom_logo` text,
	`position` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`epg_source_id` integer,
	`epg_channel_id` text, `primary_channel_id` integer REFERENCES playlist_channels(id), `alt_position` integer DEFAULT 0 NOT NULL, `auto_disabled_at` integer,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `playlist_categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_channel_id`) REFERENCES `source_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`epg_source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE INDEX `playlist_channels_playlist` ON `playlist_channels` (`playlist_id`);
CREATE INDEX `playlist_channels_category` ON `playlist_channels` (`category_id`);
CREATE INDEX `playlist_channels_source_channel` ON `playlist_channels` (`source_channel_id`);
CREATE INDEX `playlist_channels_primary` ON `playlist_channels` (`primary_channel_id`);

-- Programmes pulled per channel from get_simple_data_table on sync. Times are
-- unix seconds. Each sync replaces a channel's rows.
CREATE TABLE `epg_programmes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`start_ts` integer NOT NULL,
	`stop_ts` integer NOT NULL,
	`title` text,
	`sub_title` text,
	`description` text,
	`category` text,
	`has_archive` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `epg_programmes_lookup` ON `epg_programmes` (`source_id`,`channel_id`,`start_ts`);
CREATE INDEX `epg_programmes_source_stop` ON `epg_programmes` (`source_id`,`stop_ts`);

-- What each sync added or removed. playlists is a JSON [{id, name}] snapshot
-- so the history stays readable after a playlist is renamed or deleted.
CREATE TABLE `source_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`synced_at` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`category_name` text,
	`stream_id` text, `playlists` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `source_changes_source_synced` ON `source_changes` (`source_id`,`synced_at`);
