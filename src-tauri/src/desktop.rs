//! Noterne bliver fremme, når brugeren viser skrivebordet (Win+D eller hjørnet af proceslinjen,
//! ADR-0040). Windows løfter da skrivebordet op over alle almindelige vinduer, også arkene.
//!
//! Fremgangsmåden er Rainmeters (`Library/System.cpp`, kun opskriften er lånt): et skjult vindue
//! ligger nederst, og ingen andre må flytte det. Står det under skrivebordets ikonvindue, er
//! skrivebordet vist. Så lægges arkene øverst, indtil skrivebordet går ned igen, og da lægges de
//! ind lige under det vindue, brugeren gik til.

use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Ark, der er løftet øverst, mens skrivebordet er vist (vindueshåndtag som tal).
static LIFTED: Mutex<Vec<isize>> = Mutex::new(Vec::new());

/// Arket holdes nu øverst af brugeren: det skal ikke lægges ned, når skrivebordet går ned igen.
pub fn keep(hwnd: isize) {
    if let Ok(mut l) = LIFTED.lock() {
        l.retain(|&h| h != hwnd);
    }
}

#[cfg(windows)]
pub fn watch(app: AppHandle) {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, RegisterClassW, SetTimer, SetWindowPos,
        HWND_BOTTOM, MSG, WM_TIMER, WNDCLASSW, WS_DISABLED, WS_EX_TOOLWINDOW, WS_POPUP,
    };
    let _ = APP.set(app);
    std::thread::spawn(|| {
        let class = wide("GodeTeksterBund");
        // SAFETY: klassen og vinduet laves og bruges kun på denne tråd, som også læser beskederne.
        // Strengene lever hele tråden.
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let wc = WNDCLASSW {
                lpfnWndProc: Some(marker_proc),
                hInstance: instance,
                lpszClassName: class.as_ptr(),
                ..std::mem::zeroed()
            };
            if RegisterClassW(&wc) == 0 {
                return;
            }
            let marker = CreateWindowExW(
                WS_EX_TOOLWINDOW,
                class.as_ptr(),
                std::ptr::null(),
                WS_POPUP | WS_DISABLED,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if marker.is_null() {
                return;
            }
            SetWindowPos(marker, HWND_BOTTOM, 0, 0, 0, 0, FLAGS);
            // Fire gange i sekundet, som Rainmeter. Et kig koster et par mikrosekunder.
            SetTimer(marker, 1, 250, None);
            let mut shown = false;
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                if msg.message == WM_TIMER && msg.hwnd == marker {
                    let now = desktop_shown(marker, class.as_ptr());
                    if now {
                        // Også et ark, der kommer frem, mens skrivebordet er vist.
                        lift();
                    } else if shown {
                        lower();
                        SetWindowPos(marker, HWND_BOTTOM, 0, 0, 0, 0, FLAGS);
                    }
                    shown = now;
                    continue;
                }
                DispatchMessageW(&msg);
            }
        }
    });
}

#[cfg(not(windows))]
pub fn watch(_app: AppHandle) {}

#[cfg(windows)]
const FLAGS: u32 = windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOMOVE
    | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOSIZE
    | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOOWNERZORDER
    | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE
    | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOSENDCHANGING;

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// Det skjulte vindue bliver, hvor vi lægger det: andre kan ikke ændre dets plads i stablen.
/// Vores egne kald går uden om med `SWP_NOSENDCHANGING`.
#[cfg(windows)]
unsafe extern "system" fn marker_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, SWP_NOZORDER, WINDOWPOS, WM_WINDOWPOSCHANGING,
    };
    if msg == WM_WINDOWPOSCHANGING && lparam != 0 {
        // SAFETY: Windows sender en gyldig WINDOWPOS med WM_WINDOWPOSCHANGING.
        unsafe { (*(lparam as *mut WINDOWPOS)).flags |= SWP_NOZORDER };
        return 0;
    }
    // SAFETY: almindelig videresendelse af beskeden.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Står vores skjulte vindue under skrivebordets ikonvindue? Så er skrivebordet vist, men kun
/// mens forgrunden er skrivebordet, proceslinjen eller et af vores egne vinduer. Har skrivebordet
/// mistet sin plads nederst (set i den natlige test 9/10), står det over markøren hele tiden, og
/// uden den betingelse blev arkene liggende øverst over det program, brugeren arbejdede i.
#[cfg(windows)]
unsafe fn desktop_shown(marker: windows_sys::Win32::Foundation::HWND, class: *const u16) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowExW, IsWindowVisible};
    // SAFETY: kun forespørgsler på vindueshåndtag; `class` er en nul-termineret streng.
    unsafe {
        let host = icons_host();
        !host.is_null()
            && IsWindowVisible(host) != 0
            && FindWindowExW(std::ptr::null_mut(), host, class, std::ptr::null()) == marker
            && desktop_in_front(host)
    }
}

/// Er forgrunden skrivebordet selv (Win+D giver det fokus), proceslinjen eller et af vores ark (man
/// klikker i et ark, mens skrivebordet er vist)?
#[cfg(windows)]
unsafe fn desktop_in_front(host: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId,
    };
    // SAFETY: kun forespørgsler på vindueshåndtag; bufferen er lokal og stor nok.
    unsafe {
        let fg = GetForegroundWindow();
        // Intet forgrundsvindue (låst skærm, eller mens et vindue skifter) tæller ikke: i den låste
        // session i nattens test løftede det arkene for altid.
        if fg.is_null() {
            return false;
        }
        if fg == host {
            return true;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(fg, &mut pid);
        if pid == std::process::id() {
            // Kun arkene: skriver man i hovedvinduet, er skrivebordet ikke vist.
            return APP
                .get()
                .is_some_and(|app| crate::notes::handles(app).contains(&(fg as isize)));
        }
        let mut buf = [0u16; 64];
        let n = GetClassNameW(fg, buf.as_mut_ptr(), buf.len() as i32).max(0) as usize;
        let name = String::from_utf16_lossy(&buf[..n]);
        matches!(
            name.as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
        )
    }
}

/// Vinduet med skrivebordets ikoner. Fra Windows 11 24H2 er det Progman selv; før det en WorkerW,
/// der kun er synlig, mens skrivebordet er vist (Rainmeters `GetDesktopIconsHostWindow`).
#[cfg(windows)]
unsafe fn icons_host() -> windows_sys::Win32::Foundation::HWND {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, GetShellWindow, GetWindowThreadProcessId, IsWindowVisible,
    };
    let null = std::ptr::null_mut();
    let defview = wide("SHELLDLL_DefView");
    // SAFETY: kun forespørgsler på vindueshåndtag; strengene lever hele funktionen.
    unsafe {
        let shell = GetShellWindow();
        if shell.is_null() {
            return null;
        }
        let in_shell = !FindWindowExW(shell, null, defview.as_ptr(), std::ptr::null()).is_null();
        if new_shell() {
            return if in_shell { shell } else { null };
        }
        if in_shell {
            return null;
        }
        let mut shell_pid = 0;
        GetWindowThreadProcessId(shell, &mut shell_pid);
        let worker = wide("WorkerW");
        let mut w = null;
        loop {
            w = FindWindowExW(null, w, worker.as_ptr(), std::ptr::null());
            if w.is_null() {
                return null;
            }
            let mut pid = 0;
            GetWindowThreadProcessId(w, &mut pid);
            if IsWindowVisible(w) != 0
                && pid == shell_pid
                && !FindWindowExW(w, null, defview.as_ptr(), std::ptr::null()).is_null()
            {
                return w;
            }
        }
    }
}

/// Windows 11 24H2 og senere: user32 har `GetCurrentMonitorTopologyId` (Rainmeters prøve).
#[cfg(windows)]
fn new_shell() -> bool {
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    static NEW: OnceLock<bool> = OnceLock::new();
    *NEW.get_or_init(|| {
        let user32 = wide("user32.dll");
        // SAFETY: user32 er altid indlæst i et program med vinduer; navnet er nul-termineret.
        unsafe {
            let m = GetModuleHandleW(user32.as_ptr());
            !m.is_null()
                && GetProcAddress(m, c"GetCurrentMonitorTopologyId".as_ptr().cast()).is_some()
        }
    })
}

/// Arkene, der er fremme, lægges øverst. Et ark, der allerede holdes øverst, får lov at være.
/// Vinduerne ejes af hovedtråden: kaldene sendes asynkront, og ingen lås holdes imens, ellers kan
/// tråden og hovedtråden (`note_on_top` → `keep`) vente på hinanden (fejljagt 8/10).
#[cfg(windows)]
unsafe fn lift() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, IsIconic, IsWindowVisible, SetWindowPos, ShowWindowAsync, GWL_EXSTYLE,
        HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SW_SHOWNOACTIVATE, WS_EX_TOPMOST,
    };
    let Some(app) = APP.get() else {
        return;
    };
    let mut raised = Vec::new();
    for h in crate::notes::handles(app) {
        let hwnd = h as windows_sys::Win32::Foundation::HWND;
        // SAFETY: håndtag på vores egne ark; et lukket ark giver bare et fejlet kald.
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                continue;
            }
            if IsIconic(hwnd) != 0 {
                ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE);
            }
            if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST as isize != 0 {
                continue;
            }
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, FLAGS | SWP_ASYNCWINDOWPOS);
        }
        raised.push(h);
    }
    if let Ok(mut lifted) = LIFTED.lock() {
        for h in raised {
            if !lifted.contains(&h) {
                lifted.push(h);
            }
        }
    }
}

/// Skrivebordet er gået ned: de løftede ark lægges lige under det vindue, brugeren gik til, så de
/// ikke dækker det. Er det et andet ark eller et vindue, der holdes øverst, kommer de bare ned.
#[cfg(windows)]
unsafe fn lower() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowLongPtrW, IsWindow, SetWindowPos, GWL_EXSTYLE,
        HWND_NOTOPMOST, SWP_ASYNCWINDOWPOS, WS_EX_TOPMOST,
    };
    let lifted = match LIFTED.lock() {
        Ok(mut l) => std::mem::take(&mut *l),
        Err(_) => return,
    };
    // SAFETY: kun forespørgsler og pladsskift på vindueshåndtag.
    unsafe {
        let fg = GetForegroundWindow();
        let after = if fg.is_null()
            || lifted.contains(&(fg as isize))
            || GetWindowLongPtrW(fg, GWL_EXSTYLE) & WS_EX_TOPMOST as isize != 0
        {
            HWND_NOTOPMOST
        } else {
            fg
        };
        for h in lifted {
            let hwnd = h as windows_sys::Win32::Foundation::HWND;
            if IsWindow(hwnd) != 0 {
                SetWindowPos(hwnd, after, 0, 0, 0, 0, FLAGS | SWP_ASYNCWINDOWPOS);
            }
        }
    }
}
