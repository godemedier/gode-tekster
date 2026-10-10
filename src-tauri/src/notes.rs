//! Noter: små ark på skrivebordet (ADR-0039, plan 2026-10-08-sedler). Hver note er en almindelig
//! .md-fil i `Dokumenter\Gode Tekster\Noter`, vist i sit eget rammeløse vindue (»note-1« …) med
//! samme editor som teksterne. Filen er sandheden (ADR-0003). Placering, størrelse, »hold øverst«,
//! »rullet op« og om noten er fremme gemmes kun på denne pc i `<data>\noter.json`, så OneDrive
//! ikke skal synke hvert flyt, og to pc'er ikke flytter rundt på hinandens noter.
//!
//! Win+Alt+N laver en ny note fra et hvilket som helst program (`hotkey`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

/// Ét ark på denne pc. Positioner og størrelser i fysiske pixel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    open: bool,
    on_top: bool,
    rolled: bool,
}

#[derive(Default)]
pub struct NotesState {
    next: AtomicU32,
    /// Tæller flyt, så kun det sidste i et træk gemmes (`moved`).
    moves: AtomicU32,
    /// Sti (små bogstaver) → placering. Hentes fra disken første gang.
    places: Mutex<Option<HashMap<String, Placement>>>,
    /// Vindue → sti, for de noter, der er fremme.
    labels: Mutex<HashMap<String, PathBuf>>,
    /// Noter, der skal have fokus, når de er klar (nye), modsat dem, der kommer igen ved start.
    focus_on_ready: Mutex<HashSet<String>>,
    /// Vindue → vindueshåndtag, så `desktop.rs` kan finde arkene uden at gå gennem hovedtråden.
    hwnds: Mutex<HashMap<String, isize>>,
}

/// Et rullet ark er kun toppen: 36 px (logiske).
const ROLLED: f64 = 36.0;
const WIDTH: f64 = 300.0;
const HEIGHT: f64 = 280.0;

fn key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

fn store(app: &AppHandle) -> Option<PathBuf> {
    // Testkørsler har deres egne placeringer: ellers lukkede testprotokollen brugerens ark og
    // slettede en tom note (natlig test 9/10).
    if std::env::var("GT_TEST").is_ok_and(|v| v == "1") {
        if let Ok(dir) = std::env::var("GT_NOTER_DIR") {
            return Some(PathBuf::from(dir).join("noter.json"));
        }
        return app
            .path()
            .app_local_data_dir()
            .ok()
            .map(|d| d.join("noter-test.json"));
    }
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("noter.json"))
}

/// Gør noget med placeringerne og gemmer dem bagefter.
fn with_places<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut HashMap<String, Placement>) -> T,
) -> Option<T> {
    places_then(app, f, true)
}

/// Som `with_places`, men `save` = false lader filen være (et træk giver hundredvis af flyt).
fn places_then<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut HashMap<String, Placement>) -> T,
    save: bool,
) -> Option<T> {
    let state = app.state::<NotesState>();
    let mut guard = state.places.lock().ok()?;
    let places = guard.get_or_insert_with(|| {
        store(app)
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    });
    let out = f(places);
    if !save {
        return Some(out);
    }
    if let (Some(file), Ok(json)) = (store(app), serde_json::to_vec_pretty(&*places)) {
        let _ = crate::files::write_atomic(&file, &json);
    }
    Some(out)
}

/// Mappen med noterne: `Dokumenter\Gode Tekster\Noter`. `Dokumenter\Gode Tekster` bliver bibliotek,
/// hvis det ikke er det, så noterne kan åbnes og gemmes som alle andre tekster.
fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Testkørsler (GT_TEST=1) lægger noterne i en testmappe, aldrig i brugerens egne.
    if std::env::var("GT_TEST").is_ok_and(|v| v == "1") {
        if let Ok(dir) = std::env::var("GT_NOTER_DIR") {
            let dir = PathBuf::from(dir);
            let _ = std::fs::create_dir_all(&dir);
            return Ok(dir);
        }
    }
    let docs = app.path().document_dir().map_err(|e| {
        format!(
            "{}: {e}",
            t!(
                "Dokumenter kunne ikke findes",
                "Documents could not be found"
            )
        )
    })?;
    let home = docs.join("Gode Tekster");
    let dir = home.join(t!("Noter", "Notes"));
    std::fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "{}: {e}",
            t!(
                "Mappen til noterne kunne ikke laves",
                "The notes folder could not be created"
            )
        )
    })?;
    if !crate::library::in_library(app, &dir) {
        crate::settings::add_library_path(app, &home);
    }
    Ok(dir)
}

/// »2026-10-08 14.32.md« efter Windows' lokale tid. Findes navnet, får det » 2«, » 3« …
fn new_file(dir: &Path) -> Result<PathBuf, String> {
    let stamp = local_stamp();
    let mut path = dir.join(format!("{stamp}.md"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stamp} {n}.md"));
        n += 1;
    }
    std::fs::write(&path, b"").map_err(|e| {
        format!(
            "{}: {e}",
            t!("Noten kunne ikke laves", "The note could not be created")
        )
    })?;
    Ok(path)
}

#[cfg(windows)]
fn local_stamp() -> String {
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    // SAFETY: GetLocalTime skriver kun i den SYSTEMTIME, den får.
    let t = unsafe {
        let mut t = std::mem::zeroed();
        GetLocalTime(&mut t);
        t
    };
    format!(
        "{:04}-{:02}-{:02} {:02}.{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute
    )
}

#[cfg(not(windows))]
fn local_stamp() -> String {
    "note".to_owned()
}

/// En ny, tom note med markøren klar (Win+Alt+N, Ctrl+N i en note, menuen ved uret).
pub fn new_note(app: &AppHandle) -> Result<(), String> {
    let dir = notes_dir(app)?;
    let path = new_file(&dir)?;
    crate::document::choose(app, &path);
    open_window(app, &path, true)
}

/// Vis noten i sit eget ark. Er den allerede fremme (eller åben i et tekstvindue), hentes den frem.
fn open_window(app: &AppHandle, path: &Path, focus: bool) -> Result<(), String> {
    if let Some(label) = crate::windows::window_with(app, path) {
        crate::windows::focus(app, &label);
        return Ok(());
    }
    let state = app.state::<NotesState>();
    let label = format!("note-{}", state.next.fetch_add(1, Ordering::SeqCst) + 1);
    let place = with_places(app, |p| p.get(&key(path)).cloned()).flatten();
    crate::windows::set_pending(app, &label, path);
    if let Ok(mut l) = state.labels.lock() {
        l.insert(label.clone(), path.to_path_buf());
    }
    if focus {
        if let Ok(mut f) = state.focus_on_ready.lock() {
            f.insert(label.clone());
        }
    }
    let on_top = place.as_ref().is_some_and(|p| p.on_top);
    let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("note.html".into()))
        .title(
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
        )
        .decorations(false)
        .shadow(true)
        .skip_taskbar(true)
        .resizable(true)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(on_top)
        .inner_size(WIDTH, HEIGHT)
        .min_inner_size(180.0, ROLLED)
        .visible(false)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    hide_from_alt_tab(&w);
    #[cfg(windows)]
    if let (Ok(hwnd), Ok(mut h)) = (w.hwnd(), state.hwnds.lock()) {
        h.insert(label.clone(), hwnd.0 as isize);
    }
    match place.filter(|p| on_screen(&w, p.x, p.y)) {
        Some(p) => {
            let _ = w.set_position(PhysicalPosition::new(p.x, p.y));
            let h = if p.rolled {
                (ROLLED * w.scale_factor().unwrap_or(1.0)) as u32
            } else {
                p.h
            };
            let _ = w.set_size(PhysicalSize::new(p.w, h));
        }
        None => cascade(app, &w),
    }
    // Vinduet spørges, FØR låsen tages: spørgsmålet går til hovedtråden, og den venter på samme
    // lås, når et flyt skal gemmes (`moved`). Ellers låser programmet fast (8/10).
    let pos = w.outer_position().unwrap_or_default();
    let size = w.inner_size().unwrap_or_default();
    with_places(app, |places| {
        let entry = places.entry(key(path)).or_insert(Placement {
            x: pos.x,
            y: pos.y,
            w: size.width,
            h: size.height,
            open: true,
            on_top: false,
            rolled: false,
        });
        entry.open = true;
    });
    Ok(())
}

/// Et nyt ark lægges øverst til højre på den skærm, musen er på, lidt forskudt for hvert ark.
fn cascade(app: &AppHandle, w: &tauri::WebviewWindow) {
    let Some(m) = w
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
    else {
        return;
    };
    let scale = m.scale_factor();
    let open = app
        .state::<NotesState>()
        .labels
        .lock()
        .map(|l| l.len())
        .unwrap_or(1) as i32;
    let step = (28.0 * scale) as i32 * ((open - 1).rem_euclid(8));
    let area = m.work_area();
    let x = area.position.x + area.size.width as i32 - ((WIDTH + 40.0) * scale) as i32 - step;
    let y = area.position.y + (60.0 * scale) as i32 + step;
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

/// Ligger punktet på en skærm, der findes nu? (En skærm kan være taget fra siden sidst.)
fn on_screen(w: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    w.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        x >= p.x - 40
            && y >= p.y - 10
            && x < p.x + s.width as i32 - 40
            && y < p.y + s.height as i32 - 40
    })
}

/// Ikke i Alt+Tab: et værktøjsvindue (WS_EX_TOOLWINDOW). `skip_taskbar` fjerner kun knappen i proceslinjen.
#[cfg(windows)]
fn hide_from_alt_tab(w: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };
    if let Ok(hwnd) = w.hwnd() {
        // SAFETY: et gyldigt vindueshåndtag fra Tauri. Kun stil-bits ændres.
        unsafe {
            let style = GetWindowLongPtrW(hwnd.0 as _, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd.0 as _,
                GWL_EXSTYLE,
                (style | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize),
            );
            // Runde hjørner som Windows 11's egne vinduer (DWMWA_WINDOW_CORNER_PREFERENCE = 33, rund = 2).
            let round: u32 = 2;
            windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(
                hwnd.0 as _,
                33,
                (&round as *const u32).cast(),
                4,
            );
        }
    }
}

#[cfg(not(windows))]
fn hide_from_alt_tab(_w: &tauri::WebviewWindow) {}

/// Er vinduet en note?
pub fn is_note(label: &str) -> bool {
    label.starts_with("note-")
}

/// Fladen er klar: vis arket. Kun en ny note tager fokus, så noter fra sidst ikke stjæler tastaturet ved start.
pub fn ready(app: &AppHandle, label: &str) {
    let focus = app
        .state::<NotesState>()
        .focus_on_ready
        .lock()
        .map(|mut f| f.remove(label))
        .unwrap_or(false);
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        // Vist igen: tao sætter vinduets stil om, så arket kom med i Alt+Tab (natlig test 9/10).
        hide_from_alt_tab(&w);
        if focus && !std::env::var("GT_TEST").is_ok_and(|v| v == "1") {
            let _ = w.set_focus();
        }
    }
}

fn path_of(app: &AppHandle, label: &str) -> Option<PathBuf> {
    app.state::<NotesState>()
        .labels
        .lock()
        .ok()?
        .get(label)
        .cloned()
}

/// Arket er flyttet eller har fået ny størrelse (lib.rs, vindueshændelser). Et rullet ark husker sin fulde højde.
pub fn moved(app: &AppHandle, window: &tauri::Window) {
    let Some(path) = path_of(app, window.label()) else {
        return;
    };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    if window.is_minimized().unwrap_or(false) || size.width == 0 {
        return;
    }
    places_then(
        app,
        |places| {
            if let Some(p) = places.get_mut(&key(&path)) {
                p.x = pos.x;
                p.y = pos.y;
                p.w = size.width;
                if !p.rolled {
                    p.h = size.height;
                }
            }
        },
        false,
    );
    // Gem, når arket har ligget stille et halvt sekund.
    let generation = app
        .state::<NotesState>()
        .moves
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if app.state::<NotesState>().moves.load(Ordering::SeqCst) == generation {
            with_places(&app, |_| ());
        }
    });
}

/// Arket lukkes (Ctrl+W, luk). En tom note efterlader ingen fil. Ved Afslut lukkes arkene ikke
/// her, så de kommer igen ved næste start.
#[tauri::command]
pub fn note_close(app: AppHandle, window: tauri::WebviewWindow, empty: bool) {
    let label = window.label().to_owned();
    if let Some(path) = path_of(&app, &label) {
        with_places(&app, |places| {
            if empty {
                places.remove(&key(&path));
            } else if let Some(p) = places.get_mut(&key(&path)) {
                p.open = false;
            }
        });
        if empty && std::fs::metadata(&path).is_ok_and(|m| m.len() == 0) {
            let _ = std::fs::remove_file(&path);
        }
    }
    forget(&app, &label);
    let _ = window.destroy();
}

/// Slet noten: filen i papirkurven, arket væk.
#[tauri::command]
pub async fn confirm_note_delete(app: AppHandle, window: tauri::WebviewWindow) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    app.dialog()
        .message(t!(
            "Vil du lægge noten i papirkurven?",
            "Move this note to the Recycle Bin?"
        ))
        .title(t!("Slet note", "Delete note"))
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            t!("Læg i papirkurven", "Move to Recycle Bin").into(),
            t!("Behold noten", "Keep note").into(),
        ))
        .blocking_show()
}

#[tauri::command]
pub fn note_delete(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label().to_owned();
    if let Some(path) = path_of(&app, &label) {
        trash::delete(&path).map_err(|e| {
            format!(
                "{}: {e}",
                t!(
                    "Kunne ikke lægge i papirkurven",
                    "Could not move to the Recycle Bin"
                )
            )
        })?;
        with_places(&app, |places| places.remove(&key(&path)));
    }
    forget(&app, &label);
    let _ = window.destroy();
    Ok(())
}

/// Hold arket øverst over andre vinduer, eller lad det være.
#[tauri::command]
pub fn note_on_top(app: AppHandle, window: tauri::WebviewWindow, on: bool) {
    let _ = window.set_always_on_top(on);
    hide_from_alt_tab(&window);
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        crate::desktop::keep(hwnd.0 as isize);
    }
    if let Some(path) = path_of(&app, window.label()) {
        with_places(&app, |places| {
            if let Some(p) = places.get_mut(&key(&path)) {
                p.on_top = on;
            }
        });
    }
}

/// Rul arket op til toppen eller ned igen (dobbeltklik på toppen, som Stickies).
#[tauri::command]
pub fn note_roll(app: AppHandle, window: tauri::WebviewWindow, rolled: bool) {
    let Some(path) = path_of(&app, window.label()) else {
        return;
    };
    let full = with_places(&app, |places| {
        places.get_mut(&key(&path)).map(|p| {
            p.rolled = rolled;
            p.h
        })
    })
    .flatten();
    let width = window.inner_size().map(|s| s.width).unwrap_or(300);
    let h = if rolled {
        (ROLLED * window.scale_factor().unwrap_or(1.0)) as u32
    } else {
        full.unwrap_or((HEIGHT * window.scale_factor().unwrap_or(1.0)) as u32)
    };
    let _ = window.set_size(PhysicalSize::new(width, h));
}

/// Er arket rullet op og holdt øverst? Fladen spørger, når den starter.
#[tauri::command]
pub fn note_state(app: AppHandle, window: tauri::WebviewWindow) -> (bool, bool) {
    path_of(&app, window.label())
        .and_then(|path| {
            with_places(&app, |places| {
                places.get(&key(&path)).map(|p| (p.rolled, p.on_top))
            })
            .flatten()
        })
        .unwrap_or((false, false))
}

/// »Åbn som tekst«: arket lukkes, og noten åbnes i et almindeligt vindue.
#[tauri::command]
pub async fn note_as_text(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label().to_owned();
    let Some(path) = path_of(&app, &label) else {
        return Err(t!("Noten er ikke længere åben.", "The note is no longer open.").into());
    };
    // Opret destinationen først: fejler vinduet, bliver noten stående.
    if crate::windows::main_is_busy(&app) {
        crate::windows::open_window(&app, Some(path.clone()))?;
    } else {
        app.emit_to("main", "open-path", path.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())?;
        crate::show_main(&app);
    }
    with_places(&app, |places| {
        if let Some(p) = places.get_mut(&key(&path)) {
            p.open = false;
        }
    });
    forget(&app, &label);
    let _ = window.destroy();
    Ok(())
}

#[tauri::command]
pub async fn note_new(app: AppHandle) -> Result<(), String> {
    new_note(&app)
}

fn forget(app: &AppHandle, label: &str) {
    destroyed(app, label);
    crate::windows::forget(app, label);
}

/// Vindue lukket udefra (Destroyed): glem det, men lad »fremme« stå, så det kommer igen ved start.
pub fn destroyed(app: &AppHandle, label: &str) {
    let state = app.state::<NotesState>();
    if let Ok(mut l) = state.labels.lock() {
        l.remove(label);
    }
    if let Ok(mut h) = state.hwnds.lock() {
        h.remove(label);
    };
}

/// Vindueshåndtagene på arkene, der er åbne (`desktop.rs`).
pub fn handles(app: &AppHandle) -> Vec<isize> {
    app.state::<NotesState>()
        .hwnds
        .lock()
        .map(|h| h.values().copied().collect())
        .unwrap_or_default()
}

/// Menuen ved uret: hent alle noter frem, også dem, der var lukket ned, men stod fremme sidst.
pub fn show_all(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if is_note(&label) {
            let _ = w.show();
        }
    }
    restore(app);
}

/// Menuen ved uret: skjul arkene (de er stadig fremme og kommer igen ved »Vis alle noter«).
pub fn hide_all(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if is_note(&label) {
            let _ = w.hide();
        }
    }
}

/// Ved start: arkene, der var fremme, kommer igen samme sted. En slettet eller flyttet fil glemmes.
pub fn restore(app: &AppHandle) {
    let open: Vec<String> = with_places(app, |places| {
        places.retain(|k, _| Path::new(k).exists());
        places
            .iter()
            .filter(|(_, p)| p.open)
            .map(|(k, _)| k.clone())
            .collect()
    })
    .unwrap_or_default();
    for k in open {
        let path = PathBuf::from(&k);
        crate::document::choose(app, &path);
        let _ = open_window(app, &path, false);
    }
}

/// Win+Alt+N fra et hvilket som helst program: en ny note. Windows' egen genvejstabel
/// (RegisterHotKey) i en tråd med sin egen beskedløkke. Er genvejen taget, skrives det i loggen.
#[cfg(windows)]
pub fn hotkey(app: AppHandle) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, MOD_ALT, MOD_NOREPEAT, MOD_WIN,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};
    std::thread::spawn(move || {
        // SAFETY: genvejen registreres på denne tråd (intet vindue), og beskederne læses her.
        unsafe {
            if RegisterHotKey(
                std::ptr::null_mut(),
                1,
                MOD_WIN | MOD_ALT | MOD_NOREPEAT,
                u32::from(b'N'),
            ) == 0
            {
                crate::applog::write(&app, "Win+Alt+N er taget af et andet program");
                return;
            }
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                if msg.message == WM_HOTKEY {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = new_note(&app) {
                            crate::applog::write(&app, &format!("ny note: {e}"));
                        }
                    });
                }
            }
        }
    });
}

#[cfg(not(windows))]
pub fn hotkey(_app: AppHandle) {}
