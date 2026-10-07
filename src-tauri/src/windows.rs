//! Ét vindue pr. tekst (3/10), som i Word og iA Writer på Windows. Hovedvinduet »main« findes
//! altid og skjules ved luk (ADR-0014). Ekstra vinduer hedder »tekst-1«, »tekst-2« … og lukker helt,
//! når teksten er gemt. Samme tekst åbnes aldrig i to vinduer: det vindue, der har den, hentes frem.
//! Ctrl+Q og »Afslut« venter, til alle vinduer har gemt (højst 3 s).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
pub struct WindowState {
    next: AtomicU32,
    /// Et nyt vindue, der endnu ikke har spurgt efter sin tekst: etiket → sti.
    pending: Mutex<HashMap<String, PathBuf>>,
    /// Hvilken tekst hvert vindue viser: etiket → sti.
    shows: Mutex<HashMap<String, PathBuf>>,
    /// Under Ctrl+Q: de vinduer, der endnu ikke har gemt.
    quitting: Mutex<Option<HashSet<String>>>,
}

fn same(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}

/// Vinduet, der viser teksten, hvis nogen gør.
pub fn window_with(app: &AppHandle, path: &Path) -> Option<String> {
    let state = app.state::<WindowState>();
    let shows = state.shows.lock().ok()?;
    shows
        .iter()
        .find(|(_, p)| same(p, path))
        .map(|(l, _)| l.clone())
}

/// Vinduet har åbnet en tekst (document.rs `open_path`).
pub fn showing(app: &AppHandle, label: &str, path: &Path) {
    if let Ok(mut shows) = app.state::<WindowState>().shows.lock() {
        shows.insert(label.to_owned(), path.to_path_buf());
    }
}

/// Har hovedvinduet en tekst, og kan det ses? Ellers åbnes en ny fil dér i stedet for i et nyt vindue.
pub fn main_is_busy(app: &AppHandle) -> bool {
    let has_text = app
        .state::<WindowState>()
        .shows
        .lock()
        .is_ok_and(|s| s.contains_key("main"));
    let visible = app
        .get_webview_window("main")
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    has_text && visible
}

/// Hent et vindue frem og giv det fokus (ikke i testtilstand, så en test aldrig stjæler tastetryk).
pub fn focus(app: &AppHandle, label: &str) {
    if label == "main" {
        crate::show_main(app);
        return;
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        if !std::env::var("GT_TEST").is_ok_and(|v| v == "1") {
            let _ = w.set_focus();
        }
    }
}

/// Et nyt vindue, tomt eller med en tekst. Vinduet henter selv teksten (`take_pending`), når fladen er klar.
pub fn open_window(app: &AppHandle, path: Option<PathBuf>) -> Result<(), String> {
    let state = app.state::<WindowState>();
    let label = format!("tekst-{}", state.next.fetch_add(1, Ordering::SeqCst) + 1);
    if let Some(p) = path {
        if let Ok(mut pending) = state.pending.lock() {
            pending.insert(label.clone(), p);
        }
    }
    let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Gode Tekster")
        .inner_size(1280.0, 840.0)
        .min_inner_size(640.0, 480.0)
        .visible(false)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| {
            t!(
                format!("Vinduet kunne ikke åbnes: {e}"),
                format!("The window could not be opened: {e}")
            )
        })?;
    #[cfg(windows)]
    crate::contextmenu::install(&w);
    #[cfg(not(windows))]
    let _ = w;
    Ok(())
}

/// Teksten, et nyt vindue skal vise (null for et tomt vindue). Kaldes én gang fra `initial_document`.
pub fn take_pending(app: &AppHandle, label: &str) -> Option<PathBuf> {
    app.state::<WindowState>()
        .pending
        .lock()
        .ok()?
        .remove(label)
}

/// Et vindue er lukket for alvor: glem dets tekst og overvågning.
pub fn forget(app: &AppHandle, label: &str) {
    if let Ok(mut shows) = app.state::<WindowState>().shows.lock() {
        shows.remove(label);
    }
    crate::watcher::forget_window(app, label);
}

/// Ctrl+N, Ctrl+klik i biblioteket eller »Åbn i nyt vindue«. Er teksten allerede åben, hentes dens vindue.
/// Asynkron: et vindue, der oprettes i en synkron kommando, låser fast på Windows (Tauri, set i
/// trykprøven 3/10: det nye vindue blev aldrig færdigt).
#[tauri::command]
pub async fn new_window(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let path = path.map(PathBuf::from);
    if let Some(p) = &path {
        if let Some(label) = window_with(&app, p) {
            focus(&app, &label);
            return Ok(());
        }
        crate::document::choose(&app, p);
    }
    open_window(&app, path)
}

/// Er teksten åben i et andet vindue? Så hentes det frem, og svaret er sandt (main.ts åbner den ikke igen).
#[tauri::command]
pub fn focus_if_open(app: AppHandle, window: tauri::Window, path: String) -> bool {
    match window_with(&app, Path::new(&path)) {
        Some(label) if label != window.label() => {
            focus(&app, &label);
            true
        }
        _ => false,
    }
}

/// Et ekstra vindue har gemt efter »luk«: nu lukkes det helt. Hovedvinduet skjules i stedet.
#[tauri::command]
pub async fn close_window(app: AppHandle, window: tauri::WebviewWindow) {
    if window.label() == "main" {
        let _ = window.hide();
        crate::webview_visible(&app, false);
        return;
    }
    forget(&app, window.label());
    let _ = window.destroy();
}

/// Ctrl+Q og »Afslut«: alle vinduer gemmer og melder tilbage (`quit_app`). Efter 3 s lukkes der
/// alligevel; teksten ligger da i backup fra sidste gem.
#[tauri::command]
pub fn request_quit(app: AppHandle) {
    let labels: HashSet<String> = app.webview_windows().keys().cloned().collect();
    if let Ok(mut q) = app.state::<WindowState>().quitting.lock() {
        *q = Some(labels);
    }
    let _ = app.emit("quit-requested", ());
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        h.exit(0);
    });
}

/// Et vindue har gemt under Ctrl+Q. Når det sidste har, lukkes programmet.
#[tauri::command]
pub fn quit_app(app: AppHandle, window: tauri::Window) {
    let done = match app.state::<WindowState>().quitting.lock() {
        Ok(mut q) => match q.as_mut() {
            Some(left) => {
                left.remove(window.label());
                left.is_empty()
            }
            None => true,
        },
        Err(_) => true,
    };
    if done {
        app.exit(0);
    }
}

/// Titellinjen i programmets egen farve (visuel gennemgang 5/10): samme flade og tekstfarve som
/// skrivefladen (--flade, --blæk i styles.css), lys eller mørk. Windows 11 farver den gennem DWM;
/// på Windows 10 sker der intet. Kaldes fra fladen, når udseendet sættes.
#[tauri::command]
pub fn set_titlebar(window: tauri::WebviewWindow, dark: bool) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
        // COLORREF er 0x00BBGGRR. 20: mørke vinduesknapper, 35: titellinjens farve, 36: titlens.
        let (caption, text): (u32, u32) = if dark {
            (0x001e_1e1e, 0x00d4_d4d4)
        } else {
            (0x00f7_f7f7, 0x002b_2b2b)
        };
        let immersive: u32 = u32::from(dark);
        for (attr, value) in [(20u32, immersive), (35, caption), (36, text)] {
            // SAFETY: et gyldigt vindueshåndtag og en u32 på 4 byte, som DWM forventer.
            unsafe {
                DwmSetWindowAttribute(hwnd.0 as _, attr, (&value as *const u32).cast(), 4);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (window, dark);
}

/// Vinduets titel: tekstens navn uden .md (visuel gennemgang 5/10).
pub fn title_of(name: &str) -> String {
    name.strip_suffix(".md")
        .or_else(|| name.strip_suffix(".markdown"))
        .unwrap_or(name)
        .to_owned()
}
