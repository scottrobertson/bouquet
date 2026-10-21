-- Set when a passing probe saw a frozen picture, like a logo card while the
-- channel is off air. Its numbers are kept for the history but left out of the
-- channel's summary.
ALTER TABLE `probe_samples` ADD `off_air` integer DEFAULT false NOT NULL;

-- Every probe reads the stream for its full read time, so bitrate is always
-- measured and this setting has nothing to switch.
ALTER TABLE `sources` DROP COLUMN `probe_measure_bitrate`;
