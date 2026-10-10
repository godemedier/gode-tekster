//! Det, programmet husker mellem kørsler: sidst åbne fil, de seneste tekster (springlisten,
//! jumplist.rs) og markørens plads pr. fil.
//! Ligger i `<data>\session.json`. Fejl ignoreres: en tabt markørplads er ikke en katastrofe.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Default, Serialize, Deserialize)]
struct Session {
    last: Option<PathBuf>,
    #[serde(default)]
    recent: Vec<PathBuf>,
    cursors: HashMap<PathBuf, usize>,
}

/// Så mange seneste tekster huskes.
const RECENT: usize = 10;

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("session.json"))
}

static SESSION: OnceLock<Mutex<Session>> = OnceLock::new();

fn load(app: &AppHandle) -> Session {
    file(app)
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn get_session(app: &AppHandle) -> std::sync::MutexGuard<'_, Session> {
    SESSION
        .get_or_init(|| Mutex::new(load(app)))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

pub fn save_to_disk(app: &AppHandle) {
    if std::env::var("GT_TEST").is_ok() {
        return;
    }
    let Some(s) = SESSION.get() else { return };
    let s = s.lock().unwrap_or_else(|e| e.into_inner());
    let Some(f) = file(app) else { return };
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec_pretty(&*s) {
        let _ = crate::files::write_atomic(&f, &json);
    }
}

pub fn last_path(app: &AppHandle) -> Option<PathBuf> {
    get_session(app).last.clone()
}

/// De seneste tekster, nyeste først.
pub fn recent(app: &AppHandle) -> Vec<PathBuf> {
    get_session(app).recent.clone()
}

pub fn cursor_for(app: &AppHandle, path: &Path) -> Option<usize> {
    get_session(app).cursors.get(path).copied()
}

pub fn remember(app: &AppHandle, path: &Path, cursor: Option<usize>) {
    // Testkørsler må ikke ændre brugerens sidste fil, seneste eller markørpladser (5/10).
    if std::env::var("GT_TEST").is_ok() {
        return;
    }
    let mut s = get_session(app);
    s.last = Some(path.to_path_buf());
    // Øverst i de seneste. Ændrer det rækkefølgen, bygges springlisten igen.
    let key = path.to_string_lossy().to_lowercase();
    let moved = s.recent.first().map(|p| p.to_string_lossy().to_lowercase()) != Some(key.clone());
    s.recent
        .retain(|p| p.to_string_lossy().to_lowercase() != key);
    s.recent.insert(0, path.to_path_buf());
    s.recent.truncate(RECENT);
    if let Some(c) = cursor {
        s.cursors.insert(path.to_path_buf(), c);
    }
    drop(s);
    save_to_disk(app);
    if moved {
        crate::jumplist::refresh(app);
    }
}

/// En af de seneste tekster, som papirark i et vindue uden tekst (ADR-0030): starten af teksten,
/// så fladen kan tegne overskriften og de første afsnit.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDoc {
    path: String,
    name: String,
    folder: String,
    modified_ms: u64,
    head: String,
}

/// Så mange papirark vises.
const PAPERS: usize = 8;
/// Så meget af starten sendes med. Et ark viser en overskrift og et par afsnit.
const HEAD_CHARS: usize = 1200;

/// De seneste tekster, der stadig findes. Kun tekster, brugeren selv har åbnet (session.json),
/// og kun tekstfiler, så Word-filer og andet ikke læses.
#[tauri::command]
pub async fn recent_documents(app: AppHandle) -> Vec<RecentDoc> {
    recent(&app)
        .iter()
        .filter_map(|p| recent_doc(p))
        .take(PAPERS)
        .collect()
}

fn recent_doc(path: &Path) -> Option<RecentDoc> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    if !matches!(ext.as_str(), "md" | "markdown" | "txt") {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    // En kæmpefil skal ikke læses for at vise et frimærke af den.
    if !meta.is_file() || meta.len() > 16 * 1024 * 1024 {
        return None;
    }
    // En OneDrive-fil, der ikke er hentet ned, får et tomt ark. At læse den ville hente den.
    let text = if crate::library::is_cloud_placeholder(&meta) {
        String::new()
    } else {
        let opened = crate::files::open(path).ok()?;
        crate::annotations::parse(&opened.text, opened.meta.eol).text
    };
    let name = |p: Option<&std::ffi::OsStr>| {
        p.map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    Some(RecentDoc {
        path: path.to_string_lossy().into_owned(),
        name: name(path.file_stem()),
        folder: name(path.parent().and_then(Path::file_name)),
        modified_ms: crate::library::modified_ms(&meta),
        head: text.chars().take(HEAD_CHARS).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn papirark_har_starten_uden_forfatterblok() {
        let dir = std::env::temp_dir().join(format!("gt-recent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("Broen.md");
        std::fs::write(&p, "# Broen\n\nFørste afsnit.\n").unwrap();
        let d = recent_doc(&p).unwrap();
        assert_eq!(d.name, "Broen");
        assert!(d.head.starts_with("# Broen"));
        assert!(d.modified_ms > 0);
        std::fs::write(dir.join("rapport.docx"), b"PK").unwrap();
        assert!(recent_doc(&dir.join("rapport.docx")).is_none());
        assert!(recent_doc(&dir.join("findes-ikke.md")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
