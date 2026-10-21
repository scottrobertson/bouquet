//! A backup is a gzipped copy of the whole SQLite database. Restoring replaces
//! everything, and the schema upgrades bring an older backup up to date first,
//! so backups keep working across app upgrades.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use regex::Regex;
use rusqlite::Connection;
use serde::Serialize;
use ts_rs::TS;

use crate::db::{self, Db};
use crate::jobs::JobCtx;
use crate::output::cache::invalidate_all;

static FILE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^bouquet-(manual|auto|prerestore)-v(\d+)-(\d{8})-(\d{6})\.db\.gz$").unwrap());
static AUTO_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^bouquet-auto-.*\.db\.gz$").unwrap());

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupInfo {
    pub file: String,
    pub size: u64,
    pub modified_at: String,
    pub valid: bool,
    pub trigger: String,
    pub created_at: Option<String>,
    // Schema version the backup was taken at.
    pub version: Option<i64>,
    // Made by a newer app, so it can't be restored until this one is upgraded.
    pub is_newer_than_app: bool,
}

pub struct Backups {
    pub dir: PathBuf,
}

fn sql_literal(p: &Path) -> String {
    p.to_string_lossy().replace('\'', "''")
}

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl Backups {
    fn ensure_dir(&self) -> Result<()> {
        std::fs::create_dir_all(&self.dir).with_context(|| format!("creating {}", self.dir.display()))
    }

    /// A plain file inside the backups folder. Only the file name is used, so a
    /// caller can't reach outside the folder.
    fn resolve_inside(&self, file: &str) -> Result<PathBuf> {
        let name = Path::new(file).file_name().ok_or_else(|| anyhow!("Invalid backup filename"))?;
        if name == "." || name == ".." {
            bail!("Invalid backup filename");
        }
        Ok(self.dir.join(name))
    }

    /// Write a gzipped snapshot of the whole database.
    pub fn create(&self, conn: &Connection, trigger: &str) -> Result<(String, i64)> {
        self.ensure_dir()?;
        let version = db::schema_version(conn)?;
        let file = format!("bouquet-{trigger}-v{version}-{}.db.gz", Local::now().format("%Y%m%d-%H%M%S"));
        // VACUUM INTO writes a clean, consistent single file with the WAL folded in.
        let tmp = self.dir.join(format!(".tmp-{file}.db"));
        let _ = std::fs::remove_file(&tmp);
        conn.execute_batch(&format!("VACUUM INTO '{}'", sql_literal(&tmp)))?;
        let raw = std::fs::read(&tmp)?;
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&raw)?;
        std::fs::write(self.dir.join(&file), gz.finish()?)?;
        std::fs::remove_file(&tmp)?;
        Ok((file, version))
    }

    /// Backups newest first. Our own files are recognised by name; anything
    /// else is flagged so it can still be deleted.
    pub fn list(&self, conn: &Connection) -> Result<Vec<BackupInfo>> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Ok(vec![]) };
        let current = db::schema_version(conn)?;
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            if file.starts_with('.') || !(file.ends_with(".db.gz") || file.ends_with(".json")) {
                continue;
            }
            let meta = entry.metadata()?;
            let modified: DateTime<Utc> = meta.modified()?.into();
            let caps = FILE_RE.captures(&file);
            let version = caps.as_ref().and_then(|c| c[2].parse::<i64>().ok());
            let created_at = caps.as_ref().and_then(|c| {
                let naive = NaiveDateTime::parse_from_str(&format!("{}{}", &c[3], &c[4]), "%Y%m%d%H%M%S").ok()?;
                Local.from_local_datetime(&naive).earliest().map(|t| iso(t.with_timezone(&Utc)))
            });
            out.push(BackupInfo {
                size: meta.len(),
                modified_at: iso(modified),
                valid: caps.is_some(),
                trigger: caps.as_ref().map(|c| c[1].to_string()).unwrap_or_else(|| "unknown".into()),
                created_at,
                version,
                is_newer_than_app: version.is_some_and(|v| v > current),
                file,
            });
        }
        out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        Ok(out)
    }

    /// Replace all data with a backup's. Takes a safety backup first and brings
    /// the backup's schema up to date, then copies every table across in one
    /// transaction.
    pub fn restore(&self, conn: &mut Connection, file: &str) -> Result<String> {
        let full = self.resolve_inside(file)?;
        if !full.exists() {
            bail!("Backup not found");
        }
        if !file.ends_with(".db.gz") {
            bail!("That file is not a Bouquet backup");
        }
        let tmp = self.dir.join(".tmp-restore.db");
        let _ = std::fs::remove_file(&tmp);
        let mut raw = Vec::new();
        std::fs::File::open(&full)
            .and_then(|f| GzDecoder::new(f).read_to_end(&mut raw))
            .map_err(|_| anyhow!("That backup could not be read"))?;
        std::fs::write(&tmp, raw)?;

        let result = self.restore_from(conn, &tmp);
        let _ = std::fs::remove_file(&tmp);
        let safety = result?;
        invalidate_all();
        Ok(safety)
    }

    fn restore_from(&self, conn: &mut Connection, tmp: &Path) -> Result<String> {
        {
            let mut backup = Connection::open(tmp)?;
            let is_bouquet = backup
                .query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'playlists'", [], |r| {
                    r.get::<_, i64>(0)
                })
                .map(|n| n > 0)
                .unwrap_or(false);
            if !is_bouquet {
                bail!("That file is not a Bouquet backup");
            }
            let backup_version = db::schema_version(&backup).map_err(|_| {
                anyhow!(
                    "This backup is from an older version of Bouquet that this one can't upgrade. Restore it with \
                     the last TypeScript release of Bouquet, then take a new backup."
                )
            })?;
            let current = db::schema_version(conn)?;
            if backup_version > current {
                bail!(
                    "This backup is from a newer version of Bouquet (schema {backup_version}, this app is {current}). \
                     Update the app, then restore."
                );
            }
            // Bring an older backup up to this schema so the copy below lines up.
            db::migrate(&mut backup)?;
        }

        let (safety, _) = self.create(conn, "prerestore")?;

        // Job history is about this server, not the data, so it stays as it is.
        let tables: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
                 AND name NOT IN ('__drizzle_migrations', 'jobs', 'job_logs')",
            )?;
            stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
        };
        // Foreign keys off for the wipe and copy, so table order doesn't matter.
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        conn.execute_batch(&format!("ATTACH DATABASE '{}' AS restore", sql_literal(tmp)))?;
        let copied = (|| -> Result<()> {
            let tx = conn.transaction()?;
            for t in &tables {
                tx.execute(&format!("DELETE FROM main.\"{t}\""), [])?;
            }
            for t in &tables {
                tx.execute(&format!("INSERT INTO main.\"{t}\" SELECT * FROM restore.\"{t}\""), [])?;
            }
            // Jobs whose source or playlist isn't in the backup lose their link.
            // The titles still say what they were.
            tx.execute_batch(
                "UPDATE jobs SET source_id = NULL WHERE source_id NOT IN (SELECT id FROM sources);
                 UPDATE jobs SET playlist_id = NULL WHERE playlist_id NOT IN (SELECT id FROM playlists);
                 UPDATE jobs SET destination_id = NULL WHERE destination_id NOT IN (SELECT id FROM upload_destinations);",
            )?;
            tx.commit()?;
            Ok(())
        })();
        conn.execute_batch("DETACH DATABASE restore")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        copied?;
        Ok(safety)
    }

    pub fn delete(&self, file: &str) -> Result<()> {
        Ok(std::fs::remove_file(self.resolve_inside(file)?)?)
    }

    /// A backup's raw bytes for download.
    pub fn read(&self, file: &str) -> Result<(String, Vec<u8>)> {
        let full = self.resolve_inside(file)?;
        if !full.exists() {
            bail!("Backup not found");
        }
        let name = full.file_name().unwrap().to_string_lossy().into_owned();
        Ok((name, std::fs::read(full)?))
    }

    /// Keep only the newest `keep` automatic backups. Manual, pre-restore and
    /// hand-dropped files are never touched.
    pub fn prune_auto(&self, keep: usize) -> Result<()> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Ok(()) };
        let mut autos: Vec<(std::time::SystemTime, PathBuf)> = entries
            .flatten()
            .filter(|e| AUTO_RE.is_match(&e.file_name().to_string_lossy()))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        autos.sort_by_key(|a| std::cmp::Reverse(a.0));
        for (_, path) in autos.into_iter().skip(keep) {
            std::fs::remove_file(path)?;
        }
        Ok(())
    }
}

pub fn backups() -> Backups {
    Backups { dir: crate::config::config().backups_path.clone() }
}

/// The scheduled backup job.
pub async fn auto_backup(db: &Db, ctx: &JobCtx) -> Result<()> {
    ctx.step("Backing up").await;
    let file = db
        .call(|conn| {
            let b = backups();
            let (file, _) = b.create(conn, "auto")?;
            b.prune_auto(crate::config::config().backup_keep)?;
            Ok(file)
        })
        .await?;
    ctx.summary(format!("Saved {file}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;

    fn setup() -> (tempfile::TempDir, Db, Backups) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("bouquet.db")).unwrap();
        let backups = Backups { dir: dir.path().join("backups") };
        (dir, db, backups)
    }

    fn playlist_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT name FROM playlists ORDER BY id").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    #[test]
    fn restores_the_whole_database() {
        let (_dir, db, backups) = setup();
        let mut conn = db.lock();
        test_support::source(&conn, "Main");
        test_support::playlist(&conn, "Keep me", "tok-keep");
        let (file, version) = backups.create(&conn, "manual").unwrap();
        assert_eq!(version, db::latest_version());
        assert!(backups.dir.join(&file).exists());

        conn.execute("DELETE FROM playlists", []).unwrap();
        test_support::playlist(&conn, "Different", "tok-diff");
        conn.execute("INSERT INTO jobs (kind, trigger, title, created_at) VALUES ('sync', 'manual', 'Sync Main', 1)", [])
            .unwrap();
        backups.restore(&mut conn, &file).unwrap();

        assert_eq!(playlist_names(&conn), ["Keep me"]);
        let n: i64 = conn.query_row("SELECT count(*) FROM sources", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // Job history belongs to this server, so a restore leaves it alone.
        let jobs: i64 = conn.query_row("SELECT count(*) FROM jobs", [], |r| r.get(0)).unwrap();
        assert_eq!(jobs, 1);
    }

    #[test]
    fn lists_a_created_backup() {
        let (_dir, db, backups) = setup();
        let conn = db.lock();
        let (file, version) = backups.create(&conn, "manual").unwrap();
        let info = backups.list(&conn).unwrap().into_iter().find(|b| b.file == file).unwrap();
        assert!(info.valid);
        assert_eq!(info.trigger, "manual");
        assert_eq!(info.version, Some(version));
        assert!(!info.is_newer_than_app);
        assert!(info.created_at.is_some());
    }

    #[test]
    fn refuses_a_backup_from_a_newer_schema() {
        let (_dir, db, backups) = setup();
        let mut conn = db.lock();
        let (file, _) = backups.create(&conn, "manual").unwrap();

        let mut raw = Vec::new();
        GzDecoder::new(std::fs::File::open(backups.dir.join(&file)).unwrap()).read_to_end(&mut raw).unwrap();
        let forge = backups.dir.join("forge.db");
        std::fs::write(&forge, raw).unwrap();
        Connection::open(&forge).unwrap().pragma_update(None, "user_version", 999).unwrap();
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&std::fs::read(&forge).unwrap()).unwrap();
        let newer = "bouquet-manual-v999-20990101-000000.db.gz";
        std::fs::write(backups.dir.join(newer), gz.finish().unwrap()).unwrap();

        let err = backups.restore(&mut conn, newer).unwrap_err().to_string();
        assert!(err.to_lowercase().contains("newer version"), "{err}");
        assert!(backups.list(&conn).unwrap().iter().any(|b| b.file == newer && b.is_newer_than_app));
    }

    #[test]
    fn restores_a_backup_made_by_the_typescript_app() {
        let (_dir, db, backups) = setup();
        let mut conn = db.lock();
        // What the TypeScript app wrote: the same tables plus drizzle's own
        // bookkeeping, at its 25th migration, with user_version left at 0.
        let old = backups.dir.join("old.db");
        std::fs::create_dir_all(&backups.dir).unwrap();
        {
            let c = Connection::open(&old).unwrap();
            c.execute_batch(include_str!("../migrations/0001_baseline.sql")).unwrap();
            c.execute_batch("CREATE TABLE \"__drizzle_migrations\" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)").unwrap();
            for i in 0..25 {
                c.execute("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('x', ?)", [i]).unwrap();
            }
            c.execute("INSERT INTO playlists (name, output_token) VALUES ('From TS', 'tok')", []).unwrap();
        }
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&std::fs::read(&old).unwrap()).unwrap();
        let file = "bouquet-auto-v25-20260101-030000.db.gz";
        std::fs::write(backups.dir.join(file), gz.finish().unwrap()).unwrap();

        assert!(!backups.list(&conn).unwrap().iter().find(|b| b.file == file).unwrap().is_newer_than_app);
        backups.restore(&mut conn, file).unwrap();
        assert_eq!(playlist_names(&conn), ["From TS"]);
    }

    #[test]
    fn refuses_a_backup_older_than_the_baseline() {
        let (_dir, db, backups) = setup();
        let mut conn = db.lock();
        std::fs::create_dir_all(&backups.dir).unwrap();
        let old = backups.dir.join("old.db");
        {
            let c = Connection::open(&old).unwrap();
            c.execute_batch(
                "CREATE TABLE playlists (id integer PRIMARY KEY); \
                 CREATE TABLE \"__drizzle_migrations\" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric); \
                 INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('x', 1);",
            )
            .unwrap();
        }
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&std::fs::read(&old).unwrap()).unwrap();
        let file = "bouquet-manual-v23-20260912-193000.db.gz";
        std::fs::write(backups.dir.join(file), gz.finish().unwrap()).unwrap();
        let err = backups.restore(&mut conn, file).unwrap_err().to_string();
        assert!(err.contains("older version"), "{err}");
    }

    #[test]
    fn prunes_only_auto_backups() {
        let (_dir, db, backups) = setup();
        let conn = db.lock();
        std::fs::create_dir_all(&backups.dir).unwrap();
        for name in ["bouquet-auto-v25-20260101-000000.db.gz", "bouquet-auto-v25-20260102-000000.db.gz", "bouquet-manual-v25-20260101-000000.db.gz"] {
            std::fs::write(backups.dir.join(name), b"x").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        backups.prune_auto(1).unwrap();
        let mut left: Vec<String> = backups.list(&conn).unwrap().into_iter().map(|b| b.file).collect();
        left.sort();
        assert_eq!(left, ["bouquet-auto-v25-20260102-000000.db.gz", "bouquet-manual-v25-20260101-000000.db.gz"]);
        assert!(backups.read("../bouquet.db").is_err());
    }
}
