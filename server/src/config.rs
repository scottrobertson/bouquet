use std::path::PathBuf;
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct Config {
    pub config_path: PathBuf,
    pub database_path: PathBuf,
    pub backups_path: PathBuf,
    // Hourly ticks; each job only acts on sources whose own interval has passed.
    pub sync_cron: String,
    pub probe_cron: String,
    pub backup_cron: String,
    pub backup_keep: usize,
    pub ffprobe_path: String,
    pub ffmpeg_path: String,
    pub port: u16,
    pub run_scheduler: bool,
}

impl Config {
    pub fn from_env() -> Config {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        // Everything we persist (the SQLite db and backups) lives under here.
        let config_path = PathBuf::from(var("CONFIG_PATH").unwrap_or_else(|| "./data".into()));
        Config {
            database_path: config_path.join("bouquet.db"),
            backups_path: config_path.join("backups"),
            config_path,
            sync_cron: var("SYNC_CRON").unwrap_or_else(|| "0 * * * *".into()),
            probe_cron: var("PROBE_CRON").unwrap_or_else(|| "0 * * * *".into()),
            backup_cron: var("BACKUP_CRON").unwrap_or_else(|| "0 3 * * *".into()),
            backup_keep: var("BACKUP_KEEP").and_then(|v| v.parse().ok()).unwrap_or(14),
            ffprobe_path: var("FFPROBE_PATH").unwrap_or_else(|| "ffprobe".into()),
            ffmpeg_path: var("FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into()),
            port: var("PORT").and_then(|v| v.parse().ok()).unwrap_or(3000),
            // Debug builds are dev servers, where background syncs against real
            // providers would only get in the way.
            run_scheduler: !cfg!(debug_assertions),
        }
    }
}

static CONFIG: OnceLock<Config> = OnceLock::new();

pub fn config() -> &'static Config {
    CONFIG.get_or_init(Config::from_env)
}
