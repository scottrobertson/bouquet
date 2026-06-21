ALTER TABLE `playlist_channels` ADD `auto_disabled_at` integer;--> statement-breakpoint
ALTER TABLE `playlists` ADD `auto_disable_failed_probes_after` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `source_channels` ADD `consecutive_probe_failures` integer DEFAULT 0 NOT NULL;