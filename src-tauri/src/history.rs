//! Versionshistorik (ADR-0009, plan 2-9 del C): én SQLite-fil i `<data>\historik.sqlite`. Hele
//! tekster, komprimeret med zstd og gemt én gang pr. indhold (blake3). Hver version har kilde og
//! forfatterskab, så en gendannelse også får forfatterskabet tilbage.
//!
//! En version pr. arbejdssession: gem inden for 10 minutter fra samme kilde lægges sammen.
//! Versioner fra forskellige kilder slås aldrig sammen (VS Codes regel). Udtynding: alt fra 24
//! timer, én pr. time i 14 dage, én pr. dag i 90 dage, derefter én pr. uge. Eksterne og navngivne
//! versioner udtyndes aldrig.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::annotations::Authorship;

pub const SESSION_MS: i64 = 10 * 60 * 1000;
const DAY: i64 = 24 * 60 * 60 * 1000;

pub struct History {
    conn: Mutex<Connection>,
    /// Hvornår der sidst blev udtyndet. Programmet lever i bakken i ugevis (ADR-0014), så det
    /// sker også undervejs, ikke kun ved start (performance-review 2/10).
    last_thin: Mutex<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub id: i64,
    pub ts: i64,
    /// `app`, `external`, `restore` eller `first`.
    pub source: String,
    pub label: Option<String>,
    pub chars: i64,
    /// Hvad der er ændret siden versionen før (9/10). `None` for den første.
    pub summary: Option<Summary>,
}

/// »Hvad koster det?« og »+84 nye ord, 12 fjernet« i fanen Versioner (9/10: »Skrevet« sagde intet).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    /// Den nærmeste overskrift over den første ændring, ellers afsnittets første ord.
    pub place: String,
    pub added: u32,
    pub removed: u32,
}

pub struct Version {
    pub text: String,
    pub authors: Vec<Authorship>,
}

/// En forgiftet lås (en tråd gik ned med den) siges, som det er, ikke som »ugyldig forespørgsel«.
fn locked() -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(t!(
        "historikken er låst efter en fejl",
        "version history is locked after an error"
    ))))
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl History {
    pub fn open(file: &Path) -> rusqlite::Result<Self> {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(file)?;
        Self::init(&conn)?;
        Ok(History {
            conn: Mutex::new(conn),
            last_thin: Mutex::new(0),
        })
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        Self::init(&conn).unwrap();
        History {
            conn: Mutex::new(conn),
            last_thin: Mutex::new(0),
        }
    }

    fn init(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS file(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL);
             CREATE TABLE IF NOT EXISTS blob(hash TEXT PRIMARY KEY, zdata BLOB NOT NULL, raw_len INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS version(
               id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, ts INTEGER NOT NULL, hash TEXT NOT NULL,
               source TEXT NOT NULL, authors TEXT NOT NULL, label TEXT, pinned INTEGER NOT NULL DEFAULT 0);
             CREATE INDEX IF NOT EXISTS v_file_ts ON version(file_id, ts);
             CREATE INDEX IF NOT EXISTS v_hash ON version(hash);",
        )?;
        // Beskrivelsen kom til 9/10. Ældre filer får kolonnen, og listen regner de manglende ud.
        let has: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('version') WHERE name = 'summary'")?
            .exists([])?;
        if !has {
            conn.execute_batch("ALTER TABLE version ADD COLUMN summary TEXT;")?;
        }
        Ok(())
    }

    /// Teksten i den version, der ligger før `(ts, id)` for samme fil.
    fn text_before(
        conn: &Connection,
        fid: i64,
        ts: i64,
        id: i64,
    ) -> rusqlite::Result<Option<String>> {
        let hash: Option<(String, String)> = conn
            .query_row(
                "SELECT hash, authors FROM version WHERE file_id = ?1 AND (ts < ?2 OR (ts = ?2 AND id < ?3))
                 ORDER BY ts DESC, id DESC LIMIT 1",
                params![fid, ts, id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match hash {
            Some((h, a)) => Self::read(conn, &h, a).map(|v| Some(v.text)),
            None => Ok(None),
        }
    }

    fn file_id(conn: &Connection, path: &str) -> rusqlite::Result<i64> {
        let key = path.to_lowercase();
        conn.execute("INSERT OR IGNORE INTO file(path) VALUES (?1)", params![key])?;
        conn.query_row("SELECT id FROM file WHERE path = ?1", params![key], |r| {
            r.get(0)
        })
    }

    fn put_blob(conn: &Connection, text: &str) -> rusqlite::Result<String> {
        let hash = blake3::hash(text.as_bytes()).to_hex().to_string();
        let exists: Option<i64> = conn
            .query_row("SELECT 1 FROM blob WHERE hash = ?1", params![hash], |r| {
                r.get(0)
            })
            .optional()?;
        if exists.is_none() {
            let z =
                zstd::encode_all(text.as_bytes(), 3).unwrap_or_else(|_| text.as_bytes().to_vec());
            conn.execute(
                "INSERT INTO blob(hash, zdata, raw_len) VALUES (?1, ?2, ?3)",
                params![hash, z, text.len() as i64],
            )?;
        }
        Ok(hash)
    }

    /// Gemmer en version. Samme kilde inden for en arbejdssession lægges sammen med den forrige.
    pub fn record(
        &self,
        path: &str,
        text: &str,
        authors: &[Authorship],
        source: &str,
        at: i64,
    ) -> rusqlite::Result<i64> {
        let conn = self.conn()?;
        let fid = Self::file_id(&conn, path)?;
        let hash = Self::put_blob(&conn, text)?;
        let authors_json = serde_json::to_string(authors).unwrap_or_else(|_| "[]".to_owned());
        let last: Option<(i64, i64, String, String, i64)> = conn
            .query_row(
                "SELECT id, ts, source, hash, pinned FROM version WHERE file_id = ?1 ORDER BY ts DESC, id DESC LIMIT 1",
                params![fid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        if let Some((id, ts, src, h, pinned)) = last.clone() {
            if h == hash {
                return Ok(id);
            }
            if src == source && source == "app" && pinned == 0 && at - ts < SESSION_MS {
                // Lagt sammen med den forrige: beskrivelsen regnes fra versionen før den.
                let summary = Self::text_before(&conn, fid, ts, id)?
                    .map(|old| describe(&old, text))
                    .and_then(|s| serde_json::to_string(&s).ok());
                conn.execute(
                    "UPDATE version SET ts = ?1, hash = ?2, authors = ?3, summary = ?4 WHERE id = ?5",
                    params![at, hash, authors_json, summary, id],
                )?;
                // Kun den erstattede tekst kan være blevet forældreløs.
                conn.execute(
                    "DELETE FROM blob WHERE hash = ?1 AND NOT EXISTS (SELECT 1 FROM version WHERE hash = ?1)",
                    params![h],
                )?;
                return Ok(id);
            }
        }
        let summary = match &last {
            Some((_, _, _, h, _)) => {
                let old = Self::read(&conn, h, String::new())?.text;
                serde_json::to_string(&describe(&old, text)).ok()
            }
            None => None,
        };
        conn.execute(
            "INSERT INTO version(file_id, ts, hash, source, authors, summary) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![fid, at, hash, source, authors_json, summary],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn record_now(
        &self,
        path: &str,
        text: &str,
        authors: &[Authorship],
        source: &str,
    ) -> rusqlite::Result<i64> {
        self.record(path, text, authors, source, now_ms())
    }

    fn read(conn: &Connection, hash: &str, authors: String) -> rusqlite::Result<Version> {
        let z: Vec<u8> = conn.query_row(
            "SELECT zdata FROM blob WHERE hash = ?1",
            params![hash],
            |r| r.get(0),
        )?;
        let raw = zstd::decode_all(z.as_slice()).unwrap_or(z);
        Ok(Version {
            text: String::from_utf8_lossy(&raw).into_owned(),
            authors: serde_json::from_str(&authors).unwrap_or_default(),
        })
    }

    pub fn last(&self, path: &str) -> rusqlite::Result<Option<Version>> {
        let conn = self.conn()?;
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT v.hash, v.authors FROM version v JOIN file f ON f.id = v.file_id
                 WHERE f.path = ?1 ORDER BY v.ts DESC, v.id DESC LIMIT 1",
                params![path.to_lowercase()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match row {
            Some((h, a)) => Self::read(&conn, &h, a).map(Some),
            None => Ok(None),
        }
    }

    pub fn get(&self, id: i64) -> rusqlite::Result<Version> {
        let conn = self.conn()?;
        let (h, a): (String, String) = conn.query_row(
            "SELECT hash, authors FROM version WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Self::read(&conn, &h, a)
    }

    pub fn list(&self, path: &str) -> rusqlite::Result<Vec<VersionInfo>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT v.id, v.ts, v.source, v.label, b.raw_len, v.summary, v.file_id FROM version v
             JOIN file f ON f.id = v.file_id JOIN blob b ON b.hash = v.hash
             WHERE f.path = ?1 ORDER BY v.ts DESC, v.id DESC",
        )?;
        let rows = stmt
            .query_map(params![path.to_lowercase()], |r| {
                let summary: Option<String> = r.get(5)?;
                Ok((
                    VersionInfo {
                        id: r.get(0)?,
                        ts: r.get(1)?,
                        source: r.get(2)?,
                        label: r.get(3)?,
                        chars: r.get(4)?,
                        summary: summary.and_then(|s| serde_json::from_str(&s).ok()),
                    },
                    r.get::<_, i64>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // Versioner fra før 9/10 har ingen beskrivelse: de nyeste 30 regnes ud og gemmes nu.
        let mut out = Vec::with_capacity(rows.len());
        let mut filled = 0;
        let last = rows.len().saturating_sub(1);
        for (i, (mut v, fid)) in rows.into_iter().enumerate() {
            if v.summary.is_none() && i < last && filled < 30 {
                filled += 1;
                let (h, a): (String, String) = conn.query_row(
                    "SELECT hash, authors FROM version WHERE id = ?1",
                    params![v.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                let new = Self::read(&conn, &h, a)?.text;
                if let Some(old) = Self::text_before(&conn, fid, v.ts, v.id)? {
                    let s = describe(&old, &new);
                    conn.execute(
                        "UPDATE version SET summary = ?1 WHERE id = ?2",
                        params![serde_json::to_string(&s).ok(), v.id],
                    )?;
                    v.summary = Some(s);
                }
            }
            out.push(v);
        }
        Ok(out)
    }

    /// Navngiv en version (»Sendt til redaktøren«). Navngivne versioner udtyndes aldrig.
    pub fn set_label(&self, id: i64, label: &str) -> rusqlite::Result<()> {
        let conn = self.conn()?;
        let label = label.trim();
        conn.execute(
            "UPDATE version SET label = ?1, pinned = ?2 WHERE id = ?3",
            params![
                if label.is_empty() { None } else { Some(label) },
                i64::from(!label.is_empty()),
                id
            ],
        )?;
        Ok(())
    }

    /// Udtynd alle filers historik og fjern indhold, ingen version peger på længere.
    pub fn thin(&self, now: i64) -> rusqlite::Result<usize> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, file_id, ts, source, pinned FROM version ORDER BY file_id, ts DESC",
        )?;
        let rows: Vec<(i64, i64, i64, String, i64)> = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        let mut removed = 0;
        let mut by_file: std::collections::BTreeMap<i64, Vec<Slot>> =
            std::collections::BTreeMap::new();
        for (id, fid, ts, src, pinned) in rows {
            by_file.entry(fid).or_default().push(Slot {
                id,
                ts,
                keep_always: src != "app" || pinned != 0,
            });
        }
        // Én transaktion: ellers er hver sletning sin egen skrivning til disken.
        conn.execute_batch("BEGIN")?;
        for slots in by_file.values() {
            for id in to_thin(slots, now) {
                conn.execute("DELETE FROM version WHERE id = ?1", params![id])?;
                removed += 1;
            }
        }
        Self::gc(&conn)?;
        conn.execute_batch("COMMIT")?;
        Ok(removed)
    }

    /// Udtynd, hvis det er mere end et døgn siden sidst. Kaldes ved start og ved hvert gem.
    pub fn thin_if_due(&self) -> rusqlite::Result<Option<usize>> {
        let now = now_ms();
        {
            let mut last = self.last_thin.lock().map_err(|_| locked())?;
            if now - *last < DAY {
                return Ok(None);
            }
            *last = now;
        }
        self.thin(now).map(Some)
    }

    fn conn(&self) -> rusqlite::Result<std::sync::MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| locked())
    }

    fn gc(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute(
            "DELETE FROM blob WHERE hash NOT IN (SELECT hash FROM version)",
            [],
        )?;
        Ok(())
    }
}

/// Hvad der er ændret fra `old` til `new`: ord tilføjet og fjernet, og hvor (9/10). Fælles
/// begyndelse og slutning skæres væk først, så et autogem kun sammenligner det ændrede. Er det
/// ændrede stykke stort, tælles ordene bare på hver side: en tegn-diff over
/// hele teksten har frosset vinduet ved lange tekster før.
pub fn describe(old: &str, new: &str) -> Summary {
    let mut pre = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(pre) || !new.is_char_boundary(pre) {
        pre -= 1;
    }
    let max_suf = old.len().min(new.len()) - pre;
    let mut suf = old
        .bytes()
        .rev()
        .zip(new.bytes().rev())
        .take(max_suf)
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - suf) || !new.is_char_boundary(new.len() - suf) {
        suf -= 1;
    }
    // Ord, der står delvis i det ændrede (»tekts« → »tekst«), tælles som ændrede: stykket udvides
    // til hele ord på begge sider.
    let word = |c: char| c.is_alphanumeric();
    let grow_left = new[..pre]
        .chars()
        .rev()
        .take_while(|c| word(*c))
        .map(char::len_utf8)
        .sum::<usize>();
    let grow_right = new[new.len() - suf..]
        .chars()
        .take_while(|c| word(*c))
        .map(char::len_utf8)
        .sum::<usize>();
    let o = &old[pre - grow_left..old.len() - suf + grow_right];
    let n = &new[pre - grow_left..new.len() - suf + grow_right];
    let words_of = |s: &str| -> Vec<String> {
        s.split(|c: char| !word(c))
            .filter(|w| !w.is_empty())
            .map(str::to_owned)
            .collect()
    };
    let (ow, nw) = (words_of(o), words_of(n));
    let (added, removed) = if ow.len() + nw.len() > 20_000 {
        (nw.len() as u32, ow.len() as u32)
    } else {
        // Ord, ikke tegn: hvert forskelligt ord får sit eget tegn fra Unicodes private område, så
        // tegn-diffen sammenligner ord (»meget« og »mange« deler ellers bogstaver).
        let mut code: std::collections::HashMap<String, char> = std::collections::HashMap::new();
        let mut encode = |ws: &[String]| -> String {
            ws.iter()
                .map(|w| {
                    let next = code.len() as u32;
                    *code
                        .entry(w.clone())
                        .or_insert_with(|| char::from_u32(0xF0000 + next).unwrap_or('\u{FFFD}'))
                })
                .collect()
        };
        let (oe, ne) = (encode(&ow), encode(&nw));
        let (mut a, mut r) = (0, 0);
        for chunk in dissimilar::diff(&oe, &ne) {
            match chunk {
                dissimilar::Chunk::Insert(s) => a += s.chars().count() as u32,
                dissimilar::Chunk::Delete(s) => r += s.chars().count() as u32,
                dissimilar::Chunk::Equal(_) => {}
            }
        }
        (a, r)
    };
    Summary {
        place: if o.is_empty() && n.is_empty() {
            String::new()
        } else {
            place_at(new, pre)
        },
        added,
        removed,
    }
}

/// Den nærmeste overskrift over `pos` (eller på samme linje), ellers afsnittets første ord.
fn place_at(text: &str, pos: usize) -> String {
    let pos = pos.min(text.len());
    let line_end = text[pos..].find('\n').map_or(text.len(), |i| pos + i);
    for line in text[..line_end].lines().rev() {
        let t = line.trim_start();
        let hashes = t.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && t[hashes..].starts_with(' ') {
            return clean(&t[hashes..]);
        }
    }
    let start = text[..pos].rfind("\n\n").map_or(0, |i| i + 2);
    let para = text[start..].split("\n\n").next().unwrap_or("");
    let cleaned = clean(para);
    let words: Vec<&str> = cleaned.split_whitespace().take(6).collect();
    if words.is_empty() {
        return String::new();
    }
    format!("»{} …«", words.join(" "))
}

/// Markdown-tegn væk fra en overskrift eller et uddrag.
fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '*' | '_' | '`' | '#' | '>'))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone)]
pub struct Slot {
    pub id: i64,
    pub ts: i64,
    pub keep_always: bool,
}

/// Hvilke versioner der skal væk (nyeste først ind). Ren funktion, så reglen kan testes.
pub fn to_thin(slots: &[Slot], now: i64) -> Vec<i64> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut sorted = slots.to_vec();
    sorted.sort_by_key(|s| std::cmp::Reverse(s.ts));
    for s in sorted {
        let age = now - s.ts;
        if s.keep_always || age < DAY {
            continue;
        }
        let bucket = if age < 14 * DAY {
            ("time", s.ts / (60 * 60 * 1000))
        } else if age < 90 * DAY {
            ("dag", s.ts / DAY)
        } else {
            ("uge", s.ts / (7 * DAY))
        };
        if !seen.insert(bucket) {
            out.push(s.id);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::annotations::{Author, Kind, Span};

    fn authors() -> Vec<Authorship> {
        vec![Authorship {
            author: Author {
                kind: Kind::Human,
                name: "Kim Skribent".into(),
                identifier: None,
            },
            spans: vec![Span { start: 0, end: 3 }],
        }]
    }

    #[test]
    fn version_gemmes_og_hentes_med_forfatterskab() {
        let h = History::memory();
        h.record("C:\\a.md", "Hej verden", &authors(), "first", 1_000)
            .unwrap();
        let v = h.last("c:\\A.md").unwrap().unwrap();
        assert_eq!(v.text, "Hej verden");
        assert_eq!(v.authors, authors());
    }

    #[test]
    fn samme_session_laegges_sammen_men_ikke_paa_tvaers_af_kilder() {
        let h = History::memory();
        h.record("a", "v1", &[], "app", 0).unwrap();
        h.record("a", "v2", &[], "app", 60_000).unwrap();
        assert_eq!(h.list("a").unwrap().len(), 1, "samme session");
        h.record("a", "v3", &[], "external", 70_000).unwrap();
        h.record("a", "v4", &[], "app", 80_000).unwrap();
        assert_eq!(h.list("a").unwrap().len(), 3, "kilde skifter");
        h.record("a", "v5", &[], "app", 80_000 + SESSION_MS + 1)
            .unwrap();
        assert_eq!(h.list("a").unwrap().len(), 4, "ny session efter pause");
    }

    #[test]
    fn uaendret_tekst_giver_ingen_ny_version() {
        let h = History::memory();
        h.record("a", "samme", &[], "app", 0).unwrap();
        h.record("a", "samme", &[], "external", SESSION_MS * 3)
            .unwrap();
        assert_eq!(h.list("a").unwrap().len(), 1);
    }

    #[test]
    fn navngivet_version_og_indhold_ryddes_op() {
        let h = History::memory();
        let id = h.record("a", "x", &[], "app", 0).unwrap();
        h.set_label(id, "Sendt til redaktøren").unwrap();
        assert_eq!(
            h.list("a").unwrap()[0].label.as_deref(),
            Some("Sendt til redaktøren")
        );
        h.record("a", "y", &[], "app", 1).unwrap();
        assert_eq!(
            h.list("a").unwrap().len(),
            2,
            "navngivet version lægges ikke sammen"
        );
    }

    #[test]
    fn udtynding_efter_alder() {
        let now = 400 * DAY;
        let hour = 60 * 60 * 1000;
        let slots = vec![
            Slot {
                id: 1,
                ts: now - hour,
                keep_always: false,
            },
            Slot {
                id: 2,
                ts: now - 2 * hour,
                keep_always: false,
            },
            // Inde i samme time (3 dage gamle) og samme dag (30 dage gamle), ikke på en grænse.
            Slot {
                id: 3,
                ts: now - 3 * DAY + 10 * 60_000,
                keep_always: false,
            },
            Slot {
                id: 4,
                ts: now - 3 * DAY + 5 * 60_000,
                keep_always: false,
            },
            Slot {
                id: 5,
                ts: now - 30 * DAY + 3 * hour,
                keep_always: false,
            },
            Slot {
                id: 6,
                ts: now - 30 * DAY + 2 * hour,
                keep_always: false,
            },
            Slot {
                id: 7,
                ts: now - 30 * DAY + hour,
                keep_always: true,
            },
        ];
        let gone = to_thin(&slots, now);
        assert!(
            !gone.contains(&1) && !gone.contains(&2),
            "sidste døgn beholdes"
        );
        assert!(gone.contains(&4) && !gone.contains(&3), "én pr. time");
        assert!(gone.contains(&6) && !gone.contains(&5), "én pr. dag");
        assert!(!gone.contains(&7), "eksterne og navngivne beholdes");
    }
}

#[cfg(test)]
mod describe_tests {
    use super::{describe, Summary};

    fn s(place: &str, added: u32, removed: u32) -> Summary {
        Summary {
            place: place.to_owned(),
            added,
            removed,
        }
    }

    #[test]
    fn hvad_der_er_aendret_og_hvor() {
        let old = "# Titel

Indledning her.

## Hvad koster det?

Det koster meget.
";
        let new = "# Titel

Indledning her.

## Hvad koster det?

Det koster rigtig mange penge.
";
        assert_eq!(describe(old, new), s("Hvad koster det?", 3, 1));
        // En rettet tastefejl er ét ord ud og ét ind.
        assert_eq!(
            describe("Det er en tekts.", "Det er en tekst."),
            s("»Det er en tekst. …«", 1, 1)
        );
        // Før første overskrift: afsnittets første ord.
        assert_eq!(
            describe(
                "Første afsnit.

## Sidst",
                "Første lange afsnit.

## Sidst"
            )
            .place,
            "»Første lange afsnit. …«"
        );
        // Ingen ændring.
        assert_eq!(describe("Samme.", "Samme."), s("", 0, 0));
        // Æøå ved kanten af det ændrede.
        assert_eq!(
            describe("Rødgrød med fløde", "Rødgrød med fløde og bær").added,
            2
        );
    }
}
