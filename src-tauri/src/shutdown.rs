//! Når Windows lukker ned eller genstarter (fejljagt 19/10, F4-M1). `tao` svarer ikke på
//! `WM_QUERYENDSESSION` og kalder `exit(0)` ved `WM_ENDSESSION`, så de sidste 1,5 s skrivning (autogem
//! venter på en pause) gik tabt. Det samme gjaldt Restart Manager (installationsprogrammer, Windows Update).
//!
//! En subclass på hovedvinduet ser beskederne før `tao`. Ved `WM_QUERYENDSESSION` siger den, hvad
//! programmet laver (»Gemmer dine tekster …«), beder alle vinduer gemme (`flush-requested`) og
//! kører så beskedløkken i op til tre sekunder, så WebView2 kan nå at gemme og svare (`flush_done`),
//! før den svarer ja. Windows sender først `WM_ENDSESSION`, når alle har svaret, og så lukker `tao`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();
static EXPECTED: AtomicUsize = AtomicUsize::new(0);
static FLUSHED: AtomicUsize = AtomicUsize::new(0);

/// Et vindue har gemt sin tekst efter `flush-requested`.
#[tauri::command]
pub fn flush_done() {
    FLUSHED.fetch_add(1, Ordering::SeqCst);
}

#[cfg(windows)]
pub fn install(app: &AppHandle) {
    use windows_sys::Win32::UI::Shell::SetWindowSubclass;
    let _ = APP.set(app.clone());
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(hwnd) = window.hwnd() {
        // SAFETY: et gyldigt vindueshåndtag fra Tauri og en procedure, der lever hele programmets levetid.
        unsafe {
            SetWindowSubclass(hwnd.0 as _, Some(subclass), 1, 0);
        }
    }
}

#[cfg(not(windows))]
pub fn install(_app: &AppHandle) {}

#[cfg(windows)]
unsafe extern "system" fn subclass(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::System::Shutdown::{
        ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy,
    };
    use windows_sys::Win32::UI::Shell::DefSubclassProc;
    use windows_sys::Win32::UI::WindowsAndMessaging::{WM_ENDSESSION, WM_QUERYENDSESSION};

    if msg == WM_QUERYENDSESSION {
        if let Some(app) = APP.get() {
            let reason: Vec<u16> = crate::t!("Gemmer dine tekster …", "Saving your texts …")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            // SAFETY: hwnd er hovedvinduet, og teksten er nulafsluttet og lever under kaldet.
            unsafe {
                ShutdownBlockReasonCreate(hwnd, reason.as_ptr());
            }
            FLUSHED.store(0, Ordering::SeqCst);
            EXPECTED.store(crate::document::open_paths(app).len(), Ordering::SeqCst);
            let _ = app.emit("flush-requested", ());
            crate::applog::write(app, "nedlukning: beder vinduerne gemme");
            // Ventes her og ikke ved WM_ENDSESSION: den får tao's skjulte vindue måske først, og så
            // lukker programmet, før hovedvinduet når at vente (prøven 21/10). Windows venter på svaret.
            wait_for_flush(Duration::from_secs(3));
            crate::applog::write(
                app,
                &format!(
                    "nedlukning: {} af {} vinduer gemt",
                    FLUSHED.load(Ordering::SeqCst),
                    EXPECTED.load(Ordering::SeqCst)
                ),
            );
        }
        return 1;
    }
    if msg == WM_ENDSESSION {
        // SAFETY: samme vindue som ovenfor.
        unsafe {
            ShutdownBlockReasonDestroy(hwnd);
        }
    }
    // SAFETY: videre til den næste procedure i kæden (tao), med de samme argumenter.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Kør beskedløkken, til alle vinduer har gemt, eller tiden er gået. WebView2 svarer gennem
/// hovedtrådens beskeder, så uden løkken kunne intet vindue gemme, mens vi venter.
#[cfg(windows)]
fn wait_for_flush(limit: Duration) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
    };
    let start = Instant::now();
    while FLUSHED.load(Ordering::SeqCst) < EXPECTED.load(Ordering::SeqCst)
        && start.elapsed() < limit
    {
        // SAFETY: MSG er en almindelig C-struktur, som PeekMessageW fylder ud.
        unsafe {
            let mut m: MSG = std::mem::zeroed();
            while PeekMessageW(&mut m, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&m);
                DispatchMessageW(&m);
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
