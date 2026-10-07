// Først: `t!` (i18n.rs) kan kun bruges i moduler, der står efter det.
#[macro_use]
pub mod i18n;
mod about;
mod ai;
pub mod annotations;
mod applog;
mod authorship;
mod autostart;
mod claude;
mod clean;
mod codex;
mod commands;
mod contextmenu;
mod convert;
mod credentials;
mod document;
mod export;
mod feedback;
pub mod files;
mod gemini;
mod history;
mod jumplist;
mod library;
mod media;
mod merge;
mod mistral;
mod ro;
mod search;
mod session;
mod settings;
mod spelling;
mod updater;
mod watcher;
mod welcome;
mod windows;

use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

/// Viser hovedvinduet og giver det fokus. Med `GT_TEST=1` vises det uden at tage fokus, så en test
/// aldrig fanger tastetryk fra et andet program (plan 1, 2/10: tastetryk endte i en testfil).
/// Fortæl WebView2, om vinduet kan ses. Skjult holder den op med at tegne og drosler timerne som en
/// skjult browserfane. Uden det tegnede den videre efter luk (markørens blink): 4-5 % af en
/// processorkerne i baggrunden hele dagen (målt 2/10).
pub(crate) fn webview_visible(app: &AppHandle, visible: bool) {
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.with_webview(move |wv| {
            // SAFETY: COM-kald på WebView2's egen controller på UI-tråden (with_webview kører der).
            let _ = unsafe { wv.controller().SetIsVisible(visible) };
        });
    }
}

pub(crate) fn show_main(app: &AppHandle) {
    webview_visible(app, true);
    if let Some(w) = app.get_webview_window("main") {
        if std::env::var("GT_TEST").is_ok_and(|v| v == "1") {
            let _ = w.show();
            return;
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Menuen på ikonet ved uret, i programmets sprog.
fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let vis = MenuItem::with_id(
        app,
        "vis",
        t!("Vis Gode Tekster", "Show Gode Tekster"),
        true,
        None::<&str>,
    )?;
    let afslut = MenuItem::with_id(app, "afslut", t!("Afslut", "Quit"), true, None::<&str>)?;
    Menu::with_items(app, &[&vis, &afslut])
}

/// Skiftes sproget i indstillingerne, følger menuen på ikonet med.
pub(crate) fn refresh_tray(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

const TRAY_ID: &str = "gode-tekster";

/// F11: fuld skærm til og fra. Returnerer den nye tilstand.
#[tauri::command]
fn toggle_fullscreen(window: tauri::WebviewWindow) -> bool {
    let on = !window.is_fullscreen().unwrap_or(false);
    let _ = window.set_fullscreen(on);
    on
}

/// Starter programmet. Fejl sendes op til `main`, der afslutter med en kode
/// (constitution: intet `expect()` uden for tests).
pub fn run() -> tauri::Result<()> {
    let started = Instant::now();
    if std::env::args().any(|a| a == updater::AFTER_UPDATE) {
        std::thread::sleep(Duration::from_secs(2));
    }
    let app = tauri::Builder::default()
        // Single-instance først: et dobbeltklik på en fil, mens programmet kører, åbner den i det
        // vindue, der allerede findes (ADR-0014).
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // Ét vindue pr. tekst (3/10): er filen åben, hentes dens vindue. Har hovedvinduet
            // allerede en tekst, får filen sit eget vindue; ellers åbnes den i hovedvinduet.
            if let Some(arg) = argv.iter().skip(1).find(|a| !a.starts_with("--")) {
                let path = document::arg_path(arg, std::path::Path::new(&cwd));
                if let Some(label) = windows::window_with(app, &path) {
                    windows::focus(app, &label);
                    return;
                }
                document::choose(app, &path);
                if windows::main_is_busy(app) {
                    // Uden for hovedtråden: ellers låser oprettelsen af vinduet fast (Tauri på Windows).
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = windows::open_window(&app, Some(path));
                    });
                    return;
                }
                let _ = app.emit_to("main", "open-path", path.to_string_lossy().into_owned());
            }
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(document::AppState::new(started))
        .manage(watcher::WatchState::new())
        .manage(export::ExportState::default())
        .manage(claude::ClaudeState::default())
        .manage(windows::WindowState::default())
        .invoke_handler(tauri::generate_handler![
            document::open_document,
            document::initial_document,
            document::pick_document,
            document::save_document,
            document::backup_text,
            document::app_ready,
            document::test_mode,
            document::log_line,
            windows::quit_app,
            windows::request_quit,
            windows::new_window,
            windows::focus_if_open,
            windows::close_window,
            toggle_fullscreen,
            ro::ro_set,
            ro::ro_wifi,
            about::app_info,
            about::write_feedback_mail,
            about::open_licenses,
            spelling::spell_check,
            spelling::spell_add,
            updater::update_ready,
            i18n::ui_language,
            windows::set_titlebar,
            autostart::portable,
            feedback::feedback_log,
            feedback::send_feedback,
            feedback::crash_pending,
            feedback::answer_crash,
            updater::install_update_now,
            ai::ai_status,
            gemini::gemini_set_key,
            gemini::gemini_clear_key,
            mistral::mistral_set_key,
            mistral::mistral_clear_key,
            document::history_list,
            document::history_get,
            document::history_label,
            document::history_keep,
            settings::get_settings,
            settings::save_settings,
            settings::add_library,
            settings::remove_library,
            export::pick_export_path,
            export::write_export,
            export::export_pdf,
            claude::claude_cut,
            clean::claude_clean,
            claude::claude_factcheck,
            claude::claude_research,
            claude::claude_cancel,
            claude::open_url,
            merge::merge_texts,
            merge::word_diff,
            search::search_library,
            library::list_libraries,
            library::list_folder,
            library::list_all_files,
            session::recent_documents,
            library::create_file,
            library::create_folder,
            library::rename_entry,
            document::rename_open_document,
            library::delete_entry,
            library::reveal_entry,
            library::move_entry,
            library::sibling_clippings,
            library::read_clipping,
            library::read_docx,
            library::create_import,
            media::pick_image,
            media::save_image,
            watcher::watch_folder,
            watcher::check_open_file,
            commands::commands_dir,
            commands::commands_list,
            commands::command_save,
            commands::command_delete,
            commands::ai_command,
            commands::ai_design_command,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            applog::install_panic_hook(&handle);
            i18n::init(&handle);
            ro::recover(&handle);
            jumplist::refresh(&handle);
            welcome::detect(&handle);
            autostart::repair(settings::load(&handle).start_with_windows);
            updater::start(&handle);
            // Kun i testkørsler: GT_PANIK=1 går ned efter 3 s, så spørgsmålet om at sende fejlloggen
            // kan prøves ved næste start (4/10).
            if std::env::var("GT_TEST").is_ok() && std::env::var("GT_PANIK").is_ok() {
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    panic!("testnedbrud (GT_PANIK)");
                });
            }
            applog::write(&handle, "start");
            library::allow_library_images(&handle);

            // Historikken (ADR-0009). Kan den ikke åbnes, kører programmet videre uden versioner.
            if let Ok(dir) = app.path().app_local_data_dir() {
                match history::History::open(&dir.join("historik.sqlite")) {
                    Ok(h) => {
                        app.manage(h);
                        let th = handle.clone();
                        std::thread::spawn(move || {
                            if let Some(h) = th.try_state::<history::History>() {
                                if let Ok(Some(n)) = h.thin_if_due() {
                                    applog::write(
                                        &th,
                                        &format!("historik udtyndet: {n} versioner"),
                                    );
                                }
                            }
                        });
                    }
                    Err(e) => applog::write(&handle, &format!("historikken kunne ikke åbnes: {e}")),
                }
            }

            let menu = tray_menu(&handle)?;
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("Gode Tekster")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "vis" => show_main(app),
                    // Fladen gemmer først og kalder så `quit_app` (main.ts). Svarer den ikke inden
                    // for 3 s, lukkes der alligevel; teksten ligger da i backup fra sidste gem.
                    "afslut" => windows::request_quit(app.clone()),
                    _ => {}
                });
            #[cfg(windows)]
            if let Some(w) = app.get_webview_window("main") {
                contextmenu::install(&w);
            }
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Startet ved login (ADR-0014): bliv skjult, til brugeren åbner en fil eller klikker
            // på ikonet.
            let hidden = autostart::started_hidden();
            if hidden {
                webview_visible(&handle, false);
            }
            if settings::load(&handle).start_with_windows {
                autostart::apply(true);
            }
            // Nødtimer: viser vinduet, selv hvis fladen aldrig melder klar.
            std::thread::spawn(move || {
                if hidden {
                    return;
                }
                std::thread::sleep(Duration::from_millis(1500));
                if let Some(w) = handle.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        applog::write(&handle, "noedtimer viste vinduet");
                        show_main(&handle);
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Luk skjuler hovedvinduet. Programmet bliver kørende, så næste åbning er varm (ADR-0014).
            // Et ekstra vindue gemmer først og lukker så helt (close_window); efter 3 s alligevel.
            match event {
                // Hovedvinduet: fladen gemmer og skjuler selv (close_window). Første gang forklarer
                // den, at programmet bliver klar i baggrunden (delbar udgave 3/10).
                WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                    api.prevent_close();
                    let _ = window.emit_to("main", "close-requested", ());
                }
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let label = window.label().to_owned();
                    let _ = window.emit_to(label.as_str(), "close-requested", ());
                    let app = window.app_handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(3));
                        if let Some(w) = app.get_webview_window(&label) {
                            windows::forget(&app, &label);
                            let _ = w.destroy();
                        }
                    });
                }
                WindowEvent::Destroyed => windows::forget(window.app_handle(), window.label()),
                _ => {}
            }
        })
        .build(tauri::generate_context!())?;

    app.run(|app, event| match event {
        // Kun »Afslut« i bakken (med en kode) afslutter for alvor.
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        // Ligger en opdatering klar, installeres den stille nu (updater.rs).
        RunEvent::Exit => {
            // Slukkede Ro på wifi, tændes det igen, før programmet er væk (ro.rs).
            ro::on_exit(app);
            updater::install_on_exit(app);
        }
        _ => {}
    });
    Ok(())
}
