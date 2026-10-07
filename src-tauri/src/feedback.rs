//! Feedback og fejlrapporter til Gode Medier (delbar udgave 3/10, plan punkt 13). Begge sendes til
//! `tekster.godemedier.dk`, der sender dem videre som mail og ikke gemmer noget. Fejlloggen kommer
//! kun med, når brugeren har sagt ja, og den indeholder aldrig tekst fra dokumenterne (applog.rs
//! skriver kun hændelser, og brugermappen står som %USER%).
//!
//! Efter et nedbrud (en Rust-panic i loggen) spørger fladen én gang, om loggen må sendes. Svaret
//! huskes som tidspunktet for den nyeste fejl, der er taget stilling til.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::json;
use tauri::AppHandle;

const BASE: &str = "https://tekster.godemedier.dk";

fn log_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::applog::dir(app)
}

/// De sidste linjer af loggen (også den forrige fil, hvis den nye er kort).
pub fn log_tail(app: &AppHandle, lines: usize) -> String {
    let Some(dir) = log_dir(app) else {
        return String::new();
    };
    let read = |n: &str| std::fs::read_to_string(dir.join(n)).unwrap_or_default();
    let all = format!("{}{}", read("gode-tekster.1.log"), read("gode-tekster.log"));
    let v: Vec<&str> = all.lines().collect();
    v[v.len().saturating_sub(lines)..].join("\n")
}

/// Tidspunktet (ms) for den nyeste panic i loggen.
fn newest_panic(log: &str) -> Option<u128> {
    log.lines()
        .filter(|l| l.contains(" FEJL panic"))
        .filter_map(|l| l.split(' ').next()?.parse().ok())
        .max()
}

fn marker(app: &AppHandle) -> Option<PathBuf> {
    log_dir(app).map(|d| d.join("fejl-besvaret.txt"))
}

fn agent() -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .user_agent(concat!("GodeTekster/", env!("CARGO_PKG_VERSION")))
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into()
}

fn post(path: &str, body: serde_json::Value) -> Result<(), String> {
    let resp = agent()
        .post(format!("{BASE}{path}"))
        .content_type("application/json")
        .send(body.to_string())
        .map_err(|_| {
            t!(
                "Beskeden kunne ikke sendes. Er computeren på nettet?",
                "The message could not be sent. Is the computer online?"
            )
            .to_owned()
        })?;
    match resp.status().as_u16() {
        200..=299 => Ok(()),
        429 => Err(t!(
            "Der er sendt mange beskeder på kort tid. Prøv igen om lidt.",
            "Many messages were sent in a short time. Try again in a moment."
        )
        .to_owned()),
        s => Err(t!(
            format!("Beskeden kunne ikke sendes (fejl {s})."),
            format!("The message could not be sent (error {s}).")
        )),
    }
}

fn about(app: &AppHandle) -> (String, String) {
    (
        app.package_info().version.to_string(),
        crate::about::windows_version(),
    )
}

/// »Se, hvad der sendes«: loggen, præcis som den ville blive sendt.
#[tauri::command]
pub fn feedback_log(app: AppHandle) -> String {
    log_tail(&app, 200)
}

/// Formularen »Skriv til Gode Medier«.
#[tauri::command]
pub async fn send_feedback(
    app: AppHandle,
    message: String,
    reply_to: String,
    include_log: bool,
) -> Result<(), String> {
    let message = message.trim().to_owned();
    if message.is_empty() {
        return Err(t!("Skriv først en besked.", "Write a message first.").to_owned());
    }
    let (version, windows) = about(&app);
    let log = if include_log {
        log_tail(&app, 200)
    } else {
        String::new()
    };
    let body = json!({
        "besked": message.chars().take(5000).collect::<String>(),
        "svar": reply_to.trim().chars().take(200).collect::<String>(),
        "version": version,
        "windows": windows,
        "log": log,
    });
    tauri::async_runtime::spawn_blocking(move || post("/feedback", body))
        .await
        .map_err(|e| e.to_string())?
}

/// Har programmet haft et nedbrud, der ikke er taget stilling til? Kun hovedvinduet spørger.
#[tauri::command]
pub fn crash_pending(app: AppHandle) -> bool {
    let Some(newest) = newest_panic(&log_tail(&app, 2000)) else {
        return false;
    };
    let answered = marker(&app)
        .and_then(|m| std::fs::read_to_string(m).ok())
        .and_then(|s| s.trim().parse::<u128>().ok())
        .unwrap_or(0);
    newest > answered
}

/// Svaret på »Må fejlloggen sendes?«. Uanset svaret spørges der ikke igen om samme fejl.
#[tauri::command]
pub async fn answer_crash(app: AppHandle, send: bool) -> Result<(), String> {
    let log = log_tail(&app, 300);
    if let (Some(newest), Some(m)) = (newest_panic(&log), marker(&app)) {
        let _ = std::fs::write(m, newest.to_string());
    }
    if !send {
        return Ok(());
    }
    let (version, windows) = about(&app);
    let body = json!({ "version": version, "windows": windows, "log": log });
    tauri::async_runtime::spawn_blocking(move || post("/fejl", body))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nyeste_panic_findes() {
        let log = "100 start\n200 FEJL panic (src/x.rs:1): boom\n300 FEJL i fladen: x\n250 FEJL panic (y): z";
        assert_eq!(newest_panic(log), Some(250));
        assert_eq!(newest_panic("100 start\n300 FEJL i fladen: x"), None);
    }
}
