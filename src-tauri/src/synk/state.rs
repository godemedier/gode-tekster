//! Enhedens hukommelse om synken (`<data>/synk.sqlite`):
//!
//! - `base`: det, enheden og serveren sidst var enige om pr. fil (revision og hash). Det er
//!   basen i hver beslutning og i hver fletning (Dropbox' »Synced Tree«).
//! - `remote`: serverens udgave, som ændringsfeedet sidst viste den.
//! - `cache`: filens hash ud fra størrelse og mtime, så en uændret fil ikke læses igen.
//! - `meta`: løbenummeret, enhedens id og navn.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use synk_kerne::protokol::Entry;

/// Den udgave, enheden og serveren sidst var enige om.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Base {
    pub path: String,
    pub rev: u64,
    pub hash: Option<String>,
}

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS base(key TEXT PRIMARY KEY, path TEXT NOT NULL,
      rev INTEGER NOT NULL, hash TEXT);
    CREATE TABLE IF NOT EXISTS remote(key TEXT PRIMARY KEY, path TEXT NOT NULL,
      rev INTEGER NOT NULL, hash TEXT, size INTEGER NOT NULL, device TEXT NOT NULL,
      seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, size INTEGER NOT NULL,
      mtime_ns INTEGER NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);";

pub struct State {
    db: Connection,
}

type Result<T> = std::result::Result<T, String>;

fn err(e: rusqlite::Error) -> String {
    format!("Synkens database: {e}")
}

impl State {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path).map_err(err)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(err)?;
        db.execute_batch("PRAGMA journal_mode = WAL;")
            .map_err(err)?;
        db.execute_batch(SCHEMA).map_err(err)?;
        Ok(State { db })
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        let db = Connection::open_in_memory().map_err(err)?;
        db.execute_batch(SCHEMA).map_err(err)?;
        Ok(State { db })
    }

    pub fn meta(&self, k: &str) -> Result<Option<String>> {
        self.db
            .query_row("SELECT v FROM meta WHERE k = ?1", [k], |r| r.get(0))
            .optional()
            .map_err(err)
    }

    pub fn set_meta(&self, k: &str, v: &str) -> Result<()> {
        self.db
            .execute(
                "INSERT INTO meta(k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2",
                [k, v],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn cursor(&self) -> Result<u64> {
        Ok(self.meta("seq")?.and_then(|s| s.parse().ok()).unwrap_or(0))
    }

    pub fn set_cursor(&self, seq: u64) -> Result<()> {
        self.set_meta("seq", &seq.to_string())
    }

    pub fn bases(&self) -> Result<HashMap<String, Base>> {
        let mut stmt = self
            .db
            .prepare("SELECT key, path, rev, hash FROM base")
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    Base {
                        path: r.get(1)?,
                        rev: r.get::<_, i64>(2)? as u64,
                        hash: r.get(3)?,
                    },
                ))
            })
            .map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    pub fn set_base(&self, key: &str, b: &Base) -> Result<()> {
        self.db
            .execute(
                "INSERT INTO base(key, path, rev, hash) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(key) DO UPDATE SET path = ?2, rev = ?3, hash = ?4",
                params![key, b.path, b.rev as i64, b.hash],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn remotes(&self) -> Result<HashMap<String, Entry>> {
        let mut stmt = self
            .db
            .prepare("SELECT key, path, rev, hash, size, device, seq FROM remote")
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    Entry {
                        path: r.get(1)?,
                        rev: r.get::<_, i64>(2)? as u64,
                        hash: r.get(3)?,
                        size: r.get::<_, i64>(4)? as u64,
                        device: r.get(5)?,
                        seq: r.get::<_, i64>(6)? as u64,
                    },
                ))
            })
            .map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    pub fn set_remote(&self, key: &str, e: &Entry) -> Result<()> {
        self.db
            .execute(
                "INSERT INTO remote(key, path, rev, hash, size, device, seq)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(key) DO UPDATE SET path = ?2, rev = ?3, hash = ?4, size = ?5,
                   device = ?6, seq = ?7
                 WHERE excluded.rev >= remote.rev",
                params![
                    key,
                    e.path,
                    e.rev as i64,
                    e.hash,
                    e.size as i64,
                    e.device,
                    e.seq as i64
                ],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// Den hash, filen havde sidst med samme størrelse og mtime.
    pub fn cached(&self, key: &str, size: u64, mtime_ns: u64) -> Result<Option<String>> {
        self.db
            .query_row(
                "SELECT hash FROM cache WHERE key = ?1 AND size = ?2 AND mtime_ns = ?3",
                params![key, size as i64, mtime_ns as i64],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)
    }

    pub fn set_cached(&self, key: &str, size: u64, mtime_ns: u64, hash: &str) -> Result<()> {
        self.db
            .execute(
                "INSERT INTO cache(key, size, mtime_ns, hash) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(key) DO UPDATE SET size = ?2, mtime_ns = ?3, hash = ?4",
                params![key, size as i64, mtime_ns as i64, hash],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// Alt glemmes, fx når enheden kobles fra serveren. Filerne røres ikke.
    pub fn forget_all(&self) -> Result<()> {
        self.db
            .execute_batch(
                "DELETE FROM base; DELETE FROM remote; DELETE FROM cache; DELETE FROM meta;",
            )
            .map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_gaar_aldrig_baglaens() {
        let s = State::in_memory().unwrap_or_else(|e| panic!("{e}"));
        let e = |rev| Entry {
            path: "a.md".into(),
            rev,
            hash: Some(format!("h{rev}")),
            size: 1,
            device: "pc".into(),
            seq: rev,
        };
        s.set_remote("a.md", &e(3))
            .unwrap_or_else(|e| panic!("{e}"));
        s.set_remote("a.md", &e(2))
            .unwrap_or_else(|e| panic!("{e}"));
        let r = s.remotes().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.get("a.md").map(|e| e.rev), Some(3));
    }
}
