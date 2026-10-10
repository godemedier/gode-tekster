//! Eksport (ADR-0011, -0018): PDF via WebView2's `PrintToPdf` og Word-filer, som fladen bygger.
//!
//! Fladen må kun skrive til den sti, brugeren selv har valgt i Gem-dialogen. Stien huskes her, når
//! dialogen lukkes, og bruges én gang. Så kan en fejl i fladen aldrig skrive et andet sted hen.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use crate::applog;

#[derive(Default)]
pub struct ExportState {
    target: Mutex<Option<PathBuf>>,
}

/// Gem-dialogen. `kind` er `pdf` eller `docx`. Navnet foreslås ud fra teksten, i samme mappe.
#[tauri::command]
pub async fn pick_export_path(
    app: AppHandle,
    state: State<'_, ExportState>,
    source: String,
    kind: String,
    title: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (label, ext) = match kind.as_str() {
        "pdf" => ("PDF", "pdf"),
        "docx" => ("Word", "docx"),
        _ => return Err(t!("Ukendt filtype.", "Unknown file type.").to_owned()),
    };
    let src = PathBuf::from(&source);
    // Navnet følger tekstens overskrift (9/10), ellers .md-filens navn.
    let stem = title
        .as_deref()
        .and_then(file_name_from_title)
        .or_else(|| src.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| t!("Tekst", "Text").to_owned());
    let mut dialog = app
        .dialog()
        .file()
        .add_filter(label, &[ext])
        .set_file_name(format!("{stem}.{ext}"));
    if let Some(dir) = src.parent() {
        dialog = dialog.set_directory(dir);
    }
    let picked = dialog.blocking_save_file().and_then(|p| p.into_path().ok());
    if let Ok(mut t) = state.target.lock() {
        *t = picked.clone();
    }
    Ok(picked.map(|p| p.to_string_lossy().into_owned()))
}

/// Et filnavn af en overskrift: tegn, Windows ikke tillader, og kontroltegn væk, mellemrum samlet,
/// intet punktum eller mellemrum sidst, højst 120 tegn, og aldrig et af Windows' reserverede navne.
/// `None`, når intet brugbart er tilbage.
pub fn file_name_from_title(title: &str) -> Option<String> {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let mut name = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.chars().count() > 120 {
        name = name.chars().take(120).collect();
    }
    let name = name
        .trim_end_matches(|c: char| !c.is_alphanumeric() && c != ')' && c != ']')
        .trim()
        .to_owned();
    let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((base.starts_with("COM") || base.starts_with("LPT"))
            && base.len() == 4
            && base.as_bytes()[3].is_ascii_digit());
    (!name.is_empty() && !reserved).then_some(name)
}

fn take_target(state: &ExportState) -> Result<PathBuf, String> {
    state
        .target
        .lock()
        .ok()
        .and_then(|mut t| t.take())
        .ok_or_else(|| {
            t!(
                "Vælg først, hvor filen skal gemmes.",
                "First choose where to save the file."
            )
            .to_owned()
        })
}

/// Skriv en Word-fil, fladen har bygget. Atomisk som alle andre gem (`files::write_atomic`).
#[tauri::command]
pub async fn write_export(
    app: AppHandle,
    state: State<'_, ExportState>,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let target = take_target(&state)?;
    crate::files::write_atomic(&target, &bytes).map_err(|e| match e {
        crate::files::FileError::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied => t!(
            "Filen kunne ikke gemmes. Er den åben i Word? Luk den, og prøv igen.",
            "The file could not be saved. Is it open in Word? Close it and try again."
        )
        .to_owned(),
        e => e.to_string(),
    })?;
    applog::write(&app, "eksporterede en Word-fil");
    set_last_export(target.clone());
    Ok(target.to_string_lossy().into_owned())
}

/// Margener i centimeter, som skabelonens `@page`. Sættes også i API'et, fordi det er
/// udokumenteret, om WebView2 respekterer CSS'ens (ADR-0011).
#[derive(Deserialize)]
pub struct Margins {
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

/// PDF af det, der lige nu står i print-DOM'en (fladen har tegnet den, før den kalder).
#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    state: State<'_, ExportState>,
    margins: Margins,
) -> Result<String, String> {
    let target = take_target(&state)?;
    let window = app
        .get_webview_window("main")
        .ok_or(t!("Vinduet findes ikke.", "The window does not exist."))?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let path = target.clone();
    window
        .with_webview(move |wv| {
            if let Err(e) = print_to_pdf(&wv, &path, &margins, tx.clone()) {
                let _ = tx.send(Err(e));
            }
        })
        .map_err(|e| {
            t!(
                format!("PDF'en kunne ikke laves: {e}"),
                format!("The PDF could not be created: {e}")
            )
        })?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(60))
            .unwrap_or_else(|_| {
                Err(t!(
                    "PDF'en blev ikke færdig inden for et minut.",
                    "The PDF was not finished within a minute."
                )
                .to_owned())
            })
    })
    .await
    .map_err(|e| format!("PDF'en kunne ikke laves: {e}"))?;
    result?;
    applog::write(&app, "eksporterede en PDF");
    set_last_export(target.clone());
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn print_to_pdf(
    wv: &tauri::webview::PlatformWebview,
    path: &std::path::Path,
    m: &Margins,
    tx: std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    const CM: f64 = 1.0 / 2.54;
    let err = |e: windows_core::Error| {
        t!(
            format!("PDF'en kunne ikke laves: {e}"),
            format!("The PDF could not be created: {e}")
        )
    };
    // SAFETY: COM-kald på WebView2's egne objekter på UI-tråden (with_webview kører der).
    unsafe {
        let core = wv.controller().CoreWebView2().map_err(err)?;
        let core7: ICoreWebView2_7 = core.cast().map_err(err)?;
        let env6: ICoreWebView2Environment6 = wv.environment().cast().map_err(err)?;
        let settings = env6.CreatePrintSettings().map_err(err)?;
        settings.SetPageWidth(21.0 * CM).map_err(err)?;
        settings.SetPageHeight(29.7 * CM).map_err(err)?;
        settings.SetMarginTop(m.top * CM).map_err(err)?;
        settings.SetMarginRight(m.right * CM).map_err(err)?;
        settings.SetMarginBottom(m.bottom * CM).map_err(err)?;
        settings.SetMarginLeft(m.left * CM).map_err(err)?;
        settings.SetShouldPrintHeaderAndFooter(false).map_err(err)?;
        settings.SetShouldPrintBackgrounds(false).map_err(err)?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
            let _ = tx.send(match hr {
                Ok(()) if ok => Ok(()),
                Ok(()) => Err(t!(
                    "PDF'en kunne ikke gemmes. Er filen åben i et andet program?",
                    "The PDF could not be saved. Is the file open in another program?"
                )
                .to_owned()),
                Err(e) => Err(t!(
                    format!("PDF'en kunne ikke laves: {e}"),
                    format!("The PDF could not be created: {e}")
                )),
            });
            Ok(())
        }));
        core7
            .PrintToPdf(&HSTRING::from(path.as_os_str()), &settings, &handler)
            .map_err(err)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::file_name_from_title;

    #[test]
    fn filnavn_af_overskrift() {
        assert_eq!(
            file_name_from_title("Byrådet vil lukke havnebadet før tid").as_deref(),
            Some("Byrådet vil lukke havnebadet før tid")
        );
        assert_eq!(
            file_name_from_title("Hvad koster det? 50/50: »ja« eller \"nej\"").as_deref(),
            Some("Hvad koster det 50 50 »ja« eller nej")
        );
        assert_eq!(
            file_name_from_title("Slut med punktum.").as_deref(),
            Some("Slut med punktum")
        );
        assert_eq!(file_name_from_title("  ***  "), None);
        assert_eq!(file_name_from_title("CON"), None);
        assert_eq!(file_name_from_title("?:*"), None);
        assert_eq!(
            file_name_from_title(&"a".repeat(300)).map(|n| n.chars().count()),
            Some(120)
        );
    }
}

static LAST_EXPORT: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);

pub fn set_last_export(path: std::path::PathBuf) {
    if let Ok(mut guard) = LAST_EXPORT.lock() {
        *guard = Some(path);
    }
}

#[tauri::command]
pub fn open_last_export(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = LAST_EXPORT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(path) = path {
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|_| t!("Filen kunne ikke åbnes.", "The file could not be opened.").to_owned())
    } else {
        Err(t!("Ingen nylig fil.", "No recent file.").to_owned())
    }
}
