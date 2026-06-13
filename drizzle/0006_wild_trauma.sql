ALTER TABLE `sources` ADD `output_format` text DEFAULT 'ts' NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `auto_import_groups` integer DEFAULT true NOT NULL;