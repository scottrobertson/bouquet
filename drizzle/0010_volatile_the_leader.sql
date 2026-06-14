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
	`raw` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `epg_programmes_lookup` ON `epg_programmes` (`source_id`,`channel_id`,`start_ts`);--> statement-breakpoint
CREATE INDEX `epg_programmes_source_stop` ON `epg_programmes` (`source_id`,`stop_ts`);
