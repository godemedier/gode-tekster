//! Søgning i hele biblioteket (Ctrl+Shift+F, research 2/10: iA 8, novelWriter). Ctrl+O finder kun
//! filnavne; her søges der i teksten i alle tekstfiler i bibliotekerne. Husets egne filer
//! (dæmpede i biblioteket) og Word-filer springes over. Fundets position er i UTF-16 i teksten,
//! som editoren viser den (CRLF som LF, uden iA's forfatterblok), så Enter springer det rigtige sted hen.

use memchr::memmem;
use serde::Serialize;
use std::io::Read;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::library::FileHit;

const MAX_HITS: usize = 300;
const MAX_PER_FILE: usize = 20;
const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub name: String,
    pub folder: String,
    /// Linjen med fundet, forkortet omkring det.
    pub snippet: String,
    /// Hvor fundet står i `snippet` (tegn, ikke bytes).
    pub at: usize,
    pub len: usize,
    /// Positionen i teksten (UTF-16), til at springe dertil.
    pub pos: usize,
}

/// Fundene i én tekst. Små og store bogstaver er ens.
pub fn find_in(text: &str, query: &str, limit: usize) -> Vec<(usize, String, usize, usize)> {
    let q: Vec<char> = query.to_lowercase().chars().collect();
    if q.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut pos = 0usize; // UTF-16
    for line in text.split('\n') {
        let chars: Vec<char> = line.chars().collect();
        let lower: Vec<char> = chars
            .iter()
            .map(|c| c.to_lowercase().next().unwrap_or(*c))
            .collect();
        let mut i = 0;
        while i + q.len() <= lower.len() {
            if lower[i..i + q.len()] == q[..] {
                let col: usize = chars[..i].iter().map(|c| c.len_utf16()).sum();
                // Uddrag: op til 50 tegn før og 90 efter.
                let start = i.saturating_sub(50);
                let end = (i + q.len() + 90).min(chars.len());
                let prefix = if start > 0 { "…" } else { "" };
                let snippet: String = format!(
                    "{prefix}{}",
                    chars[start..end].iter().collect::<String>().trim_end()
                );
                out.push((
                    pos + col,
                    snippet,
                    i - start + prefix.chars().count(),
                    q.len(),
                ));
                if out.len() >= limit {
                    return out;
                }
                i += q.len();
            } else {
                i += 1;
            }
        }
        pos += line.encode_utf16().count() + 1;
    }
    out
}

/// Den nyeste søgning. En ældre, der stadig kører, stopper ved næste fil: der tastes videre i
/// søgefeltet, og hver søgning læser hele biblioteket (perf-review 2/10).
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Fillisten huskes i et halvt minut (6/10: søgningen var »ekstremt langsom«). Med et stort
/// bibliotek tog mappegennemgangen sekunder, og den kørte forfra ved hvert tastetryk.
const LIST_TTL: Duration = Duration::from_secs(30);
static FILES: Mutex<Option<(Instant, Vec<FileHit>)>> = Mutex::new(None);

/// En mappe i biblioteket er ændret (watcher.rs): næste søgning gennemgår mapperne igen.
pub fn forget_files() {
    if let Ok(mut guard) = FILES.lock() {
        *guard = None;
    }
}

fn cached_files(libraries: Vec<std::path::PathBuf>) -> Vec<FileHit> {
    if let Ok(guard) = FILES.lock() {
        if let Some((at, files)) = guard.as_ref() {
            if at.elapsed() < LIST_TTL {
                return files.clone();
            }
        }
    }
    let files = crate::library::files_in(libraries);
    if let Ok(mut guard) = FILES.lock() {
        *guard = Some((Instant::now(), files.clone()));
    }
    files
}

/// Fundene i én fil. Filen tjekkes først i ét hug for, om søgeordet står der (`memmem`, som
/// ripgrep bruger). Kun filer med et fund gennemgås linje for linje. De fleste filer har intet.
fn hits_in_file(f: &FileHit, query: &str, needle: &memmem::Finder) -> Vec<Hit> {
    let lower = f.path.to_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")) {
        return Vec::new();
    }
    let Ok(file) = std::fs::File::open(&f.path) else {
        return Vec::new();
    };
    if file.metadata().is_ok_and(|m| m.len() > MAX_BYTES) {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file.take(MAX_BYTES + 1).read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    if bytes.len() as u64 > MAX_BYTES {
        return Vec::new();
    }
    let raw = String::from_utf8_lossy(&bytes);
    if needle.find(raw.to_lowercase().as_bytes()).is_none() {
        return Vec::new();
    }
    let raw = raw.replace("\r\n", "\n");
    let text = raw.split("\n---\nAnnotations:").next().unwrap_or(&raw);
    find_in(text, query, MAX_PER_FILE)
        .into_iter()
        .map(|(pos, snippet, at, len)| Hit {
            path: f.path.clone(),
            name: f.name.clone(),
            folder: f.folder.clone(),
            snippet,
            at,
            len,
            pos,
        })
        .collect()
}

/// Søg i filerne på alle kerner. Fundene står i filernes rækkefølge, højst `MAX_HITS`.
/// `stale` svarer sandt, når der er tastet videre: så stopper alle tråde ved næste fil.
pub fn search_files(files: &[FileHit], query: &str, stale: &(dyn Fn() -> bool + Sync)) -> Vec<Hit> {
    let lowered = query.to_lowercase();
    let needle = memmem::Finder::new(lowered.as_bytes());
    let files: Vec<&FileHit> = files.iter().filter(|f| !f.dimmed).collect();
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8);
    let chunk = files.len().div_ceil(threads).max(1);
    let found = AtomicUsize::new(0);
    let parts: Vec<Vec<Hit>> = std::thread::scope(|scope| {
        let workers: Vec<_> = files
            .chunks(chunk)
            .map(|part| {
                let (needle, found) = (&needle, &found);
                scope.spawn(move || {
                    let mut out = Vec::new();
                    for f in part {
                        if stale() || found.load(Ordering::Relaxed) >= MAX_HITS {
                            break;
                        }
                        let hits = hits_in_file(f, query, needle);
                        found.fetch_add(hits.len(), Ordering::Relaxed);
                        out.extend(hits);
                    }
                    out
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|w| w.join().unwrap_or_default())
            .collect()
    });
    if stale() {
        return Vec::new();
    }
    parts.into_iter().flatten().take(MAX_HITS).collect()
}

#[tauri::command]
pub async fn search_library(app: AppHandle, query: String) -> Vec<Hit> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let query = query.trim().to_owned();
    if query.chars().count() < 2 {
        return Vec::new();
    }
    let libraries = crate::settings::load(&app).libraries;
    tauri::async_runtime::spawn_blocking(move || {
        let files = cached_files(libraries);
        let stale = || GENERATION.load(Ordering::SeqCst) != generation;
        if stale() {
            return Vec::new();
        }
        search_files(&files, &query, &stale)
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fund_uden_hensyn_til_store_bogstaver_med_utf16_position() {
        let text = "Første linje 👍🏽.\nForsvaret købte læssemaskiner.";
        let hits = find_in(text, "LÆSSEMASKINER", 10);
        assert_eq!(hits.len(), 1);
        let (pos, snippet, at, len) = &hits[0];
        let u: Vec<u16> = text.encode_utf16().collect();
        assert_eq!(
            String::from_utf16_lossy(&u[*pos..*pos + 13]),
            "læssemaskiner"
        );
        assert_eq!(
            snippet.chars().skip(*at).take(*len).collect::<String>(),
            "læssemaskiner"
        );
    }

    #[test]
    fn lange_linjer_forkortes_og_tomme_soegninger_giver_intet() {
        let line = format!("{}nål{}", "x".repeat(200), "y".repeat(200));
        let hits = find_in(&line, "nål", 10);
        assert!(hits[0].1.starts_with('…'));
        assert!(hits[0].1.chars().count() < 150);
        assert!(find_in("tekst", "", 10).is_empty());
    }

    #[test]
    fn soegningen_finder_paa_tvaers_af_filer_og_springer_det_rigtige_over() {
        let dir = std::env::temp_dir().join(format!("gt-soeg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("indre")).expect("testmappe");
        let write = |name: &str, text: &str| std::fs::write(dir.join(name), text).expect("testfil");
        write(
            "a.md",
            "Første linje.\r\nVi dropper FASTHOLDELSE som parameter.\r\n",
        );
        write("indre/b.txt", "Intet her.");
        write("c.docx", "fastholdelse i en Word-fil læses ikke her");
        write(
            "d.md",
            "fastholdelse\n---\nAnnotations: 0,12 SHA-256 abc\nfastholdelse",
        );
        // Mappen to gange, som når et bibliotek ligger inde i et andet: filerne kommer kun med én gang.
        let files = crate::library::files_in(vec![dir.join("indre"), dir.clone()]);
        assert_eq!(files.iter().filter(|f| f.name == "b.txt").count(), 1);
        let hits = search_files(&files, "fastholdelse", &|| false);
        let mut names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            ["a.md", "d.md"],
            "Word-filen og iA's annotationsblok læses ikke"
        );
        let a = hits.iter().find(|h| h.name == "a.md").expect("a.md");
        assert_eq!(
            a.pos,
            "Første linje.\n".encode_utf16().count() + "Vi dropper ".len()
        );
        assert!(
            search_files(&files, "fastholdelse", &|| true).is_empty(),
            "en forældet søgning giver intet"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Måling på rigtige biblioteker: `GT_SOEG_LIB="C:\a;C:\b" cargo test tid_ -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn tid_paa_rigtige_biblioteker() {
        let Ok(libs) = std::env::var("GT_SOEG_LIB") else {
            return;
        };
        let roots: Vec<std::path::PathBuf> =
            libs.split(';').map(std::path::PathBuf::from).collect();
        let t = Instant::now();
        let files = crate::library::files_in(roots);
        let walk = t.elapsed();
        for q in ["fastholdelse", "læst dybt", "zzqqxx"] {
            let t = Instant::now();
            let hits = search_files(&files, q, &|| false);
            println!(
                "»{q}«: {} fund i {} filer, søgning {:?} (gennemgang {:?})",
                hits.len(),
                files.len(),
                t.elapsed(),
                walk
            );
        }
    }
}

#[test]
fn test_trigram() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute(
        "CREATE VIRTUAL TABLE t USING fts5(text, tokenize='trigram')",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO t(text) VALUES ('læssemaskiner')", [])
        .unwrap();
    let mut stmt = c
        .prepare("SELECT text FROM t WHERE text MATCH 'maskine'")
        .unwrap();
    let mut rows = stmt.query([]).unwrap();
    assert!(rows.next().unwrap().is_some());
}
