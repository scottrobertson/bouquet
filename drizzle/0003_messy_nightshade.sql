ALTER TABLE `playlist_categories` ADD `auto_source_id` integer REFERENCES sources(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `playlist_categories` ADD `auto_category_name` text;