//! Indstillinger i `<data>\settings.json` (ADR-0015, design runde 4). Fejl ved læsning giver
//! standardværdierne: et program, der ikke starter på grund af en indstillingsfil, er værre end
//! et, der har glemt skriften.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Mapperne i venstre panel. Ingen fra start: første start lægger `Dokumenter\Gode Tekster`
    /// ind (welcome.rs, delbar udgave 3/10).
    pub libraries: Vec<PathBuf>,
    pub font: String,
    /// »Dit navn« til byline og forfatterskab. Ikke sat: Office' brugernavn (som Word bruger), ellers tomt.
    pub author_name: Option<String>,
    /// AI-hjælpen: "claude", "codex", "gemini" eller "mistral". Ikke sat: den første, der er klar (ai.rs).
    pub ai_provider: Option<String>,
    /// Tegn pr. linje, 50 til 90 (skyderen i indstillingerne).
    pub line_length: u32,
    /// `guillemets` (»…«), `curly` (”…”) eller `low` („…“). ADR-0012.
    pub quotes: String,
    pub always_show_count: bool,
    pub show_authorship: bool,
    pub dark: bool,
    pub start_with_windows: bool,
    /// Hent opdateringer af sig selv (updater.rs). Til som standard.
    pub check_updates: bool,
    /// Afsnit: "luft" (tom linje imellem) eller "indryk" (som i bøger). 3/10.
    pub paragraphs: String,
    /// Punkttegn i lister: "streg", "prik", "pil", "stjerne" eller "ring" (5/10).
    pub bullet_style: String,
    /// Ordklasser, der ikke farves ("n", "v", "a", "d", "c"), valgt i fanen Sprog (5/10).
    pub hidden_word_classes: Vec<String>,
    /// Stjernemarkerede mapper og filer i biblioteket, der altid står øverst (5/10).
    pub starred: Vec<String>,
    /// Sproget: "auto" (følger Windows), "da" eller "en" (i18n.rs, 5/10).
    pub language: String,
    pub show_house_files: bool,
    pub focus_mode: bool,
    pub typewriter: bool,
    /// Sluk wifi, mens Ro på er slået til (ro.rs, 5/10).
    pub ro_wifi: bool,
    /// Skjul markdown-tegnene, også hvor markøren står, som i Word (livePreview.ts, 6/10).
    pub hide_marks: bool,
    pub word_classes: bool,
    /// Dansk stiltjek uden AI (F7), med Gode Ords regler.
    pub style_check: bool,
    /// `date` eller `name`.
    pub sort_by: String,
    pub newest_first: bool,
    pub folders_first: bool,
    /// Mappen med brugerens egne »/«-kommandoer (commands.rs). Sættes af Rust, første gang mappen
    /// laves, så den ikke flytter sig ved sprogskift. Fladen kan ikke flytte den (`save_settings`).
    pub commands_dir: Option<PathBuf>,
    /// Navne på kommandoer, der er slået fra i fanen Kommandoer.
    pub disabled_commands: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            libraries: Vec::new(),
            font: "IBM Plex Mono".to_owned(),
            author_name: None,
            ai_provider: None,
            line_length: 72,
            quotes: "guillemets".to_owned(),
            always_show_count: false,
            show_authorship: true,
            dark: false,
            // Slået fra, til brugeren slår det til: ellers skriver en testudgave sig ind i
            // opstarten.
            start_with_windows: false,
            check_updates: true,
            paragraphs: "luft".to_owned(),
            bullet_style: "streg".to_owned(),
            hidden_word_classes: Vec::new(),
            starred: Vec::new(),
            language: "auto".to_owned(),
            show_house_files: false,
            focus_mode: false,
            typewriter: false,
            ro_wifi: false,
            hide_marks: false,
            word_classes: false,
            style_check: false,
            sort_by: "date".to_owned(),
            newest_first: true,
            folders_first: true,
            commands_dir: None,
            disabled_commands: Vec::new(),
        }
    }
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

/// Findes indstillingsfilen? Nej betyder første start (welcome.rs).
pub fn exists(app: &AppHandle) -> bool {
    file(app).is_some_and(|f| f.exists())
}

pub fn load(app: &AppHandle) -> Settings {
    file(app)
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    load(&app)
}

fn write(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let f = file(app).ok_or(t!(
        "Programmets datamappe kunne ikke findes.",
        "The app's data folder could not be found."
    ))?;
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(|e| {
            t!(
                format!("Programmets datamappe kunne ikke laves: {e}"),
                format!("The app's data folder could not be created: {e}")
            )
        })?;
    }
    let not_saved = |e: &dyn std::fmt::Display| {
        t!(
            format!("Indstillingerne kunne ikke gemmes: {e}"),
            format!("The settings could not be saved: {e}")
        )
    };
    let json = serde_json::to_vec_pretty(settings).map_err(|e| not_saved(&e))?;
    std::fs::write(f, json).map_err(|e| not_saved(&e))?;
    // Alle vinduer får besked, så skrift, tilstande og biblioteker følges ad (ét vindue pr. tekst).
    let _ = app.emit("settings-changed", ());
    Ok(())
}

/// Gemmer alt undtagen bibliotekerne. De afgør, hvor programmet må læse og skrive (library.rs
/// `guard`), så de ændres kun gennem Windows' mappevælger i Rust (`add_library`), aldrig af
/// fladen alene (sikkerhedsreview 2/10). Det samme gælder kommandomappen (commands.rs).
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let stored = load(&app);
    let settings = Settings {
        libraries: stored.libraries,
        commands_dir: stored.commands_dir,
        ..settings
    };
    // Sproget først: write sender settings-changed, og vinduerne spørger så om sproget (main.ts).
    crate::i18n::apply(&settings.language);
    crate::refresh_tray(&app);
    write(&app, &settings)?;
    crate::autostart::apply(settings.start_with_windows);
    // Stjerner eller sprog kan være ændret.
    crate::jumplist::refresh(&app);
    Ok(())
}

/// Læg en mappe ind som bibliotek fra Rust (mappevælgeren eller første start, aldrig fladen).
pub fn add_library_path(app: &AppHandle, dir: &std::path::Path) {
    let mut settings = load(app);
    if settings.libraries.iter().any(|l| {
        l.to_string_lossy()
            .eq_ignore_ascii_case(&dir.to_string_lossy())
    }) {
        return;
    }
    crate::library::allow_images(app, dir);
    settings.libraries.push(dir.to_path_buf());
    let _ = write(app, &settings);
}

/// Husk kommandomappen. Kun fra Rust (commands.rs), aldrig fra fladen.
pub fn set_commands_dir(app: &AppHandle, dir: &std::path::Path) -> Result<(), String> {
    let mut settings = load(app);
    settings.commands_dir = Some(dir.to_path_buf());
    write(app, &settings)
}

/// »Tilføj mappe …«: Brugeren vælger selv mappen i Windows' mappevælger. Returnerer den nye liste.
#[tauri::command]
pub async fn add_library(app: AppHandle) -> Result<Vec<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title(t!(
            "Vælg en mappe til biblioteket",
            "Choose a folder for the library"
        ))
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok());
    let mut settings = load(&app);
    if let Some(dir) = picked {
        let known = settings.libraries.iter().any(|l| {
            l.to_string_lossy()
                .eq_ignore_ascii_case(&dir.to_string_lossy())
        });
        if !known {
            add_library_path(&app, &dir);
            settings = load(&app);
        }
    }
    Ok(settings.libraries)
}

/// Fjern et bibliotek fra listen. Mappen selv røres ikke.
#[tauri::command]
pub fn remove_library(app: AppHandle, path: String) -> Result<Vec<PathBuf>, String> {
    let mut settings = load(&app);
    settings
        .libraries
        .retain(|l| !l.to_string_lossy().eq_ignore_ascii_case(&path));
    write(&app, &settings)?;
    Ok(settings.libraries)
}

/// Navnet til byline og forfatterskab: indstillingen, ellers det navn, Office bruger, ellers tomt.
pub fn author_name(app: &AppHandle) -> String {
    match load(app).author_name {
        Some(n) => n.trim().to_owned(),
        None => crate::about::office_user_name(),
    }
}
