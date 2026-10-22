//! Serverens lager: SQLite med én række pr. fil (`entry`), alle revisioner (`revision`) og
//! indholdet som blobs navngivet efter deres hash (`blobs/ab/abcd…`).
//!
//! Lageret fletter aldrig og overskriver aldrig i stilhed. En commit lykkes kun, når enhedens
//! `base_rev` er den aktuelle revision. Ellers får enheden den aktuelle udgave tilbage og fletter
//! selv (oplægget, »Arkitekturen«). Alle revisioner bevares, så historikken er gratis, og
//! sletninger er gravsten med en revision, så en enhed, der har været offline, ikke genopliver en
//! slettet fil.

use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::protokol::{
    Changes, Commit, CommitResult, DeviceInfo, DeviceToken, Entry, PairingCode, Trashed,
};
use crate::{hash, is_hash, sti, MAX_SIZE};

/// Hvor længe en parringskode gælder.
pub const PAIRING_SECS: i64 = 600;

/// Så længe kan en slettet fil hentes tilbage fra serverens papirkurv (16/10).
pub const TRASH_SECS: i64 = 30 * 86_400;

#[derive(Debug)]
pub enum StoreError {
    Db(String),
    Io(String),
    BadPath(sti::StiFejl),
    BadHash,
    MissingBlob,
    TooLarge,
    /// Forkert indhold i en forespørgsel, med en besked til brugeren.
    Invalid(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Db(e) => write!(f, "databasefejl: {e}"),
            StoreError::Io(e) => write!(f, "filfejl: {e}"),
            StoreError::BadPath(e) => write!(f, "{e}"),
            StoreError::BadHash => write!(f, "indholdet passer ikke til sin hash"),
            StoreError::MissingBlob => write!(f, "indholdet er ikke lagt op endnu"),
            StoreError::TooLarge => write!(f, "filen er for stor"),
            StoreError::Invalid(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Db(e.to_string())
    }
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub struct Store {
    db: Mutex<Connection>,
    blobs: PathBuf,
}

pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

pub(crate) fn random_hex(bytes: usize) -> Result<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| StoreError::Io(e.to_string()))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn entry_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        path: row.get(0)?,
        rev: row.get::<_, i64>(1)? as u64,
        hash: row.get(2)?,
        size: row.get::<_, i64>(3)? as u64,
        device: row.get(4)?,
        seq: row.get::<_, i64>(5)? as u64,
    })
}

const ENTRY_COLS: &str = "path, rev, hash, size, device, seq";

impl Store {
    /// Åbn (eller opret) lageret i `dir`.
    pub fn open(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir.join("blobs"))?;
        let db = Connection::open(dir.join("synk.sqlite"))?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS entry(
               key TEXT PRIMARY KEY, path TEXT NOT NULL, rev INTEGER NOT NULL, hash TEXT,
               size INTEGER NOT NULL, device TEXT NOT NULL, seq INTEGER NOT NULL UNIQUE,
               at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS revision(
               key TEXT NOT NULL, path TEXT NOT NULL, rev INTEGER NOT NULL, hash TEXT,
               size INTEGER NOT NULL, device TEXT NOT NULL, seq INTEGER NOT NULL UNIQUE,
               at INTEGER NOT NULL, PRIMARY KEY(key, rev));
             CREATE TABLE IF NOT EXISTS device(
               id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
               owner INTEGER NOT NULL, created INTEGER NOT NULL, last_seen INTEGER,
               revoked INTEGER);
             CREATE TABLE IF NOT EXISTS pairing(code TEXT PRIMARY KEY, expires INTEGER NOT NULL);",
        )?;
        let store = Store {
            db: Mutex::new(db),
            blobs: dir.join("blobs"),
        };
        store.create_share_tables()?;
        Ok(store)
    }

    pub(crate) fn db(&self) -> MutexGuard<'_, Connection> {
        // En panik i en anden tråd må ikke låse lageret for altid: forbindelsen er stadig gyldig,
        // fordi hver ændring sker i en transaktion.
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn blob_path(&self, h: &str) -> PathBuf {
        self.blobs.join(&h[..2]).join(h)
    }

    // --- indhold -------------------------------------------------------------------------------

    /// Læg indhold op. Hashen efterprøves, så en fejl på vejen aldrig bliver til en »gyldig« fil.
    pub fn put_blob(&self, h: &str, bytes: &[u8]) -> Result<()> {
        if !is_hash(h) || hash(bytes) != h {
            return Err(StoreError::BadHash);
        }
        if bytes.len() as u64 > MAX_SIZE {
            return Err(StoreError::TooLarge);
        }
        let path = self.blob_path(h);
        if path.exists() {
            return Ok(());
        }
        let dir = path
            .parent()
            .ok_or_else(|| StoreError::Io("ingen mappe".into()))?;
        fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(".{h}.{}.tmp", random_hex(4)?));
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn has_blob(&self, h: &str) -> bool {
        is_hash(h) && self.blob_path(h).is_file()
    }

    pub fn get_blob(&self, h: &str) -> Result<Option<Vec<u8>>> {
        if !is_hash(h) {
            return Err(StoreError::BadHash);
        }
        match fs::read(self.blob_path(h)) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    // --- filer ---------------------------------------------------------------------------------

    /// Skriv en ny revision oven på `c.base_rev`, eller svar med den aktuelle udgave.
    pub fn commit(&self, c: &Commit, device: &str) -> Result<CommitResult> {
        let norm = sti::normalize(&c.path).map_err(StoreError::BadPath)?;
        if let Some(h) = &c.hash {
            if !self.has_blob(h) {
                return Err(if is_hash(h) {
                    StoreError::MissingBlob
                } else {
                    StoreError::BadHash
                });
            }
        }
        let key = sti::key(&norm);
        let mut db = self.db();
        // Igen under låsen: oprydningen (purge) kan have fjernet indholdet siden tjekket ovenfor.
        if let Some(h) = &c.hash {
            if !self.has_blob(h) {
                return Err(StoreError::MissingBlob);
            }
        }
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<Entry> = tx
            .query_row(
                &format!("SELECT {ENTRY_COLS} FROM entry WHERE key = ?1"),
                [&key],
                entry_from,
            )
            .optional()?;
        let cur_rev = current.as_ref().map_or(0, |e| e.rev);
        if c.base_rev != cur_rev {
            return Ok(CommitResult::Conflict { current });
        }
        let gone = current.as_ref().is_none_or(Entry::deleted);
        if c.hash.is_none() && gone {
            // Intet at slette.
            return Ok(CommitResult::Conflict { current });
        }
        if let Some(cur) = &current {
            if cur.hash == c.hash && cur.path == norm {
                // Samme indhold igen, fx et svar, der gik tabt, og et nyt forsøg.
                return Ok(CommitResult::Ok { entry: cur.clone() });
            }
        }
        let seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM revision", [], |r| {
            r.get(0)
        })?;
        let entry = Entry {
            path: norm,
            rev: cur_rev + 1,
            hash: c.hash.clone(),
            size: if c.hash.is_some() { c.size } else { 0 },
            device: device.to_owned(),
            seq: seq as u64,
        };
        let at = now();
        tx.execute(
            "INSERT INTO entry(key, path, rev, hash, size, device, seq, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(key) DO UPDATE SET path = ?2, rev = ?3, hash = ?4, size = ?5,
               device = ?6, seq = ?7, at = ?8",
            params![
                key,
                entry.path,
                entry.rev as i64,
                entry.hash,
                entry.size as i64,
                entry.device,
                seq,
                at
            ],
        )?;
        tx.execute(
            "INSERT INTO revision(key, path, rev, hash, size, device, seq, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                key,
                entry.path,
                entry.rev as i64,
                entry.hash,
                entry.size as i64,
                entry.device,
                seq,
                at
            ],
        )?;
        tx.commit()?;
        Ok(CommitResult::Ok { entry })
    }

    /// Alle filer, der er ændret efter løbenummer `since`, højst `limit` ad gangen.
    pub fn changes(&self, since: u64, limit: usize) -> Result<Changes> {
        let db = self.db();
        let mut stmt = db.prepare(&format!(
            "SELECT {ENTRY_COLS} FROM entry WHERE seq > ?1 ORDER BY seq LIMIT ?2"
        ))?;
        let mut entries: Vec<Entry> = stmt
            .query_map(params![since as i64, limit as i64 + 1], entry_from)?
            .collect::<rusqlite::Result<_>>()?;
        let more = entries.len() > limit;
        entries.truncate(limit);
        let seq = entries.last().map_or(since, |e| e.seq);
        Ok(Changes { entries, seq, more })
    }

    pub fn get(&self, path: &str) -> Result<Option<Entry>> {
        let norm = sti::normalize(path).map_err(StoreError::BadPath)?;
        Ok(self
            .db()
            .query_row(
                &format!("SELECT {ENTRY_COLS} FROM entry WHERE key = ?1"),
                [sti::key(&norm)],
                entry_from,
            )
            .optional()?)
    }

    /// Alle revisioner af en fil, nyeste først.
    pub fn history(&self, path: &str) -> Result<Vec<Entry>> {
        let norm = sti::normalize(path).map_err(StoreError::BadPath)?;
        let db = self.db();
        let mut stmt = db.prepare(&format!(
            "SELECT {ENTRY_COLS} FROM revision WHERE key = ?1 ORDER BY rev DESC"
        ))?;
        let rows = stmt
            .query_map([sti::key(&norm)], entry_from)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    // --- papirkurven ---------------------------------------------------------------------------

    /// Filer slettet inden for de sidste 30 dage, nyeste først, med indholdet fra før sletningen.
    pub fn trash(&self) -> Result<Vec<Trashed>> {
        self.trash_since(now() - TRASH_SECS)
    }

    fn trash_since(&self, cutoff: i64) -> Result<Vec<Trashed>> {
        let db = self.db();
        let mut stmt = db.prepare(
            "SELECT e.path, e.rev, e.device, e.at, r.hash, r.size
             FROM entry e JOIN revision r ON r.key = e.key
             WHERE e.hash IS NULL AND e.at >= ?1 AND r.hash IS NOT NULL
               AND r.rev = (SELECT MAX(rev) FROM revision WHERE key = e.key AND hash IS NOT NULL)
             ORDER BY e.at DESC, e.path",
        )?;
        let rows = stmt
            .query_map([cutoff], |r| {
                Ok(Trashed {
                    path: r.get(0)?,
                    rev: r.get::<_, i64>(1)? as u64,
                    device: r.get(2)?,
                    deleted: r.get(3)?,
                    hash: r.get(4)?,
                    size: r.get::<_, i64>(5)? as u64,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Tøm papirkurven for det, der er ældre end 30 dage: indholdet af filer, der har været slettet
    /// så længe, fjernes, med mindre en levende fil (også en ældre udgave af den) eller en nyere
    /// sletning bruger det samme indhold. Gravstenene bliver, så enhederne stadig ved, at filen er
    /// væk. Returnerer antallet af fjernede blobs.
    pub fn purge(&self) -> Result<usize> {
        self.purge_before(now() - TRASH_SECS)
    }

    fn purge_before(&self, cutoff: i64) -> Result<usize> {
        // Låsen holdes, til filerne er væk. En commit tjekker indholdet igen under den samme lås.
        let mut db = self.db();
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let hashes: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT r.hash FROM revision r JOIN entry e ON e.key = r.key
                 WHERE e.hash IS NULL AND e.at < ?1 AND r.hash IS NOT NULL
                 EXCEPT
                 SELECT r.hash FROM revision r JOIN entry e ON e.key = r.key
                 WHERE (e.hash IS NOT NULL OR e.at >= ?1) AND r.hash IS NOT NULL",
            )?;
            let rows = stmt
                .query_map([cutoff], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            rows
        };
        tx.execute(
            "DELETE FROM revision WHERE hash IS NOT NULL
               AND key IN (SELECT key FROM entry WHERE hash IS NULL AND at < ?1)",
            [cutoff],
        )?;
        tx.commit()?;
        let mut removed = 0;
        for h in &hashes {
            if is_hash(h) && fs::remove_file(self.blob_path(h)).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// Det højeste løbenummer. Til »der er nyt«-beskeden.
    pub fn seq(&self) -> Result<u64> {
        let s: i64 =
            self.db()
                .query_row("SELECT COALESCE(MAX(seq), 0) FROM revision", [], |r| {
                    r.get(0)
                })?;
        Ok(s as u64)
    }

    // --- enheder -------------------------------------------------------------------------------

    /// En ny enhed. Nøglen returneres én gang, kun dens hash gemmes.
    pub fn add_device(&self, name: &str, owner: bool) -> Result<DeviceToken> {
        let id = random_hex(8)?;
        let token = random_hex(32)?;
        let name: String = name.chars().filter(|c| !c.is_control()).take(60).collect();
        self.db().execute(
            "INSERT INTO device(id, name, token_hash, owner, created) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name.trim(), hash(token.as_bytes()), owner, now()],
        )?;
        Ok(DeviceToken { id, token })
    }

    /// Enheden bag en nøgle, hvis den findes og ikke er slået fra. Opdaterer »sidst set«.
    pub fn device_by_token(&self, token: &str) -> Result<Option<DeviceInfo>> {
        let db = self.db();
        let found = db
            .query_row(
                "SELECT id, name, owner, created FROM device
                 WHERE token_hash = ?1 AND revoked IS NULL",
                [hash(token.as_bytes())],
                |r| {
                    Ok(DeviceInfo {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        owner: r.get(2)?,
                        created: r.get(3)?,
                        last_seen: None,
                    })
                },
            )
            .optional()?;
        if let Some(d) = &found {
            db.execute(
                "UPDATE device SET last_seen = ?1 WHERE id = ?2",
                params![now(), d.id],
            )?;
        }
        Ok(found)
    }

    pub fn devices(&self) -> Result<Vec<DeviceInfo>> {
        let db = self.db();
        let mut stmt = db.prepare(
            "SELECT id, name, owner, created, last_seen FROM device
             WHERE revoked IS NULL ORDER BY created",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(DeviceInfo {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    owner: r.get(2)?,
                    created: r.get(3)?,
                    last_seen: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Slå en enhed fra (en mistet telefon). Returnerer, om den fandtes.
    pub fn revoke(&self, id: &str) -> Result<bool> {
        let n = self.db().execute(
            "UPDATE device SET revoked = ?1 WHERE id = ?2 AND revoked IS NULL",
            params![now(), id],
        )?;
        Ok(n == 1)
    }

    /// En engangskode til at parre en ny enhed. Uden tegn, der ligner hinanden (0/O, 1/I/L).
    pub fn new_pairing_code(&self) -> Result<PairingCode> {
        const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
        let mut buf = [0u8; 8];
        getrandom::fill(&mut buf).map_err(|e| StoreError::Io(e.to_string()))?;
        let chars: String = buf
            .iter()
            .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
            .collect();
        let code = format!("{}-{}", &chars[..4], &chars[4..]);
        let expires = now() + PAIRING_SECS;
        let db = self.db();
        db.execute("DELETE FROM pairing WHERE expires < ?1", [now()])?;
        db.execute(
            "INSERT INTO pairing(code, expires) VALUES (?1, ?2)",
            params![code, expires],
        )?;
        Ok(PairingCode { code, expires })
    }

    /// Brug en parringskode. Den virker kun én gang og kun inden for tiden.
    pub fn use_pairing_code(&self, code: &str) -> Result<bool> {
        let code = code.trim().to_uppercase();
        let n = self.db().execute(
            "DELETE FROM pairing WHERE code = ?1 AND expires >= ?2",
            params![code, now()],
        )?;
        Ok(n == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let s = Store::open(dir.path()).unwrap_or_else(|e| panic!("{e}"));
        (dir, s)
    }

    fn put(s: &Store, text: &str) -> String {
        let h = hash(text.as_bytes());
        s.put_blob(&h, text.as_bytes())
            .unwrap_or_else(|e| panic!("{e}"));
        h
    }

    fn commit(s: &Store, path: &str, base: u64, h: Option<&str>) -> CommitResult {
        s.commit(
            &Commit {
                path: path.into(),
                base_rev: base,
                hash: h.map(str::to_owned),
                size: 1,
            },
            "pc",
        )
        .unwrap_or_else(|e| panic!("{e}"))
    }

    fn ok(r: CommitResult) -> Entry {
        match r {
            CommitResult::Ok { entry } => entry,
            other => panic!("ventede ok: {other:?}"),
        }
    }

    #[test]
    fn blob_med_forkert_hash_afvises() {
        let (_d, s) = store();
        let h = hash(b"rigtig");
        assert!(matches!(
            s.put_blob(&h, b"forkert"),
            Err(StoreError::BadHash)
        ));
        assert!(matches!(s.put_blob("../x", b"x"), Err(StoreError::BadHash)));
        assert!(!s.has_blob(&h));
    }

    #[test]
    fn commit_kraever_den_aktuelle_revision() {
        let (_d, s) = store();
        let a = put(&s, "første");
        let b = put(&s, "anden");
        let c = put(&s, "tredje");
        let e1 = ok(commit(&s, "Skriv/a.md", 0, Some(&a)));
        assert_eq!((e1.rev, e1.seq), (1, 1));
        let e2 = ok(commit(&s, "Skriv/a.md", 1, Some(&b)));
        assert_eq!(e2.rev, 2);
        // En anden enhed, der stadig tror, det er revision 1, får den aktuelle tilbage.
        match commit(&s, "Skriv/a.md", 1, Some(&c)) {
            CommitResult::Conflict { current: Some(cur) } => assert_eq!(cur.hash, Some(b)),
            other => panic!("{other:?}"),
        }
        assert_eq!(s.history("Skriv/a.md").map(|h| h.len()).ok(), Some(2));
    }

    #[test]
    fn samme_indhold_igen_giver_ingen_ny_revision() {
        let (_d, s) = store();
        let a = put(&s, "x");
        ok(commit(&s, "a.md", 0, Some(&a)));
        let again = ok(commit(&s, "a.md", 1, Some(&a)));
        assert_eq!(again.rev, 1);
    }

    #[test]
    fn indhold_skal_vaere_lagt_op_foerst() {
        let (_d, s) = store();
        let r = s.commit(
            &Commit {
                path: "a.md".into(),
                base_rev: 0,
                hash: Some(hash(b"ikke lagt op")),
                size: 1,
            },
            "pc",
        );
        assert!(matches!(r, Err(StoreError::MissingBlob)));
    }

    #[test]
    fn sletning_er_en_gravsten_med_revision() {
        let (_d, s) = store();
        let a = put(&s, "x");
        ok(commit(&s, "a.md", 0, Some(&a)));
        let g = ok(commit(&s, "a.md", 1, None));
        assert!(g.deleted());
        assert_eq!(g.rev, 2);
        // At slette det slettede er ingen ændring.
        assert!(matches!(
            commit(&s, "a.md", 2, None),
            CommitResult::Conflict { .. }
        ));
        // En offline enhed med revision 1 kan ikke genoplive filen uden at se gravstenen.
        assert!(matches!(
            commit(&s, "a.md", 1, Some(&a)),
            CommitResult::Conflict { current: Some(_) }
        ));
        // Med gravstenen som base kan den.
        assert_eq!(ok(commit(&s, "a.md", 2, Some(&a))).rev, 3);
    }

    #[test]
    fn store_og_smaa_bogstaver_er_samme_fil() {
        let (_d, s) = store();
        let a = put(&s, "x");
        ok(commit(&s, "Noter.md", 0, Some(&a)));
        assert!(matches!(
            commit(&s, "noter.md", 0, Some(&a)),
            CommitResult::Conflict { current: Some(_) }
        ));
        // Omdøbning af stavemåden er en ny revision med samme indhold.
        let e = ok(commit(&s, "NOTER.md", 1, Some(&a)));
        assert_eq!((e.path.as_str(), e.rev), ("NOTER.md", 2));
    }

    #[test]
    fn ugyldig_sti_afvises() {
        let (_d, s) = store();
        let a = put(&s, "x");
        assert!(matches!(
            s.commit(
                &Commit {
                    path: "a/NUL.md".into(),
                    base_rev: 0,
                    hash: Some(a),
                    size: 1
                },
                "pc"
            ),
            Err(StoreError::BadPath(_))
        ));
    }

    #[test]
    fn aendringer_i_sider() {
        let (_d, s) = store();
        for i in 0..5 {
            let h = put(&s, &format!("tekst {i}"));
            ok(commit(&s, &format!("{i}.md"), 0, Some(&h)));
        }
        let first = s.changes(0, 3).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!((first.entries.len(), first.more, first.seq), (3, true, 3));
        let rest = s.changes(first.seq, 3).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!((rest.entries.len(), rest.more, rest.seq), (2, false, 5));
        let none = s.changes(5, 3).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!((none.entries.len(), none.seq), (0, 5));
    }

    #[test]
    fn enheder_og_parring() {
        let (_d, s) = store();
        let t = s.add_device("Pc", true).unwrap_or_else(|e| panic!("{e}"));
        let d = s
            .device_by_token(&t.token)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(d.map(|d| (d.name, d.owner)), Some(("Pc".into(), true)));
        assert!(s.device_by_token("forkert").ok().flatten().is_none());
        let code = s.new_pairing_code().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(code.code.len(), 9);
        assert!(s
            .use_pairing_code(&code.code.to_lowercase())
            .unwrap_or(false));
        assert!(
            !s.use_pairing_code(&code.code).unwrap_or(true),
            "kun én gang"
        );
        assert!(s.revoke(&t.id).unwrap_or(false));
        assert!(s.device_by_token(&t.token).ok().flatten().is_none());
    }

    #[test]
    fn papirkurven_viser_det_slettede_og_kan_hente_det_tilbage() {
        let (_d, s) = store();
        let a = put(&s, "første");
        let b = put(&s, "anden");
        let e1 = ok(commit(&s, "Noter/a.md", 0, Some(&a)));
        let e2 = ok(commit(&s, "Noter/a.md", e1.rev, Some(&b)));
        let tomb = ok(commit(&s, "Noter/a.md", e2.rev, None));
        ok(commit(&s, "Noter/b.md", 0, Some(&a)));
        let t = s.trash().unwrap_or_default();
        assert_eq!(t.len(), 1);
        assert_eq!(
            (t[0].path.as_str(), t[0].rev, t[0].hash.as_str()),
            ("Noter/a.md", tomb.rev, b.as_str())
        );
        // Tilbage: den sidste udgave oven på gravstenen.
        let back = ok(commit(&s, "Noter/a.md", t[0].rev, Some(&t[0].hash)));
        assert_eq!(back.hash.as_deref(), Some(b.as_str()));
        assert!(s.trash().unwrap_or_default().is_empty());
    }

    #[test]
    fn oprydningen_fjerner_kun_det_ingen_levende_fil_bruger() {
        let (_d, s) = store();
        let only_deleted = put(&s, "kun i den slettede");
        let shared = put(&s, "også i en levende");
        let old = put(&s, "en ældre udgave af en levende");
        let now = put(&s, "den levende nu");
        let e = ok(commit(&s, "a.md", 0, Some(&only_deleted)));
        let e = ok(commit(&s, "a.md", e.rev, Some(&shared)));
        ok(commit(&s, "a.md", e.rev, None));
        ok(commit(&s, "b.md", 0, Some(&shared)));
        let l = ok(commit(&s, "c.md", 0, Some(&old)));
        ok(commit(&s, "c.md", l.rev, Some(&now)));
        // Inden for de 30 dage: intet fjernes.
        assert_eq!(s.purge().ok(), Some(0));
        assert!(s.has_blob(&only_deleted));
        // Efter: kun det, som den slettede fil alene brugte.
        assert_eq!(s.purge_before(super::now() + 1).ok(), Some(1));
        assert!(!s.has_blob(&only_deleted));
        assert!(s.has_blob(&shared) && s.has_blob(&old) && s.has_blob(&now));
        assert!(s.trash_since(0).unwrap_or_default().is_empty());
        // Gravstenen står der stadig, så enhederne ved, at filen er væk.
        assert!(s.get("a.md").ok().flatten().is_some_and(|e| e.deleted()));
        // Og en commit, der peger på det fjernede indhold, afvises.
        assert!(matches!(
            s.commit(
                &Commit {
                    path: "d.md".into(),
                    base_rev: 0,
                    hash: Some(only_deleted.clone()),
                    size: 1
                },
                "pc"
            ),
            Err(StoreError::MissingBlob)
        ));
    }
}
