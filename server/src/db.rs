use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension};

/// Schema changes, applied in order. The version is kept in SQLite's
/// user_version.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_baseline.sql"),
    include_str!("../migrations/0002_jobs.sql"),
    include_str!("../migrations/0003_probe_samples.sql"),
    include_str!("../migrations/0004_probe_off_air.sql"),
];

/// How many drizzle migrations the TypeScript app had when the baseline was
/// taken. A database it left at this point already matches the baseline.
const DRIZZLE_BASELINE_COUNT: i64 = 25;

/// The baseline counts as version 25, carrying on from the TypeScript app's
/// numbering, so backups it made (named "v25") still read as the same version.
const BASELINE_VERSION: i64 = DRIZZLE_BASELINE_COUNT;

fn version_after(migration_index: usize) -> i64 {
    BASELINE_VERSION + migration_index as i64
}

pub fn latest_version() -> i64 {
    version_after(MIGRATIONS.len() - 1)
}

/// The one SQLite connection, shared by every request and background job. A
/// single connection means writers queue up instead of failing with
/// SQLITE_BUSY.
#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        if let Some(dir) = path.parent()
            && !dir.as_os_str().is_empty()
        {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        Db::setup(conn)
    }

    pub fn open_in_memory() -> Result<Db> {
        Db::setup(Connection::open_in_memory()?)
    }

    fn setup(mut conn: Connection) -> Result<Db> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // Lets a whole id list go into a query as one parameter, via rarray(?).
        rusqlite::vtab::array::load_module(&conn)?;
        migrate(&mut conn)?;
        recover_interrupted_runs(&conn)?;
        Ok(Db(Arc::new(Mutex::new(conn))))
    }

    /// Run blocking database work off the async runtime.
    pub async fn call<R, F>(&self, f: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<R> + Send + 'static,
    {
        let db = self.clone();
        tokio::task::spawn_blocking(move || f(&mut db.lock()))
            .await
            .context("database task panicked")?
    }

    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        // A panic mid-query can't leave SQLite itself inconsistent, so carry on
        // with the connection rather than taking the whole app down.
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            [name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The schema version of a database, reading databases the TypeScript app
/// left behind as the baseline.
pub fn schema_version(conn: &Connection) -> Result<i64> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version > 0 || !table_exists(conn, "__drizzle_migrations")? {
        return Ok(version);
    }
    let applied: i64 =
        conn.query_row("SELECT count(*) FROM __drizzle_migrations", [], |r| r.get(0))?;
    if applied == DRIZZLE_BASELINE_COUNT {
        return Ok(BASELINE_VERSION);
    }
    bail!(
        "This database is from an older Bouquet ({applied} of {DRIZZLE_BASELINE_COUNT} \
         migrations applied). Upgrade it with the last TypeScript release first."
    )
}

pub fn migrate(conn: &mut Connection) -> Result<()> {
    let current = schema_version(conn)?;
    if current > latest_version() {
        bail!("This database was made by a newer version of Bouquet (schema v{current})");
    }
    conn.pragma_update(None, "user_version", current)?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let version = version_after(i);
        if version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql).with_context(|| format!("upgrading the database to v{version}"))?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}

/// The job queue lives only in memory. If the process died mid-run (say a
/// container restart), its jobs would show as running forever, so close them
/// off on boot.
fn recover_interrupted_runs(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE jobs SET status = 'interrupted', error = 'Interrupted by a restart', \
           finished_at = unixepoch() WHERE status IN ('queued', 'running')",
        [],
    )?;
    // A channel's old result was already wiped when it was queued, so it goes
    // back to never probed.
    conn.execute(
        "UPDATE source_channels SET probe_status = NULL \
         WHERE probe_status IN ('queued', 'probing')",
        [],
    )?;
    Ok(())
}

/// SQLite caps bound variables per statement, so queries by a big list of ids
/// go in batches of this size.
pub const ID_CHUNK: usize = 500;
pub const INSERT_CHUNK: usize = 200;

pub fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

/// An id list to bind as one parameter, for `IN rarray(?)`. That avoids
/// SQLite's cap on bound variables entirely.
pub fn id_array(ids: impl IntoIterator<Item = i64>) -> std::rc::Rc<Vec<rusqlite::types::Value>> {
    std::rc::Rc::new(ids.into_iter().map(rusqlite::types::Value::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_gets_the_baseline() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.lock();
        assert_eq!(schema_version(&conn).unwrap(), latest_version());
        assert!(table_exists(&conn, "playlist_channels").unwrap());
    }

    #[test]
    fn drizzle_database_at_the_baseline_is_adopted() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.execute_batch(
            "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
        )
        .unwrap();
        for i in 0..DRIZZLE_BASELINE_COUNT {
            conn.execute(
                "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('x', ?)",
                [i],
            )
            .unwrap();
        }
        migrate(&mut conn).unwrap();
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(version, latest_version());
    }

    #[test]
    fn older_drizzle_database_is_refused() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);
             INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('x', 1);",
        )
        .unwrap();
        assert!(migrate(&mut conn).is_err());
    }
}
