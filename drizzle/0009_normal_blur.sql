ALTER TABLE `playlist_channels` ADD `primary_channel_id` integer REFERENCES playlist_channels(id);--> statement-breakpoint
ALTER TABLE `playlist_channels` ADD `alt_position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `playlist_channels_primary` ON `playlist_channels` (`primary_channel_id`);--> statement-breakpoint
ALTER TABLE `playlists` ADD `alt_name_template` text DEFAULT '{name} (Alt {n})' NOT NULL;