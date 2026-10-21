-- Every probe result for a source channel, kept for PROBE_HISTORY_DAYS. One
-- probe is a few seconds of a live stream, so a single reading can catch an
-- off air slate or a slow server. The probe_* columns on source_channels are a
-- summary of these rows, which is what the editor shows and smart sort reads.
-- status is ok, error or timeout. A failed probe keeps no quality numbers.
CREATE TABLE `probe_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_channel_id` integer NOT NULL,
	`probed_at` integer NOT NULL,
	`status` text NOT NULL,
	`width` integer,
	`height` integer,
	`fps` real,
	`video_codec` text,
	`audio_codec` text,
	`bitrate` integer,
	`error` text,
	FOREIGN KEY (`source_channel_id`) REFERENCES `source_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `probe_samples_channel` ON `probe_samples` (`source_channel_id`, `probed_at`);
CREATE INDEX `probe_samples_probed_at` ON `probe_samples` (`probed_at`);

-- How many probes in the history window passed, out of how many ran.
ALTER TABLE `source_channels` ADD `probe_passes` integer DEFAULT 0 NOT NULL;
ALTER TABLE `source_channels` ADD `probe_attempts` integer DEFAULT 0 NOT NULL;

-- Start everyone's history with the result they already have.
INSERT INTO `probe_samples` (`source_channel_id`, `probed_at`, `status`, `width`, `height`, `fps`, `video_codec`, `audio_codec`, `bitrate`, `error`)
SELECT `id`, `probed_at`, `probe_status`, `probe_width`, `probe_height`, `probe_fps`, `probe_video_codec`, `probe_audio_codec`, `probe_bitrate`, `probe_error`
FROM `source_channels` WHERE `probed_at` IS NOT NULL AND `probe_status` IN ('ok', 'error', 'timeout');
UPDATE `source_channels` SET `probe_attempts` = 1, `probe_passes` = (`probe_status` = 'ok')
WHERE `probed_at` IS NOT NULL AND `probe_status` IN ('ok', 'error', 'timeout');
