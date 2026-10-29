//! Ikonet ved uret (ADR-0068). Når der er noter fremme, bliver Gode Teksters ikon til et notesymbol,
//! og et venstreklik viser en lille oversigt over noterne (`noteoversigt.html`). Højreklik giver
//! menuen. Ikonet skiftes kun, når en note kommer frem eller lukkes, så intet kører i baggrunden.
//!
//! Windows 11 lægger et nyt ikon under pilen ^. Ønsket 29/10 er, at det altid står fremme, så
//! `promote` sætter `IsPromoted` under `HKCU\Control Panel\NotifyIconSettings` for programmets egen
//! exe-sti. Windows læser værdien, når ikonet registreres: første gang findes nøglen først, når
//! ikonet er bygget, og så registreres det igen.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Rect, WebviewUrl, WebviewWindowBuilder,
};

use crate::{notes, windows};

const ID: &str = "gode-tekster";
/// Vinduet med oversigten over noterne.
pub const OVERVIEW: &str = "noteoversigt";
/// Oversigtens størrelse (logiske pixel) og afstanden til proceslinjen og skærmkanten.
const WIDTH: f64 = 340.0;
const HEIGHT: f64 = 460.0;
const GAP: f64 = 12.0;
/// Så længe et skjult oversigtsvindue bliver liggende, før det lukkes og frigiver hukommelsen.
const KEEP: Duration = Duration::from_secs(120);

/// Notesymbolet, 32 × 32 RGBA: hvidt til en mørk proceslinje, mørkt til en lys.
const NOTE_LIGHT: &[u8] = include_bytes!("../icons/note-lys.rgba");
const NOTE_DARK: &[u8] = include_bytes!("../icons/note-moerk.rgba");

#[derive(Default)]
pub struct TrayState {
    /// Det, ikonet viser nu: antal noter fremme og lys proceslinje. Uændret giver intet kald.
    shown: Mutex<Option<(usize, bool)>>,
    /// Hvor oversigten skal stå, når den er klar første gang (`overview_ready`).
    anchor: Mutex<Option<Rect>>,
    /// Hvornår oversigten sidst skjulte sig selv. Et klik på ikonet tager fokus fra den, så den
    /// skjuler sig lige før klikket, og det klik skal lukke den, ikke åbne den igen.
    hidden_at: Mutex<Option<Instant>>,
}

/// Menuen på ikonet (højreklik), i programmets sprog.
fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, label: &str| MenuItem::with_id(app, id, label, true, None::<&str>);
    // Windows-tasten kan ikke stå som genvej i menuen (muda kender ikke META), så den står i teksten.
    let ny = item("ny-note", t!("Ny note (Win+Alt+N)", "New note (Win+Alt+N)"))?;
    let liste = item("noteliste", t!("Noteliste", "Note list"))?;
    let alle = item("vis-noter", t!("Vis alle noter", "Show all notes"))?;
    let skjul = item("skjul-noter", t!("Skjul alle noter", "Hide all notes"))?;
    let vis = item("vis", t!("Vis Gode Tekster", "Show Gode Tekster"))?;
    let afslut = item("afslut", t!("Afslut", "Quit"))?;
    let streg = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[&ny, &liste, &alle, &skjul, &streg, &vis, &afslut])
}

/// Skiftes sproget i indstillingerne, følger menuen og hjælpeteksten med.
pub fn refresh_menu(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(ID), menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
    if let Ok(mut s) = app.state::<TrayState>().shown.lock() {
        *s = None;
    }
    update(app);
}

pub fn build(app: &tauri::App, handle: &AppHandle) -> tauri::Result<()> {
    promote();
    let mut tray = TrayIconBuilder::with_id(ID)
        .tooltip("Gode Tekster")
        .menu(&menu(handle)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "vis" => crate::show_main(app),
            "ny-note" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = notes::new_note(&app);
                });
            }
            "vis-noter" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { notes::show_all(&app) });
            }
            "skjul-noter" => notes::hide_all(app),
            "noteliste" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = notes::show_list(&app);
                });
            }
            // Alle vinduer gemmer først og kalder så `quit_app`. Fejl afbryder afslutningen.
            "afslut" => windows::request_quit(app.clone(), None),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_overview(tray.app_handle(), rect);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    let tray = tray.build(app)?;
    // Første start: nøglen blev lavet af registreringen lige nu. Registrér igen, så Windows læser den.
    if promote() {
        let _ = tray.set_visible(false);
        let _ = tray.set_visible(true);
    }
    update(handle);
    Ok(())
}

/// Noterne fremme har ændret sig, eller proceslinjen har skiftet farve: skift ikon og hjælpetekst.
pub fn update(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(ID) else {
        return;
    };
    let count = notes::open_count(app);
    let light = light_taskbar();
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    if let Ok(mut s) = state.shown.lock() {
        if *s == Some((count, light)) {
            return;
        }
        *s = Some((count, light));
    }
    let icon = if count == 0 {
        app.default_window_icon().cloned()
    } else {
        Some(Image::new(
            if light { NOTE_DARK } else { NOTE_LIGHT },
            32,
            32,
        ))
    };
    let _ = tray.set_icon(icon);
    let tip = match count {
        0 => "Gode Tekster".to_owned(),
        1 => t!("Gode Tekster · 1 note fremme", "Gode Tekster · 1 note open").to_owned(),
        n => {
            if crate::i18n::english() {
                format!("Gode Tekster · {n} notes open")
            } else {
                format!("Gode Tekster · {n} noter fremme")
            }
        }
    };
    let _ = tray.set_tooltip(Some(tip));
}

/// Venstreklik: oversigten frem, eller væk igen, hvis den var fremme.
fn toggle_overview(app: &AppHandle, rect: Rect) {
    update(app);
    if let Some(w) = app.get_webview_window(OVERVIEW) {
        if w.is_visible().unwrap_or(false) {
            hide_overview(app);
            return;
        }
    }
    let just_hidden = app
        .state::<TrayState>()
        .hidden_at
        .lock()
        .ok()
        .and_then(|h| *h)
        .is_some_and(|t| t.elapsed() < Duration::from_millis(400));
    if just_hidden {
        return;
    }
    // Uden for hovedtråden: ellers låser oprettelsen af vinduet fast (Tauri på Windows).
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = show_overview(&app, rect) {
            crate::applog::write(&app, &format!("noteoversigt: {e}"));
        }
    });
}

fn show_overview(app: &AppHandle, rect: Rect) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(OVERVIEW) {
        place(app, &w, rect);
        let _ = w.emit_to(OVERVIEW, "overview-shown", ());
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    if let Ok(mut a) = app.state::<TrayState>().anchor.lock() {
        *a = Some(rect);
    }
    // Skjult, til fladen har tegnet noterne (`overview_ready`), så den ikke blinker hvid.
    let w = WebviewWindowBuilder::new(app, OVERVIEW, WebviewUrl::App("noteoversigt.html".into()))
        .title(t!("Noter", "Notes"))
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    notes::hide_from_alt_tab(&w);
    #[cfg(windows)]
    crate::contextmenu::install(&w);
    Ok(())
}

/// Over ikonet: midt over det, inden for skærmen, og lige over proceslinjen (eller under, når
/// proceslinjen står øverst).
fn place(app: &AppHandle, w: &tauri::WebviewWindow, rect: Rect) {
    let pos: PhysicalPosition<f64> = rect.position.to_physical(1.0);
    let size: tauri::PhysicalSize<f64> = rect.size.to_physical(1.0);
    let Some(m) = app.monitor_from_point(pos.x, pos.y).ok().flatten() else {
        return;
    };
    let scale = m.scale_factor();
    let (ww, wh, gap) = (WIDTH * scale, HEIGHT * scale, GAP * scale);
    let area = m.work_area();
    let (ax, ay) = (f64::from(area.position.x), f64::from(area.position.y));
    let (aw, ah) = (f64::from(area.size.width), f64::from(area.size.height));
    let x = (pos.x + size.width / 2.0 - ww / 2.0).clamp(ax + gap, (ax + aw - ww - gap).max(ax));
    let y = if pos.y > ay + ah / 2.0 {
        ay + ah - wh - gap
    } else {
        ay + gap
    };
    let _ = w.set_position(PhysicalPosition::new(x as i32, y as i32));
}

/// Fladen har tegnet noterne første gang: vis den ved ikonet.
#[tauri::command]
pub fn overview_ready(app: AppHandle, window: tauri::WebviewWindow) {
    if window.label() != OVERVIEW {
        return;
    }
    let anchor = app
        .state::<TrayState>()
        .anchor
        .lock()
        .ok()
        .and_then(|mut a| a.take());
    if let Some(rect) = anchor {
        place(&app, &window, rect);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Esc, et klik på en note eller et klik et andet sted. Fladen har ikke selv lov at skjule vinduer.
#[tauri::command]
pub fn overview_hide(app: AppHandle, window: tauri::WebviewWindow) {
    if window.label() == OVERVIEW {
        hide_overview(&app);
    }
}

/// Oversigten mistede fokus (lib.rs, vindueshændelser).
pub fn overview_blurred(app: &AppHandle) {
    hide_overview(app);
}

fn hide_overview(app: &AppHandle) {
    let Some(w) = app.get_webview_window(OVERVIEW) else {
        return;
    };
    if !w.is_visible().unwrap_or(false) {
        return;
    }
    let _ = w.hide();
    let now = Instant::now();
    if let Ok(mut h) = app.state::<TrayState>().hidden_at.lock() {
        *h = Some(now);
    }
    // Vinduet bruger omkring 30 MB. Bliver det ikke hentet frem igen inden for to minutter, lukkes det.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(KEEP);
        let still = app
            .state::<TrayState>()
            .hidden_at
            .lock()
            .ok()
            .and_then(|h| *h)
            .is_some_and(|t| t == now);
        if let Some(w) = app.get_webview_window(OVERVIEW) {
            if still && !w.is_visible().unwrap_or(true) {
                let _ = w.destroy();
            }
        }
    });
}

/// Proceslinjen er lys (`SystemUsesLightTheme`). Mangler værdien, er den mørk, som i Windows 11.
#[cfg(windows)]
fn light_taskbar() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let name = wide("SystemUsesLightTheme");
    let mut value: u32 = 0;
    let mut bytes = 4u32;
    // SAFETY: nul-terminerede UTF-16-strenge og en DWORD-buffer på 4 byte.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut value as *mut u32).cast(),
            &mut bytes,
        )
    };
    status == 0 && value == 1
}

#[cfg(not(windows))]
fn light_taskbar() -> bool {
    false
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

/// Sæt `IsPromoted = 1` for programmets egen exe-sti. Sand, hvis noget blev ændret. Testkørsler
/// (`GT_TEST=1`) rører ikke registreringsdatabasen.
#[cfg(windows)]
fn promote() -> bool {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, RegSetKeyValueW, HKEY,
        HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_DWORD, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };
    if std::env::var("GT_TEST").is_ok_and(|v| v == "1") {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let exe = exe.to_string_lossy().to_lowercase();
    let root_path = wide(r"Control Panel\NotifyIconSettings");
    let mut root: HKEY = std::ptr::null_mut();
    // SAFETY: nul-termineret sti, og `root` lukkes nedenfor.
    if unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            root_path.as_ptr(),
            0,
            KEY_READ | KEY_SET_VALUE,
            &mut root,
        )
    } != 0
    {
        return false;
    }
    let path_name = wide("ExecutablePath");
    let promoted_name = wide("IsPromoted");
    let mut changed = false;
    for index in 0u32.. {
        let mut name = [0u16; 64];
        let mut len = name.len() as u32;
        // SAFETY: en buffer, hvis længde i tegn står i `len`. Resten må være null.
        let status = unsafe {
            RegEnumKeyExW(
                root,
                index,
                name.as_mut_ptr(),
                &mut len,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if status != 0 {
            break;
        }
        let sub = &name[..=len as usize];
        let mut buf = [0u16; 1024];
        let mut bytes = (buf.len() * 2) as u32;
        // SAFETY: nul-terminerede navne og en buffer, hvis størrelse står i `bytes`.
        let ok = unsafe {
            RegGetValueW(
                root,
                sub.as_ptr(),
                path_name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut bytes,
            )
        } == 0;
        let n = (bytes as usize / 2).saturating_sub(1).min(buf.len());
        if !ok || String::from_utf16_lossy(&buf[..n]).to_lowercase() != exe {
            continue;
        }
        let mut value: u32 = 0;
        let mut size = 4u32;
        // SAFETY: som ovenfor, med en DWORD-buffer.
        let current = unsafe {
            RegGetValueW(
                root,
                sub.as_ptr(),
                promoted_name.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        if current == 0 && value == 1 {
            continue;
        }
        let one: u32 = 1;
        // SAFETY: nul-terminerede navne og en DWORD på 4 byte.
        let set = unsafe {
            RegSetKeyValueW(
                root,
                sub.as_ptr(),
                promoted_name.as_ptr(),
                REG_DWORD,
                (&one as *const u32).cast(),
                4,
            )
        };
        changed |= set == 0;
    }
    // SAFETY: nøglen blev åbnet ovenfor.
    unsafe { RegCloseKey(root) };
    changed
}

#[cfg(not(windows))]
fn promote() -> bool {
    false
}
