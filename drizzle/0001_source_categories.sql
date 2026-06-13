CREATE TABLE `source_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_categories_source` ON `source_categories` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_categories_source_name` ON `source_categories` (`source_id`,`name`);