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
    /// Vindue → hvornår det blev bestilt, så loggen viser, hvor længe et ark er om at komme frem.
    asked: Mutex<HashMap<String, std::time::Instant>>,
    /// Det forvarmede, skjulte ark uden note (ADR-0052).
    spare: Mutex<SpareSlot>,
}

/// Det forvarmede ark (ADR-0052): et skjult notevindue, hvor editoren allerede er indlæst, så en ny
/// note kan vises med det samme. Det har ingen fil, og indtil det tages i brug, er det hverken i
/// `labels`, `hwnds` eller placeringerne, så det aldrig tæller som en note.
#[derive(Debug, Default)]
pub(crate) struct SpareSlot {
    label: Option<String>,
    /// Fladen har meldt, at den venter (`note_spare`). Før det tages arket ikke i brug.
    ready: bool,
}

impl SpareSlot {
    /// Reserver pladsen til et nyt forvarmet ark. Falsk, hvis der allerede er et.
    fn reserve(&mut self, label: &str) -> bool {
        if self.label.is_some() {
            return false;
        }
        self.label = Some(label.to_owned());
        self.ready = false;
        true
    }

    fn is(&self, label: &str) -> bool {
        self.label.as_deref() == Some(label)
    }

    /// Arkets flade venter på en note. Sandt, hvis vinduet er det forvarmede.
    fn mark_ready(&mut self, label: &str) -> bool {
        let is = self.is(label);
        if is {
            self.ready = true;
        }
        is
    }

    /// Tag arket i brug, hvis det er klar. Bagefter er pladsen tom.
    fn claim(&mut self) -> Option<String> {
        if !self.ready {
            return None;
        }
        self.ready = false;
        self.label.take()
    }

    /// Arket er væk (lukket ved Afslut, eller oprettelsen fejlede).
    fn release(&mut self, label: &str) {
        if self.is(label) {
            *self = Self::default();
        }
    }
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
    open_window(app, &path, true)?;
    changed(app);
    Ok(())
}

/// Vis noten i sit eget ark. Er den allerede fremme (eller åben i et tekstvindue), hentes den frem.
fn open_window(app: &AppHandle, path: &Path, focus: bool) -> Result<(), String> {
    if let Some(label) = crate::windows::window_with(app, path) {
        crate::windows::focus(app, &label);
        return Ok(());
    }
    let place = with_places(app, |p| p.get(&key(path)).cloned()).flatten();
    // En note uden plads på denne pc (en ny) får det forvarmede ark: det har standardstørrelsen.
    // En note med en gemt størrelse kan ikke bruge det, for set_size på et skjult rammeløst ark
    // lægger titellinjen oveni (se nedenfor).
    if place.is_none() && claim_spare(app, path, focus) {
        return Ok(());
    }
    let label = next_label(app);
    adopt(app, &label, path, focus);
    let on_top = place.as_ref().is_some_and(|p| p.on_top);
    // Størrelsen gives ved oprettelsen. Sat bagefter på det skjulte, rammeløse ark lagde Windows en
    // usynlig titellinje oveni (30 px ved 100 %), så arket voksede, hver gang det kom frem igen
    // (målt 12/10: 289 → 319 → 349 → 379). På et synligt ark (rul op og ned) er set_size korrekt.
    let size = place.as_ref().map_or((WIDTH, HEIGHT), |p| {
        let scale = app
            .monitor_from_point(f64::from(p.x), f64::from(p.y))
            .ok()
            .flatten()
            .map_or(1.0, |m| m.scale_factor());
        let h = if p.rolled {
            ROLLED
        } else {
            f64::from(p.h) / scale
        };
        (f64::from(p.w) / scale, h)
    });
    let w = build_sheet(app, &label, &title_of_path(path), size, on_top)?;
    remember_hwnd(app, &label, &w);
    match place.filter(|p| on_screen(&w, p.x, p.y)) {
        Some(p) => {
            let _ = w.set_position(PhysicalPosition::new(p.x, p.y));
            // Størrelsen er givet ved oprettelsen (`size` ovenfor).
        }
        None => cascade(app, &w),
    }
    remember_place(app, path, &w);
    Ok(())
}

fn next_label(app: &AppHandle) -> String {
    let n = app
        .state::<NotesState>()
        .next
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    format!("note-{n}")
}

/// Vinduet viser noten nu: det henter den selv (`take_pending`), når fladen er klar.
fn adopt(app: &AppHandle, label: &str, path: &Path, focus: bool) {
    let state = app.state::<NotesState>();
    if let Ok(mut a) = state.asked.lock() {
        a.insert(label.to_owned(), std::time::Instant::now());
    }
    crate::windows::set_pending(app, label, path);
    if let Ok(mut l) = state.labels.lock() {
        l.insert(label.to_owned(), path.to_path_buf());
    }
    if focus {
        if let Ok(mut f) = state.focus_on_ready.lock() {
            f.insert(label.to_owned());
        }
    }
}

// --- Det forvarmede ark (ADR-0052) --------------------------------------------------------------

/// Hvor længe et taget ark må være om at vise noten, før det opgives, og noten får et nyt ark.
const SPARE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

/// Vis noten i det forvarmede ark, hvis der er et, der er klar. Falsk: lav et nyt ark som før.
fn claim_spare(app: &AppHandle, path: &Path, focus: bool) -> bool {
    let Some(label) = app
        .state::<NotesState>()
        .spare
        .lock()
        .ok()
        .and_then(|mut s| s.claim())
    else {
        return false;
    };
    let Some(w) = app.get_webview_window(&label) else {
        return false;
    };
    adopt(app, &label, path, focus);
    let _ = w.set_title(&title_of_path(path));
    remember_hwnd(app, &label, &w);
    cascade(app, &w);
    remember_place(app, path, &w);
    // Først nu: noten skal ligge klar (`set_pending`), når fladen spørger efter den.
    if w.emit_to(label.as_str(), "note-claim", ()).is_err() {
        give_up_spare(app, &label, path, focus);
        return true;
    }
    // Svarer arket ikke, lukkes det, og noten får et nyt. Ellers kunne en ny note forsvinde.
    let app = app.clone();
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        std::thread::sleep(SPARE_TIMEOUT);
        let waiting = app
            .state::<NotesState>()
            .asked
            .lock()
            .is_ok_and(|a| a.contains_key(&label));
        if waiting {
            give_up_spare(&app, &label, &path, focus);
        }
    });
    true
}

/// Det forvarmede ark svarede ikke: luk det, og vis noten i et nyt ark.
fn give_up_spare(app: &AppHandle, label: &str, path: &Path, focus: bool) {
    crate::applog::write(app, "forvarmet ark svarede ikke, nyt ark i stedet");
    if let Ok(mut a) = app.state::<NotesState>().asked.lock() {
        a.remove(label);
    }
    if let Ok(mut f) = app.state::<NotesState>().focus_on_ready.lock() {
        f.remove(label);
    }
    forget(app, label);
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.destroy();
    }
    // Pladsen er tom nu, så `open_window` laver et almindeligt ark. Placeringen er gemt, så det
    // får den samme plads og størrelse.
    if let Err(e) = open_window(app, path, focus) {
        crate::applog::write(app, &format!("ny note: {e}"));
    }
}

/// Varm et ark op om `delay`, når ingen andre ark er ved at starte. Lav prioritet: hovedvinduet og
/// arkene fra sidst skal ikke dele opstarten med det (7-14 s, da de startede samtidig 12/10).
pub fn warm_spare_later(app: &AppHandle, delay: std::time::Duration) {
    // Testscenarierne regner med »note-1«, »note-2« … i rækkefølge (measure.ts).
    if std::env::var("GT_SCENARIE").is_ok_and(|v| !v.is_empty()) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        // Vent, til ingen ark er ved at komme frem, højst et minut.
        for _ in 0..60 {
            let idle = app
                .state::<NotesState>()
                .asked
                .lock()
                .is_ok_and(|a| a.is_empty());
            if idle {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        warm_spare(&app);
    });
}

/// Ved start: kun når noterne er i brug på denne pc. Ellers koster arket hukommelse for intet.
pub fn warm_spare_at_start(app: &AppHandle) {
    let in_use = with_places(app, |p| !p.is_empty()).unwrap_or(false);
    if in_use {
        warm_spare_later(app, std::time::Duration::from_secs(20));
    }
}

fn warm_spare(app: &AppHandle) {
    let label = next_label(app);
    let reserved = app
        .state::<NotesState>()
        .spare
        .lock()
        .is_ok_and(|mut s| s.reserve(&label));
    if !reserved {
        return;
    }
    if let Err(e) = build_sheet(app, &label, "", (WIDTH, HEIGHT), false) {
        crate::applog::write(app, &format!("forvarmet ark: {e}"));
        if let Ok(mut s) = app.state::<NotesState>().spare.lock() {
            s.release(&label);
        }
    }
}

/// Afslut: det forvarmede ark har intet at gemme og lukkes, før vinduerne bliver spurgt.
pub fn drop_spare(app: &AppHandle) {
    let label = app
        .state::<NotesState>()
        .spare
        .lock()
        .ok()
        .and_then(|mut s| std::mem::take(&mut *s).label);
    if let Some(w) = label.and_then(|l| app.get_webview_window(&l)) {
        let _ = w.destroy();
    }
}

fn is_spare(app: &AppHandle, label: &str) -> bool {
    app.state::<NotesState>()
        .spare
        .lock()
        .is_ok_and(|s| s.is(label))
}

/// Fladen i et ark uden note spørger, om den skal vente på en (det forvarmede ark). Sandt: vent på
/// »note-claim«, og spørg så efter noten igen (`initial_document`).
#[tauri::command]
pub fn note_spare(app: AppHandle, window: tauri::WebviewWindow) -> bool {
    app.state::<NotesState>()
        .spare
        .lock()
        .is_ok_and(|mut s| s.mark_ready(window.label()))
}

fn title_of_path(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Et skjult, rammeløst ark. Det vises først, når fladen melder klar (`ready`).
fn build_sheet(
    app: &AppHandle,
    label: &str,
    title: &str,
    size: (f64, f64),
    on_top: bool,
) -> Result<tauri::WebviewWindow, String> {
    let w = WebviewWindowBuilder::new(app, label, WebviewUrl::App("note.html".into()))
        .title(title)
        .decorations(false)
        .shadow(true)
        .skip_taskbar(true)
        .resizable(true)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(on_top)
        .inner_size(size.0, size.1)
        .min_inner_size(180.0, ROLLED)
        .visible(false)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    hide_from_alt_tab(&w);
    #[cfg(windows)]
    crate::contextmenu::install(&w);
    Ok(w)
}

/// Arket er en note nu: `desktop.rs` skal kunne finde det (Win+D).
fn remember_hwnd(app: &AppHandle, label: &str, w: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let (Ok(hwnd), Ok(mut h)) = (w.hwnd(), app.state::<NotesState>().hwnds.lock()) {
        h.insert(label.to_owned(), hwnd.0 as isize);
    }
    #[cfg(not(windows))]
    let _ = (app, label, w);
}

/// Noten er fremme: gem placeringen, så den kommer igen samme sted.
fn remember_place(app: &AppHandle, path: &Path, w: &tauri::WebviewWindow) {
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
    let asked = app
        .state::<NotesState>()
        .asked
        .lock()
        .ok()
        .and_then(|mut a| a.remove(label));
    if let (Some(t), true) = (asked, focus) {
        crate::applog::write(
            app,
            &format!("note klar efter {} ms", t.elapsed().as_millis()),
        );
    }
    if focus {
        // Noten er brugt: varm det næste ark op, når denne er fremme.
        warm_spare_later(app, std::time::Duration::from_secs(3));
    }
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
    changed(&app);
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
    changed(&app);
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
    if let Ok(mut s) = state.spare.lock() {
        s.release(label);
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
        if is_note(&label) && !is_spare(app, &label) {
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

// --- Notelisten (Ctrl+H, menuen ved uret, springlisten) -----------------------------------------

/// Vinduet med alle noter, også dem, der er lukket.
pub const LIST: &str = "noteliste";

/// Én note i listen. `text` er hele noten uden skjulte linjer, til søgningen.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    path: String,
    title: String,
    text: String,
    modified: u64,
    open: bool,
    color: Option<String>,
}

/// En slettet note i Windows' papirkurv.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedNote {
    id: String,
    name: String,
    deleted: i64,
}

/// Teksten uden kommentarer (farvelinjen og andre skjulte blokke).
fn visible_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start..].find("-->") {
            Some(end) => rest = &rest[start + end + 3..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_owned()
}

fn color_of(raw: &str) -> Option<String> {
    const START: &str = "<!-- gt:farve vaerdi=";
    let at = raw.rfind(START)?;
    let value = &raw[at + START.len()..];
    let end = value.find(|c: char| c.is_whitespace() || c == '-')?;
    let v = &value[..end];
    (!v.is_empty() && v.chars().all(|c| c.is_ascii_lowercase())).then(|| v.to_owned())
}

/// Første linje uden overskriftstegn, som i arkets top.
fn title_of(text: &str) -> String {
    text.lines()
        .map(|l| l.trim_start_matches('#').trim())
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .chars()
        .take(120)
        .collect()
}

fn summarize(path: &Path, open: &HashSet<String>) -> Option<NoteSummary> {
    let meta = std::fs::metadata(path).ok()?;
    // En note er lille. Er filen stor, læses kun begyndelsen.
    let bytes = if meta.len() > 1_000_000 {
        use std::io::Read;
        let mut buf = vec![0; 256 * 1024];
        let n = std::fs::File::open(path).ok()?.read(&mut buf).ok()?;
        buf.truncate(n);
        buf
    } else {
        std::fs::read(path).ok()?
    };
    let raw = String::from_utf8_lossy(&bytes);
    let text = visible_text(&raw);
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Some(NoteSummary {
        path: path.to_string_lossy().into_owned(),
        title: title_of(&text),
        text: text.chars().take(20_000).collect(),
        modified,
        open: open.contains(&key(path)),
        color: color_of(&raw),
    })
}

/// Alle noter i mappen, nyeste først.
#[tauri::command]
pub async fn notes_list(app: AppHandle) -> Result<Vec<NoteSummary>, String> {
    let dir = notes_dir(&app)?;
    let open: HashSet<String> = app
        .state::<NotesState>()
        .labels
        .lock()
        .map(|l| l.values().map(|p| key(p)).collect())
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<NoteSummary> = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("md")))
            .filter_map(|p| summarize(&p, &open))
            .collect();
        out.sort_by_key(|n| std::cmp::Reverse(n.modified));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stien til en note i Noter-mappen ud fra fladens sti. Kun filnavnet bruges, så listen kun kan
/// åbne og slette noter i mappen og intet andet sted.
fn note_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let name = Path::new(path)
        .file_name()
        .filter(|n| {
            Path::new(n)
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("md"))
        })
        .ok_or_else(|| t!("Det er ikke en note.", "That is not a note.").to_owned())?;
    let full = notes_dir(app)?.join(name);
    if !full.is_file() {
        return Err(t!(
            "Noten findes ikke længere. Måske er den flyttet eller slettet.",
            "The note no longer exists. It may have been moved or deleted."
        )
        .into());
    }
    Ok(full)
}

/// Åbn en note fra listen: på sin gamle plads, hvis den har været fremme på denne pc.
#[tauri::command]
pub async fn note_open(app: AppHandle, path: String) -> Result<(), String> {
    let path = note_path(&app, &path)?;
    crate::document::choose(&app, &path);
    open_window(&app, &path, true)?;
    changed(&app);
    Ok(())
}

/// Læg en note i papirkurven fra listen (efter bekræftelse i Windows' egen dialog).
#[tauri::command]
pub async fn note_trash(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let path = note_path(&app, &path)?;
    let sure = app
        .dialog()
        .message(t!(
            "Vil du lægge noten i papirkurven? Du kan hente den igen under Papirkurven i listen.",
            "Move this note to the Recycle Bin? You can get it back under Recycle Bin in the list."
        ))
        .title(t!("Slet note", "Delete note"))
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            t!("Læg i papirkurven", "Move to Recycle Bin").into(),
            t!("Behold noten", "Keep note").into(),
        ))
        .blocking_show();
    if !sure {
        return Ok(false);
    }
    // Er noten fremme, lukkes arket først, så det ikke gemmer den igen bagefter.
    let label = app.state::<NotesState>().labels.lock().ok().and_then(|l| {
        l.iter()
            .find(|(_, p)| key(p) == key(&path))
            .map(|(k, _)| k.clone())
    });
    if let Some(label) = label {
        if let Some(w) = app.get_webview_window(&label) {
            forget(&app, &label);
            let _ = w.destroy();
        }
    }
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
    changed(&app);
    Ok(true)
}

/// Samme mappe? Papirkurven gemmer den oprindelige mappe, som Windows skrev den.
#[cfg(windows)]
fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        std::fs::canonicalize(p)
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .trim_end_matches('\\')
            .to_lowercase()
    };
    norm(a) == norm(b)
}

#[cfg(windows)]
fn trashed_notes(dir: &Path) -> Result<Vec<trash::TrashItem>, String> {
    let items = trash::os_limited::list().map_err(|e| e.to_string())?;
    Ok(items
        .into_iter()
        .filter(|i| {
            same_dir(&i.original_parent, dir)
                && Path::new(&i.name)
                    .extension()
                    .is_some_and(|x| x.eq_ignore_ascii_case("md"))
        })
        .collect())
}

#[cfg(not(windows))]
fn trashed_notes(_dir: &Path) -> Result<Vec<trash::TrashItem>, String> {
    Ok(Vec::new())
}

/// Noterne i papirkurven, nyeste sletning først.
#[tauri::command]
pub async fn notes_trashed(app: AppHandle) -> Result<Vec<TrashedNote>, String> {
    let dir = notes_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<TrashedNote> = trashed_notes(&dir)?
            .into_iter()
            .map(|i| TrashedNote {
                id: i.id.to_string_lossy().into_owned(),
                name: Path::new(&i.name)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                deleted: i.time_deleted,
            })
            .collect();
        out.sort_by_key(|n| std::cmp::Reverse(n.deleted));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hent en note tilbage fra papirkurven og vis den.
#[tauri::command]
pub async fn note_restore(app: AppHandle, id: String) -> Result<(), String> {
    let dir = notes_dir(&app)?;
    let restored = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        let item = trashed_notes(&dir)?
            .into_iter()
            .find(|i| i.id.to_string_lossy() == id)
            .ok_or_else(|| {
                t!(
                    "Noten ligger ikke længere i papirkurven.",
                    "The note is no longer in the Recycle Bin."
                )
                .to_owned()
            })?;
        let path = dir.join(&item.name);
        if path.exists() {
            return Err(t!(
                "Der findes allerede en note med samme navn. Omdøb den først.",
                "A note with the same name already exists. Rename it first."
            )
            .into());
        }
        #[cfg(windows)]
        trash::os_limited::restore_all([item]).map_err(|e| {
            format!(
                "{}: {e}",
                t!(
                    "Noten kunne ikke hentes tilbage",
                    "The note could not be restored"
                )
            )
        })?;
        Ok(path)
    })
    .await
    .map_err(|e| e.to_string())??;
    crate::document::choose(&app, &restored);
    open_window(&app, &restored, true)?;
    changed(&app);
    Ok(())
}

/// Listen tegnes om, når en note kommer til, lukkes eller slettes.
pub fn changed(app: &AppHandle) {
    let _ = app.emit_to(LIST, "notes-changed", ());
}

/// Vis notelisten: hent den frem, eller lav vinduet.
pub fn show_list(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LIST) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let w = WebviewWindowBuilder::new(app, LIST, WebviewUrl::App("noteliste.html".into()))
        .title(t!("Noter", "Notes"))
        .inner_size(400.0, 600.0)
        .min_inner_size(300.0, 320.0)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    // Højreklik uden browserens punkter (contextmenu.rs), som i hovedvinduet.
    #[cfg(windows)]
    crate::contextmenu::install(&w);
    #[cfg(not(windows))]
    let _ = w;
    Ok(())
}

/// Springlistens opgaver: programmet startes med `--noteliste` eller `--ny-note`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Task {
    List,
    New,
}

pub fn task_of(arg: &str) -> Option<Task> {
    match arg {
        "--noteliste" => Some(Task::List),
        "--ny-note" => Some(Task::New),
        _ => None,
    }
}

/// Uden for hovedtråden: ellers låser oprettelsen af vinduet fast (Tauri på Windows).
pub fn run_task(app: &AppHandle, task: Task) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match task {
            Task::List => show_list(&app),
            Task::New => new_note(&app),
        };
        if let Err(e) = result {
            crate::applog::write(&app, &format!("springliste: {e}"));
        }
    });
}

#[tauri::command]
pub async fn note_list_open(app: AppHandle) -> Result<(), String> {
    show_list(&app)
}

/// Esc og Ctrl+W i listen. Fladen har ikke selv lov at lukke vinduer.
#[tauri::command]
pub fn note_list_close(window: tauri::WebviewWindow) {
    if window.label() == LIST {
        let _ = window.destroy();
    }
}

#[cfg(test)]
mod list_tests {
    use super::*;

    #[test]
    fn text_title_and_color() {
        let raw = "# Indkøb\n\nMælk <!-- skjult -->og brød\n\n<!-- gt:farve vaerdi=groen -->\n";
        assert_eq!(visible_text(raw), "# Indkøb\n\nMælk og brød");
        assert_eq!(title_of(&visible_text(raw)), "Indkøb");
        assert_eq!(color_of(raw).as_deref(), Some("groen"));
        assert_eq!(color_of("Ingen farve"), None);
        assert_eq!(color_of("<!-- gt:farve vaerdi=<script> -->"), None);
        assert_eq!(visible_text("A <!-- åben"), "A");
        assert_eq!(title_of("\n\n   \n"), "");
    }

    #[test]
    fn forvarmet_ark_tages_kun_i_brug_naar_det_er_klar() {
        let mut slot = SpareSlot::default();
        assert!(slot.reserve("note-4"));
        // Kun ét ad gangen.
        assert!(!slot.reserve("note-5"));
        // Fladen er ikke indlæst endnu: noten får et nyt ark.
        assert_eq!(slot.claim(), None);
        // Et almindeligt ark uden note (fil slettet) skal ikke vente.
        assert!(!slot.mark_ready("note-1"));
        assert!(slot.mark_ready("note-4"));
        assert_eq!(slot.claim().as_deref(), Some("note-4"));
        // Taget i brug: det er en note nu, ikke længere det forvarmede ark.
        assert!(!slot.is("note-4"));
        assert_eq!(slot.claim(), None);
        assert!(slot.reserve("note-6"));
    }

    #[test]
    fn forvarmet_ark_der_lukkes_frigiver_pladsen() {
        let mut slot = SpareSlot::default();
        assert!(slot.reserve("note-2"));
        assert!(slot.mark_ready("note-2"));
        // Et andet ark, der lukkes, rører ikke pladsen.
        slot.release("note-1");
        assert!(slot.is("note-2"));
        slot.release("note-2");
        assert!(!slot.is("note-2"));
        assert_eq!(slot.claim(), None);
        assert!(slot.reserve("note-3"));
    }
}
