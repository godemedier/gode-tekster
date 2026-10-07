//! Ro på (5/10): F11 giver fuld skærm uden spalter (fladen skjuler dem og musemarkøren), og
//! er »Sluk wifi i Ro på« slået til i indstillingerne, slukkes wifi, til man går ud igen.
//!
//! Wifi styres med Windows' radio-API (`Windows.Devices.Radios`), som ikke kræver administrator.
//! Kun wifi-radioer, der var tændt, slukkes, og kun dem, programmet selv slukkede, tændes igen:
//! når Ro på slås fra, når vinduet lukkes, og når programmet afslutter. Går programmet ned imens,
//! ligger der et mærke i datamappen, og næste start tænder wifi igen. Et kabel røres ikke.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

/// Har programmet slukket wifi i denne kørsel?
static WIFI_OFF: AtomicBool = AtomicBool::new(false);

fn marker(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("wifi-slukket"))
}

/// Slå Ro på til eller fra for vinduet. Kører uden for hovedtråden, fordi radio-kaldet venter.
#[tauri::command(async)]
pub fn ro_set(app: AppHandle, window: tauri::WebviewWindow, on: bool) -> bool {
    let _ = window.set_fullscreen(on);
    if !on {
        wifi_back(&app);
    } else if crate::settings::load(&app).ro_wifi {
        wifi_off(&app);
    }
    on
}

/// Wifi-ikonet i Ro på (6/10: »Hvordan slår jeg det overhovedet til?«). Fladen gemmer
/// valget i indstillingerne og kalder her, så det virker med det samme og ikke først næste gang.
#[tauri::command(async)]
pub fn ro_wifi(app: AppHandle, off: bool) {
    if off {
        wifi_off(&app);
    } else {
        wifi_back(&app);
    }
}

fn wifi_off(app: &AppHandle) {
    // Testkørsler slukker aldrig brugerens wifi.
    if std::env::var("GT_TEST").is_ok() {
        return crate::applog::write(app, "ro: wifi ville være slukket (testkørsel)");
    }
    match set_wifi(false) {
        Ok(0) => {}
        Ok(_) => {
            WIFI_OFF.store(true, Ordering::Relaxed);
            if let Some(m) = marker(app) {
                let _ = std::fs::write(m, "");
            }
            crate::applog::write(app, "ro: wifi slukket");
        }
        Err(e) => crate::applog::write(app, &format!("ro: wifi kunne ikke slukkes: {e}")),
    }
}

/// Tænd wifi igen, hvis programmet slukkede det. Kaldes også ved luk og afslut.
pub fn wifi_back(app: &AppHandle) {
    if !WIFI_OFF.swap(false, Ordering::Relaxed) {
        return;
    }
    restore(app);
}

fn restore(app: &AppHandle) {
    match set_wifi(true) {
        Ok(_) => {
            if let Some(m) = marker(app) {
                let _ = std::fs::remove_file(m);
            }
            crate::applog::write(app, "ro: wifi tændt igen");
        }
        Err(e) => crate::applog::write(app, &format!("ro: wifi kunne ikke tændes: {e}")),
    }
}

/// Ved start: ligger mærket der endnu, gik programmet ned med wifi slukket. Tænd det igen.
pub fn recover(app: &AppHandle) {
    if !marker(app).is_some_and(|m| m.exists()) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || restore(&app));
}

/// Ved afslut: på en egen tråd, så radio-kaldet ikke venter på hovedtråden.
pub fn on_exit(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::spawn(move || wifi_back(&app)).join();
}

/// Tænd eller sluk alle wifi-radioer, der ikke allerede står sådan. Returnerer antallet, der skiftede.
#[cfg(windows)]
fn set_wifi(on: bool) -> windows::core::Result<u32> {
    use windows::Devices::Radios::{Radio, RadioKind, RadioState};
    let want = if on { RadioState::On } else { RadioState::Off };
    let mut changed = 0;
    for radio in Radio::GetRadiosAsync()?.join()? {
        if radio.Kind()? == RadioKind::WiFi && radio.State()? != want {
            radio.SetStateAsync(want)?.join()?;
            changed += 1;
        }
    }
    Ok(changed)
}

#[cfg(not(windows))]
fn set_wifi(_on: bool) -> Result<u32, String> {
    Ok(0)
}

#[cfg(all(test, windows))]
mod tests {
    /// Kun læsning: programmet kan se radioerne uden administrator. Skifter intet.
    #[test]
    fn radioerne_kan_laeses() {
        use windows::Devices::Radios::{Radio, RadioKind};
        let radios = Radio::GetRadiosAsync().and_then(|op| op.join());
        let Ok(radios) = radios else {
            return;
        };
        for r in radios {
            if r.Kind().is_ok_and(|k| k == RadioKind::WiFi) {
                assert!(r.State().is_ok());
                println!("wifi-radio: {:?}", r.State());
            }
        }
    }
}
