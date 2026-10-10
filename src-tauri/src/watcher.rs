//! Filovervågning (ADR-0013, plan 2-9 del A). Ser de åbne filer og de mapper, bibliotekerne viser,
//! ét af hver pr. vindue (ét vindue pr. tekst, 3/10).
//!
//! - Den åbne fil ændret udefra: hashen sammenlignes med programmets sidste kendte udgave, så egne
//!   gem aldrig giver falsk alarm. Kun en reel fremmed ændring sendes som `file-changed`.
//! - Mappen ændret (ny fil, omdøbt, slettet): `folder-changed`, så listen opdaterer sig selv.
//!
//! notify 8.2 kan miste hændelser i stilhed, når bufferen løber over (research, teknik.md). Derfor
//! tjekkes den åbne fil også, når vinduet får fokus igen (`check_open_file`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use tauri::{AppHandle, Emitter, Manager};

pub struct WatchState {
    inner: Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>,
    watched: Mutex<Vec<PathBuf>>,
    /// Vinduets etiket → den åbne fil og den mappe, biblioteket viser.
    open_files: Mutex<HashMap<String, PathBuf>>,
    folders: Mutex<HashMap<String, PathBuf>>,
}

impl WatchState {
    pub fn new() -> Self {
        WatchState {
            inner: Mutex::new(None),
            watched: Mutex::new(Vec::new()),
            open_files: Mutex::new(HashMap::new()),
            folders: Mutex::new(HashMap::new()),
        }
    }
}

fn same(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}

fn on_events(app: &AppHandle, result: DebounceEventResult) {
    let Ok(events) = result else { return };
    let state = app.state::<WatchState>();
    let open: Vec<PathBuf> = state
        .open_files
        .lock()
        .map(|g| g.values().cloned().collect())
        .unwrap_or_default();
    let folders: Vec<PathBuf> = state
        .folders
        .lock()
        .map(|g| g.values().cloned().collect())
        .unwrap_or_default();
    let mut touched: Vec<PathBuf> = Vec::new();
    let mut folder_touched = false;
    for ev in &events {
        for p in &ev.paths {
            // Programmets egne midlertidige filer fra gem (files.rs) er ikke en ændring.
            if p.to_string_lossy().ends_with(".gt.tmp") {
                continue;
            }
            crate::search::invalidate(app, p);
            if let Some(o) = open.iter().find(|o| same(o, p)) {
                // En åben fil selv: kun et tjek af den, ikke en ny læsning af hele mappen
                // (ellers læste hvert autosave biblioteksmappen igen, performance-review 2/10).
                if !touched.iter().any(|t| same(t, o)) {
                    touched.push(o.clone());
                }
                continue;
            }
            if folders
                .iter()
                .any(|f| p.parent().is_some_and(|pp| same(pp, f)))
            {
                folder_touched = true;
            }
        }
    }
    // Til alle vinduer med stien; hvert vindue reagerer kun på sin egen tekst (main.ts).
    for o in touched {
        if crate::document::changed_externally(app, &o) {
            let _ = app.emit("file-changed", o.to_string_lossy().into_owned());
        }
    }
    if folder_touched {
        crate::search::forget_files();
        let _ = app.emit("folder-changed", ());
    }
}

fn ensure(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<WatchState>();
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| t!("Overvågningen er låst.", "File watching is locked."))?;
    if inner.is_none() {
        let handle = app.clone();
        let d = new_debouncer(Duration::from_millis(300), None, move |r| {
            on_events(&handle, r)
        })
        .map_err(|e| {
            t!(
                format!("Filovervågningen kunne ikke starte: {e}"),
                format!("File watching could not start: {e}")
            )
        })?;
        *inner = Some(d);
    }
    Ok(())
}

/// Overvåg præcis disse mapper (ikke rekursivt): de åbne filers mapper og bibliotekernes mapper.
fn rewatch(app: &AppHandle) -> Result<(), String> {
    ensure(app)?;
    let state = app.state::<WatchState>();
    let mut want: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if !want.iter().any(|w| same(w, &p)) {
            want.push(p);
        }
    };
    if let Ok(g) = state.open_files.lock() {
        g.values()
            .filter_map(|f| f.parent())
            .for_each(|p| add(p.to_path_buf()));
    }
    if let Ok(g) = state.folders.lock() {
        g.values().for_each(|f| add(f.clone()));
    }
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| t!("Overvågningen er låst.", "File watching is locked."))?;
    let mut watched = state
        .watched
        .lock()
        .map_err(|_| t!("Overvågningen er låst.", "File watching is locked."))?;
    if let Some(d) = inner.as_mut() {
        for old in watched.iter() {
            if !want.iter().any(|w| same(w, old)) {
                let _ = d.unwatch(old);
            }
        }
        for w in &want {
            if !watched.iter().any(|o| same(o, w)) {
                let _ = d.watch(w, RecursiveMode::NonRecursive);
            }
        }
    }
    *watched = want;
    Ok(())
}

pub fn set_open_file(app: &AppHandle, window: &str, path: &Path) {
    let state = app.state::<WatchState>();
    if let Ok(mut g) = state.open_files.lock() {
        g.insert(window.to_owned(), path.to_path_buf());
    }
    let _ = rewatch(app);
}

/// Et vindue er lukket: dets fil og mappe skal ikke overvåges længere.
pub fn forget_window(app: &AppHandle, window: &str) {
    let state = app.state::<WatchState>();
    if let Ok(mut g) = state.open_files.lock() {
        g.remove(window);
    }
    if let Ok(mut g) = state.folders.lock() {
        g.remove(window);
    }
    let _ = rewatch(app);
}

#[tauri::command]
pub fn watch_folder(app: AppHandle, window: tauri::Window, path: String) -> Result<(), String> {
    let state = app.state::<WatchState>();
    if let Ok(mut g) = state.folders.lock() {
        g.insert(window.label().to_owned(), PathBuf::from(path));
    }
    rewatch(&app)
}

/// Kaldes, når vinduet får fokus: fanger en ændring, notify måtte have tabt. Kun vinduets egen fil.
#[tauri::command]
pub fn check_open_file(app: AppHandle, window: tauri::Window) -> bool {
    let state = app.state::<WatchState>();
    let open = state
        .open_files
        .lock()
        .ok()
        .and_then(|g| g.get(window.label()).cloned());
    open.is_some_and(|o| crate::document::changed_externally(&app, &o))
}
