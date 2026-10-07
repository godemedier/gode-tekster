//! Lokal logfil i `<data>\log` (ADR-0006). Kun hændelser, tider og fejlbeskeder, aldrig tekstindhold.
//! Delbar udgave 3/10: loggen roterer (højst 1 MB, én gammel fil ved siden af), og Rust-panics og
//! fejl i fladen skrives også, så en bruger kan sende den med, når noget går galt. Brugernavnet
//! erstattes med %USER% i stier, så loggen kan deles.

use std::io::Write;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const MAX_BYTES: u64 = 1_000_000;

pub(crate) fn dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("log"))
}

/// Brugermappen i stier bliver til %USER%, så loggen ikke afslører, hvem man er.
pub fn scrub(event: &str) -> String {
    let Some(home) = std::env::var_os("USERPROFILE") else {
        return event.to_owned();
    };
    let home = home.to_string_lossy().into_owned();
    if home.len() < 4 {
        return event.to_owned();
    }
    event
        .replace(&home, "%USER%")
        .replace(&home.replace('\\', "/"), "%USER%")
}

pub fn write(app: &AppHandle, event: &str) {
    let Some(dir) = dir(app) else { return };
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("gode-tekster.log");
    if std::fs::metadata(&file).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&file, dir.join("gode-tekster.1.log"));
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
    {
        let _ = writeln!(f, "{ts} {}", scrub(event));
    }
}

/// Rust-panics i loggen (også i release, hvor panic = "abort": hooket kører før programmet stopper).
pub fn install_panic_hook(app: &AppHandle) {
    let app = app.clone();
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let at = info
            .location()
            .map(|l| format!(" ({}:{})", l.file(), l.line()))
            .unwrap_or_default();
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        write(
            &app,
            &format!(
                "FEJL panic{at}: {}",
                msg.chars().take(300).collect::<String>()
            ),
        );
        default(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brugermappen_skjules() {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let h = home.to_string_lossy();
            let line = scrub(&format!("kunne ikke gemme {h}\\Documents\\a.md"));
            assert!(line.contains("%USER%\\Documents"), "{line}");
            assert!(!line.contains(h.as_ref()));
        }
    }
}
