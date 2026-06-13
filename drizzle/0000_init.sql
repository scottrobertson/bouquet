CREATE TABLE `playlist_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playlist_categories_playlist` ON `playlist_categories` (`playlist_id`);--> statement-breakpoint
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
	`epg_channel_id` text,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `playlist_categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_channel_id`) REFERENCES `source_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`epg_source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `playlist_channels_playlist` ON `playlist_channels` (`playlist_id`);--> statement-breakpoint
CREATE INDEX `playlist_channels_category` ON `playlist_channels` (`category_id`);--> statement-breakpoint
CREATE INDEX `playlist_channels_source_channel` ON `playlist_channels` (`source_channel_id`);--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`output_token` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playlists_output_token_unique` ON `playlists` (`output_token`);--> statement-breakpoint
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
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_channels_source` ON `source_channels` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_channels_source_stream` ON `source_channels` (`source_id`,`stream_id`);--> statement-breakpoint
CREATE TABLE `source_epg_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`display_name` text,
	`icon` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_epg_channels_source` ON `source_epg_channels` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_epg_channels_source_channel` ON `source_epg_channels` (`source_id`,`channel_id`);--> statement-breakpoint
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
);
