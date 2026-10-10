//! Lokalt, genopbyggeligt søgeindeks. Kildeteksterne ændres aldrig (ADR-0044).
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::library::FileHit;
use crate::search::{find_in, Hit, MAX_BYTES, MAX_HITS, MAX_PER_FILE};

pub struct SearchIndex {
    conn: Mutex<Connection>,
    dirty: Mutex<HashMap<String, u64>>,
}

impl SearchIndex {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::from_connection(Connection::open(path)?)
    }

    fn from_connection(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS docs (
              id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL,
              size INTEGER NOT NULL, stamp TEXT NOT NULL, body TEXT NOT NULL);
            CREATE VIRTUAL TABLE IF NOT EXISTS terms USING fts5(
              body, content='docs', content_rowid='id', tokenize='trigram');
            CREATE TRIGGER IF NOT EXISTS docs_insert AFTER INSERT ON docs BEGIN
              INSERT INTO terms(rowid,body) VALUES(new.id,new.body); END;
            CREATE TRIGGER IF NOT EXISTS docs_delete AFTER DELETE ON docs BEGIN
              INSERT INTO terms(terms,rowid,body) VALUES('delete',old.id,old.body); END;
            CREATE TRIGGER IF NOT EXISTS docs_update AFTER UPDATE ON docs BEGIN
              INSERT INTO terms(terms,rowid,body) VALUES('delete',old.id,old.body);
              INSERT INTO terms(rowid,body) VALUES(new.id,new.body); END;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            dirty: Mutex::new(HashMap::new()),
        })
    }

    pub fn invalidate(&self, path: &Path) {
        if let Ok(mut dirty) = self.dirty.lock() {
            let entry = dirty
                .entry(path.to_string_lossy().into_owned())
                .or_default();
            *entry = entry.wrapping_add(1);
        }
    }

    /// Synkronisér stempler, ikke hele tekster. Returnér antal genlæste filer til måling.
    pub fn sync(&self, files: &[FileHit], stale: &dyn Fn() -> bool) -> rusqlite::Result<usize> {
        if stale() {
            return Ok(0);
        }
        let dirty = self.dirty.lock().map(|d| d.clone()).unwrap_or_default();
        let conn = self
            .conn
            .lock()
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        let tx = conn.unchecked_transaction()?;
        let mut read = 0;
        let allowed: HashSet<&str> = files
            .iter()
            .filter(|f| eligible(f))
            .map(|f| f.path.as_str())
            .collect();
        let paths: Vec<String> = {
            let mut stmt = tx.prepare("SELECT path FROM docs")?;
            let paths = stmt
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            paths
        };
        for path in paths {
            if !allowed.contains(path.as_str()) {
                tx.execute("DELETE FROM docs WHERE path=?1", [&path])?;
            }
        }
        for file in files.iter().filter(|f| eligible(f)) {
            if stale() {
                return Ok(read);
            } // Transaktionen rulles tilbage ved drop.
            let path = Path::new(&file.path);
            let Some((size, stamp)) = fingerprint(path) else {
                tx.execute("DELETE FROM docs WHERE path=?1", [&file.path])?;
                continue;
            };
            let previous: Option<(i64, String)> = tx
                .query_row(
                    "SELECT size,stamp FROM docs WHERE path=?1",
                    [&file.path],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if !dirty.contains_key(&file.path) && previous == Some((size as i64, stamp.clone())) {
                continue;
            }
            read += 1;
            let Some(body) = read_text(path) else {
                tx.execute("DELETE FROM docs WHERE path=?1", [&file.path])?;
                continue;
            };
            // En fil, som skifter under læsning, genlæses ved næste søgning.
            if fingerprint(path) != Some((size, stamp.clone())) {
                tx.execute("DELETE FROM docs WHERE path=?1", [&file.path])?;
                continue;
            }
            tx.execute("INSERT INTO docs(path,size,stamp,body) VALUES(?1,?2,?3,?4)
                ON CONFLICT(path) DO UPDATE SET size=excluded.size,stamp=excluded.stamp,body=excluded.body",
                params![file.path, size as i64, stamp, body])?;
        }
        if stale() {
            return Ok(read);
        }
        tx.commit()?;
        if let Ok(mut pending) = self.dirty.lock() {
            for (path, version) in dirty {
                if pending.get(&path) == Some(&version) {
                    pending.remove(&path);
                }
            }
        }
        Ok(read)
    }

    pub fn search(
        &self,
        files: &[FileHit],
        query: &str,
        stale: &dyn Fn() -> bool,
    ) -> rusqlite::Result<Vec<Hit>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        let allowed: HashMap<&str, &FileHit> = files
            .iter()
            .filter(|f| eligible(f))
            .map(|f| (f.path.as_str(), f))
            .collect();
        // To tegn har ingen trigrammer. De søges i indeksets tekst uden at åbne kilderne.
        let long = query.chars().count() >= 3;
        let mut stmt = conn.prepare(if long {
            "SELECT docs.path,docs.body FROM terms JOIN docs ON docs.id=terms.rowid WHERE terms MATCH ?1 ORDER BY docs.path COLLATE NOCASE"
        } else { "SELECT path,body FROM docs ORDER BY path COLLATE NOCASE" })?;
        let phrase = format!("\"{}\"", query.replace('"', "\"\""));
        let mut rows = if long {
            stmt.query([phrase])?
        } else {
            stmt.query([])?
        };
        let mut found = Vec::new();
        while let Some(row) = rows.next()? {
            if stale() {
                return Ok(Vec::new());
            }
            let path: String = row.get(0)?;
            let Some(file) = allowed.get(path.as_str()) else {
                continue;
            };
            let body: String = row.get(1)?;
            let hits =
                find_in(&body, query, MAX_PER_FILE)
                    .into_iter()
                    .map(|(pos, snippet, at, len)| Hit {
                        path: path.clone(),
                        name: file.name.clone(),
                        folder: file.folder.clone(),
                        snippet,
                        at,
                        len,
                        pos,
                    });
            found.extend(hits);
            if found.len() >= MAX_HITS {
                break;
            }
        }
        found.truncate(MAX_HITS);
        Ok(found)
    }
}

fn eligible(file: &FileHit) -> bool {
    !file.dimmed
        && Path::new(&file.path).extension().is_some_and(|e| {
            matches!(
                e.to_string_lossy().to_ascii_lowercase().as_str(),
                "md" | "markdown" | "txt"
            )
        })
}

fn fingerprint(path: &Path) -> Option<(u64, String)> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    let nanos = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((meta.len(), nanos.to_string()))
}

fn read_text(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    let (text, _) = crate::files::decode(&bytes).ok()?;
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    Some(crate::annotations::parse(&normalized, crate::files::Eol::Lf).text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::files_in;

    fn files(dir: &Path) -> Vec<FileHit> {
        files_in(vec![dir.to_path_buf()])
    }

    #[test]
    fn indeks_genbruges_efter_genstart_og_finder_delord_og_korte_soegninger() {
        let dir = tempfile::tempdir().expect("testmappe");
        std::fs::write(dir.path().join("A.md"), "👍\r\nLÆSSEMASKINER: æøå og x\"y.")
            .expect("tekst");
        let path = dir.path().join("search.sqlite");
        let list = files(dir.path());
        {
            let index = SearchIndex::open(&path).expect("indeks");
            assert_eq!(index.sync(&list, &|| false).expect("byg"), 1);
        }
        let index = SearchIndex::open(&path).expect("genåbn");
        assert_eq!(index.sync(&list, &|| false).expect("genbrug"), 0);
        for query in ["maskine", "LÆSSE", "æø", "æøå", "x\"y", "OR", "\""] {
            let hits = index.search(&list, query, &|| false).expect("søg");
            assert_eq!(
                hits,
                crate::search::search_files(&list, query, &|| false),
                "{query}"
            );
        }
    }

    #[test]
    fn aendrede_slettede_og_fjernede_biblioteker_opdateres() {
        let dir = tempfile::tempdir().expect("testmappe");
        let path = dir.path().join("A.md");
        std::fs::write(&path, "gammel").expect("tekst");
        let index = SearchIndex::from_connection(Connection::open_in_memory().expect("db"))
            .expect("indeks");
        let list = files(dir.path());
        index.sync(&list, &|| false).expect("byg");
        std::fs::write(&path, "ny tekst").expect("rettelse");
        assert_eq!(index.sync(&list, &|| false).expect("opdater"), 1);
        assert!(index
            .search(&list, "gammel", &|| false)
            .expect("søg")
            .is_empty());
        assert_eq!(
            index.search(&list, "tekst", &|| false).expect("søg").len(),
            1
        );
        std::fs::remove_file(&path).expect("slet");
        index.sync(&list, &|| false).expect("opdater");
        assert!(index
            .search(&list, "tekst", &|| false)
            .expect("søg")
            .is_empty());
        std::fs::write(&path, "ny tekst").expect("tekst");
        index.sync(&list, &|| false).expect("opdater");
        index.sync(&[], &|| false).expect("fjern bibliotek");
        assert!(index
            .search(&list, "tekst", &|| false)
            .expect("søg")
            .is_empty());
    }

    #[test]
    fn haendelse_genlaeser_filen_selv_med_samme_stoerrelse_og_tid() {
        let dir = tempfile::tempdir().expect("testmappe");
        let path = dir.path().join("A.md");
        std::fs::write(&path, "gammel").expect("tekst");
        let modified = std::fs::metadata(&path)
            .expect("metadata")
            .modified()
            .expect("tid");
        let index = SearchIndex::from_connection(Connection::open_in_memory().expect("db"))
            .expect("indeks");
        let list = files(dir.path());
        index.sync(&list, &|| false).expect("byg");
        std::fs::write(&path, "nyere!").expect("rettelse");
        std::fs::File::options()
            .write(true)
            .open(&path)
            .expect("fil")
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .expect("tid");
        index.invalidate(&path);
        assert_eq!(index.sync(&list, &|| false).expect("opdater"), 1);
        assert_eq!(
            index.search(&list, "nyere", &|| false).expect("søg").len(),
            1
        );
    }

    #[test]
    fn store_og_beskadigede_filer_springes_over_og_utf16_laeses() {
        let dir = tempfile::tempdir().expect("testmappe");
        let mut utf16 = vec![0xff, 0xfe];
        utf16.extend("Dansk æøå".encode_utf16().flat_map(u16::to_le_bytes));
        std::fs::write(dir.path().join("A.md"), utf16).expect("utf16");
        std::fs::write(dir.path().join("B.md"), [0xef, 0xbb, 0xbf, 0xff]).expect("beskadiget");
        let big = std::fs::File::create(dir.path().join("C.md")).expect("stor fil");
        big.set_len(MAX_BYTES + 1).expect("størrelse");
        let index = SearchIndex::from_connection(Connection::open_in_memory().expect("db"))
            .expect("indeks");
        let list = files(dir.path());
        index.sync(&list, &|| false).expect("byg");
        assert_eq!(index.search(&list, "æøå", &|| false).expect("søg").len(), 1);
        let conn = index.conn.lock().expect("lås");
        let count: i64 = conn
            .query_row("SELECT count(*) FROM docs", [], |r| r.get(0))
            .expect("antal");
        assert_eq!(count, 1);
    }

    #[test]
    fn afbrudt_synkronisering_rulles_tilbage() {
        let dir = tempfile::tempdir().expect("testmappe");
        std::fs::write(dir.path().join("A.md"), "bevar mig").expect("tekst");
        let index = SearchIndex::from_connection(Connection::open_in_memory().expect("db"))
            .expect("indeks");
        let list = files(dir.path());
        index.sync(&list, &|| false).expect("byg");
        index.sync(&list, &|| true).expect("afbryd");
        assert_eq!(
            index.search(&list, "bevar", &|| false).expect("søg").len(),
            1
        );
        assert!(index
            .search(&list, "bevar", &|| true)
            .expect("afbrudt søgning")
            .is_empty());
    }

    #[test]
    #[ignore = "særskilt ydelsesmåling på syntetiske filer"]
    fn maal_soegeindeks() {
        let dir = tempfile::tempdir().expect("testmappe");
        let body = "En syntetisk sætning med ord til test.\n".repeat(600);
        for i in 0..500 {
            std::fs::write(dir.path().join(format!("tekst-{i:04}.md")), &body).expect("tekst");
        }
        let list = files(dir.path());
        let path = dir.path().join("search.sqlite");
        let start = std::time::Instant::now();
        let index = SearchIndex::open(&path).expect("db");
        index.sync(&list, &|| false).expect("byg");
        println!(
            "Første indeks: {:?}, {} bytes",
            start.elapsed(),
            body.len() * list.len()
        );
        drop(index);
        let index = SearchIndex::open(&path).expect("genstart");
        let start = std::time::Instant::now();
        assert_eq!(index.sync(&list, &|| false).expect("genbrug"), 0);
        let hits = index.search(&list, "syntetisk", &|| false).expect("søg");
        println!(
            "Efter genstart: {:?}, {} fund, 0 kildetekster genlæst",
            start.elapsed(),
            hits.len()
        );
        assert_eq!(hits.len(), MAX_HITS);
    }
}
