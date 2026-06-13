CREATE TABLE `source_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`synced_at` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`category_name` text,
	`stream_id` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_changes_source_synced` ON `source_changes` (`source_id`,`synced_at`);