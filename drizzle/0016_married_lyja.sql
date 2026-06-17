ALTER TABLE `source_channels` ADD `probed_at` integer;--> statement-breakpoint
ALTER TABLE `source_channels` ADD `probe_status` text;--> statement-breakpoint
ALTER TABLE `source_channels` ADD `probe_width` integer;--> statement-breakpoint
ALTER TABLE `source_channels` ADD `probe_height` integer;--> statement-breakpoint
ALTER TABLE `source_channels` ADD `probe_fps` real;--> statement-breakpoint
ALTER TABLE `source_channels` ADD `probe_video_codec` text;--> statement-breakpoint
ALTER TABLE `source_channels` ADD `probe_audio_codec` text;--> statement-breakpoint
ALTER TABLE `source_channels` ADD `probe_bitrate` integer;--> statement-breakpoint
ALTER TABLE `source_channels` ADD `probe_error` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `probe_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `probe_concurrency` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `probe_interval_minutes` integer DEFAULT 1440 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `probe_timeout_seconds` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `probe_status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `last_probed_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `probe_error` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `probe_total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `probe_done` integer DEFAULT 0 NOT NULL;