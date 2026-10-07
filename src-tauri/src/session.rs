//! Det, programmet husker mellem kørsler: sidst åbne fil, de seneste tekster (springlisten,
//! jumplist.rs) og markørens plads pr. fil.
//! Ligger i `<data>\session.json`. Fejl ignoreres: en tabt markørplads er ikke en katastrofe.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

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

fn load(app: &AppHandle) -> Session {
    file(app)
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn last_path(app: &AppHandle) -> Option<PathBuf> {
    load(app).last
}

/// De seneste tekster, nyeste først.
pub fn recent(app: &AppHandle) -> Vec<PathBuf> {
    load(app).recent
}

pub fn cursor_for(app: &AppHandle, path: &Path) -> Option<usize> {
    load(app).cursors.get(path).copied()
}

pub fn remember(app: &AppHandle, path: &Path, cursor: Option<usize>) {
    // Testkørsler må ikke ændre brugerens sidste fil, seneste eller markørpladser (5/10).
    if std::env::var("GT_TEST").is_ok() {
        return;
    }
    let Some(f) = file(app) else { return };
    let mut s = load(app);
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
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec_pretty(&s) {
        let _ = std::fs::write(f, json);
    }
    if moved {
        crate::jumplist::refresh(app);
    }
}
