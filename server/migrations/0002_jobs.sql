-- Every background task (sync, probe, upload, backup) runs as a job, so the UI
-- can show what's queued, what's running and how it went.
-- kind is sync, probe, upload or backup. trigger is manual (someone pressed a
-- button), scheduled (the cron) or automatic (a follow on, like probing newly
-- added channels or uploading after a sync).
-- status is queued, running, succeeded, failed or interrupted (the server
-- stopped while it was queued or running).
-- title is a snapshot like "Sync Provider A", so history still reads well after
-- a rename or delete. step, done and total are the live progress, and summary
-- is a one line result once it succeeds.
-- params is the JSON the runner needs to start the job.
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`title` text NOT NULL,
	`source_id` integer,
	`playlist_id` integer,
	`destination_id` integer,
	`params` text DEFAULT '{}' NOT NULL,
	`step` text,
	`done` integer,
	`total` integer,
	`summary` text,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`destination_id`) REFERENCES `upload_destinations`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE INDEX `jobs_status` ON `jobs` (`status`);
CREATE INDEX `jobs_created` ON `jobs` (`created_at`);
CREATE INDEX `jobs_source` ON `jobs` (`source_id`);

-- What a job did, line by line. level is info, warn or error.
CREATE TABLE `job_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `job_logs_job` ON `job_logs` (`job_id`);

-- Whether a sync, probe or upload is running comes from the jobs table, so
-- these columns only ever hold the last result.
UPDATE `sources` SET `sync_status` = 'idle' WHERE `sync_status` = 'syncing';
UPDATE `sources` SET `probe_status` = 'idle' WHERE `probe_status` = 'probing';
UPDATE `upload_destinations` SET `upload_status` = 'idle' WHERE `upload_status` = 'uploading';
