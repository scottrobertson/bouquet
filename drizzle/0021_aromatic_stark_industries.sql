CREATE TABLE `upload_destinations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`m3u_path` text DEFAULT 'playlist.m3u' NOT NULL,
	`epg_path` text DEFAULT 'playlist.xml' NOT NULL,
	`public_url_base` text,
	`enabled` integer DEFAULT true NOT NULL,
	`upload_status` text DEFAULT 'idle' NOT NULL,
	`last_uploaded_at` integer,
	`upload_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade
);
