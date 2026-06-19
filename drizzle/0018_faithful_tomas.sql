ALTER TABLE `playlists` ADD `smart_sort_prefer` text DEFAULT 'resolution' NOT NULL;--> statement-breakpoint
ALTER TABLE `playlists` ADD `smart_sort_audio` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `playlists` ADD `smart_sort_available_first` integer DEFAULT true NOT NULL;