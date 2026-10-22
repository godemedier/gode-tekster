//! Indstillinger i `<data>\settings.json` (ADR-0015, design runde 4). Fejl ved læsning giver
//! standardværdierne: et program, der ikke starter på grund af en indstillingsfil, er værre end
//! et, der har glemt skriften.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusDef {
    pub id: String,
    pub name: String,
}

/// Idé · Kladde · Til gennemsyn · Færdig (8/10). Id'et `igang` er det gamle navn og bliver
/// stående, fordi filerne gemmer id'et.
fn default_statuses() -> Vec<StatusDef> {
    [
        ("ide", "Idé"),
        ("igang", "Kladde"),
        ("gennemsyn", "Til gennemsyn"),
        ("faerdig", "Færdig"),
    ]
    .into_iter()
    .map(|(id, name)| StatusDef {
        id: id.to_owned(),
        name: name.to_owned(),
    })
    .collect()
}

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
    pub audio_tools_dir: Option<PathBuf>,
    /// Tegn pr. linje, 50 til 90 (skyderen i indstillingerne).
    pub line_length: u32,
    /// `guillemets` (»…«), `curly` (”…”) eller `low` („…“). ADR-0012.
    pub quotes: String,
    pub always_show_count: bool,
    pub show_authorship: bool,
    /// Afløst af `theme` (8/10). Læses kun fra ældre filer: `true` bliver til "moerk".
    pub dark: bool,
    /// Udseendet (ADR-0037): "lys", "moerk", "aften" eller "auto" (lys om dagen, aften fra
    /// solnedgang til solopgang).
    pub theme: String,
    /// Statusserne i biblioteket (ADR-0038). Filen gemmer id'et, så et nyt navn ikke mister teksterne.
    /// Den sidste betyder færdig.
    pub statuses: Vec<StatusDef>,
    pub start_with_windows: bool,
    /// Hent opdateringer af sig selv (updater.rs). Til som standard.
    pub check_updates: bool,
    /// Afsnit: "luft" (tom linje imellem) eller "indryk" (som i bøger). 3/10.
    pub paragraphs: String,
    /// Punkttegn i lister: "streg", "prik", "pil", "stjerne" eller "ring" (5/10).
    pub bullet_style: String,
    /// Ordklasser, der ikke farves ("n", "v", "a", "d", "c"), valgt i fanen Sprog. Fra start farves
    /// kun tillægsord og biord, som er dem, man luger ud i (21/10). Derefter det, brugeren valgte sidst.
    pub word_classes_off: Vec<String>,
    /// Afløst af `word_classes_off` (21/10). Læses kun fra ældre filer: et valg dér bliver stående,
    /// en tom liste (aldrig valgt) giver den nye standard.
    #[serde(skip_serializing)]
    pub hidden_word_classes: Vec<String>,
    /// Stjernemarkerede mapper og filer i biblioteket, der altid står øverst (5/10).
    pub starred: Vec<String>,
    /// Sproget: "auto" (følger Windows), "da" eller "en" (i18n.rs, 5/10).
    pub language: String,
    /// Sproget i teksten (til stavekontrol, orddeling mv.). "da", "en", "de", "fr" osv.
    pub text_language: Option<String>,
    pub show_house_files: bool,
    pub focus_mode: bool,
    pub typewriter: bool,
    /// Sluk wifi, mens Ro på er slået til (ro.rs, 5/10).
    pub ro_wifi: bool,
    /// Afløst af `mark_mode` (7/10). Læses kun fra ældre filer: `true` bliver til "skjul".
    pub hide_marks: bool,
    /// Visning af markdown (livePreview.ts, 7/10): "skjul" (aldrig tegn), "markoer" (tegn hvor
    /// markøren står), "alle" (tegn og formatering) eller "raa" (kun ren markdown).
    pub mark_mode: String,
    pub word_classes: bool,
    /// Dansk stiltjek uden AI (F7), reglerne i src/sprog/.
    pub style_check: bool,
    /// Kommatjek i stiltjekket (grammar.ts, 7/10): "start" (med startkomma), "uden" (uden
    /// startkomma) eller "fra". Standard er med startkomma.
    pub comma_style: String,
    /// Stiltjekket viser også de usikre regler (styleRules.ts, målebænken 12/10). Fra som standard.
    pub strict_style: bool,
    /// Stiltjekkets kategorier, der er slået fra i fanen Sprog (styleCheck.ts, fase 1 13/10).
    pub hidden_style: Vec<String>,
    /// Antal »Ikke nyttigt« pr. regel. Kun lokalt, til næste måling af reglerne (ADR-0051).
    pub style_not_useful: std::collections::BTreeMap<String, u32>,
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
            font: "Recursive Halvmono".to_owned(),
            author_name: None,
            ai_provider: None,
            audio_tools_dir: None,
            line_length: 72,
            quotes: "low".to_owned(),
            always_show_count: false,
            show_authorship: true,
            dark: false,
            theme: "lys".to_owned(),
            statuses: default_statuses(),
            // Slået fra, til brugeren slår det til: ellers skriver en testudgave sig ind i
            // opstarten.
            start_with_windows: false,
            check_updates: true,
            paragraphs: "luft".to_owned(),
            bullet_style: "streg".to_owned(),
            word_classes_off: ["n", "v", "c"].map(String::from).to_vec(),
            hidden_word_classes: Vec::new(),
            starred: Vec::new(),
            language: "auto".to_owned(),
            text_language: None,
            show_house_files: false,
            focus_mode: false,
            typewriter: false,
            ro_wifi: false,
            hide_marks: false,
            mark_mode: "markoer".to_owned(),
            word_classes: false,
            style_check: false,
            comma_style: "start".to_owned(),
            strict_style: false,
            hidden_style: Vec::new(),
            style_not_useful: std::collections::BTreeMap::new(),
            sort_by: "date".to_owned(),
            newest_first: true,
            folders_first: true,
            commands_dir: None,
            disabled_commands: Vec::new(),
        }
    }
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    crate::paths::data_dir(app)
        .ok()
        .map(|d| d.join("settings.json"))
}

/// Findes indstillingsfilen? Nej betyder første start (welcome.rs).
pub fn exists(app: &AppHandle) -> bool {
    file(app).is_some_and(|f| f.exists())
}

/// De sidst læste eller gemte indstillinger. Kan filen ikke læses et øjeblik, bruges de frem for
/// standarden. Ellers kunne næste skrivning gemme standarden oven i filen, og så var bibliotekerne
/// væk (fejljagt 19/10: en læsning under et gem fra et andet vindue fejlede i 14 % af forsøgene).
static LAST: std::sync::Mutex<Option<Settings>> = std::sync::Mutex::new(None);

fn remember(settings: &Settings) {
    if let Ok(mut last) = LAST.lock() {
        *last = Some(settings.clone());
    }
}

/// Filen læst, med nye forsøg, mens et gem erstatter den (navnet er væk et øjeblik, eller den er
/// låst). `None`, når den ikke findes eller ikke kan læses.
fn read_file(f: &std::path::Path) -> Option<Vec<u8>> {
    for attempt in 0..5 {
        match std::fs::read(f) {
            Ok(bytes) => return Some(bytes),
            Err(e)
                if attempt < 4
                    && (e.kind() == std::io::ErrorKind::NotFound
                        || crate::files::is_locked(&e)) =>
            {
                if e.kind() == std::io::ErrorKind::NotFound
                    && LAST.lock().map(|l| l.is_none()).unwrap_or(true)
                {
                    // Første start: der er ingen fil endnu, og intet at vente på.
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            Err(_) => return None,
        }
    }
    None
}

pub fn load(app: &AppHandle) -> Settings {
    let Some(f) = file(app) else {
        return parse(None);
    };
    let bytes = read_file(&f);
    #[allow(unused_mut)]
    let mut settings = match &bytes {
        Some(b) => {
            // En fil, der ikke kan læses helt, gemmes som `.bad`, før noget skrives oven i den.
            if serde_json::from_slice::<Settings>(strip_bom(b)).is_err() {
                let _ = std::fs::write(f.with_extension("json.bad"), b);
            }
            let s = parse(Some(b));
            remember(&s);
            s
        }
        None => LAST
            .lock()
            .ok()
            .and_then(|l| l.clone())
            .unwrap_or_else(|| parse(None)),
    };
    // Telefonen har ingen mappevælger, og synken lægger teksterne i hele Dokumenter-mappen
    // (Strategi, Kunder osv.). Biblioteket var kun underappen Gode Tekster, så listen var tom,
    // selv når synken havde hentet alt (16/10). Biblioteket er derfor altid Dokumenter.
    #[cfg(mobile)]
    if let Ok(docs) = documents_dir(app) {
        settings.libraries = vec![docs];
    }
    settings
}

/// Indstillingerne fra filens bytes. En fil fra før 7/10 har kun `hideMarks`: `true` bliver til
/// visningen "skjul". En fil fra før 8/10 har kun `dark`: `true` bliver til udseendet "moerk".
/// En ukendt visning eller et ukendt udseende bliver standarden.
fn parse(raw: Option<&[u8]>) -> Settings {
    let raw = raw.map(strip_bom);
    let value = raw.and_then(|b| serde_json::from_slice::<serde_json::Value>(b).ok());
    let mut s: Settings = raw
        .and_then(|b| serde_json::from_slice(b).ok())
        .or_else(|| value.clone().map(lenient))
        .unwrap_or_default();
    let has = |key: &str| value.as_ref().is_some_and(|v| v.get(key).is_some());
    if !has("markMode") && s.hide_marks {
        s.mark_mode = "skjul".to_owned();
    }
    if !matches!(s.mark_mode.as_str(), "skjul" | "markoer" | "alle" | "raa") {
        s.mark_mode = "markoer".to_owned();
    }
    // En fil fra før 8/10 har kun `dark`.
    if !has("theme") && s.dark {
        s.theme = "moerk".to_owned();
    }
    if !matches!(s.theme.as_str(), "lys" | "moerk" | "aften" | "auto") {
        s.theme = "lys".to_owned();
    }
    // En fil fra før 21/10 har kun `hiddenWordClasses`.
    if !has("wordClassesOff") && !s.hidden_word_classes.is_empty() {
        s.word_classes_off = std::mem::take(&mut s.hidden_word_classes);
    }
    // Mindst to statusser, ellers kan intet være i gang. Et ugyldigt id fjernes.
    s.statuses
        .retain(|d| crate::textmeta::valid_id(&d.id) && !d.name.trim().is_empty());
    if s.statuses.len() < 2 {
        s.statuses = default_statuses();
    }
    s
}

/// En BOM fra Notesblok fik før hele filen til at blive læst som standarden.
fn strip_bom(b: &[u8]) -> &[u8] {
    b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(b)
}

/// Felterne, der kan læses. Ét felt med forkert type nulstillede før alle indstillinger, også
/// bibliotekerne. Nu falder kun det felt tilbage til standarden.
fn lenient(value: serde_json::Value) -> Settings {
    let Some(obj) = value.as_object() else {
        return Settings::default();
    };
    let mut ok = serde_json::Map::new();
    for (k, v) in obj {
        ok.insert(k.clone(), v.clone());
        if serde_json::from_value::<Settings>(serde_json::Value::Object(ok.clone())).is_err() {
            ok.remove(k);
        }
    }
    serde_json::from_value(serde_json::Value::Object(ok)).unwrap_or_default()
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
    crate::files::write_atomic(&f, &json).map_err(|e| not_saved(&e))?;
    remember(settings);
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
    let stored_autostart = stored.start_with_windows;
    let settings = Settings {
        libraries: stored.libraries,
        commands_dir: stored.commands_dir,
        audio_tools_dir: stored.audio_tools_dir,
        ..settings
    };
    // Sproget først: write sender settings-changed, og vinduerne spørger så om sproget (main.ts).
    crate::i18n::apply(&settings.language);
    #[cfg(desktop)]
    crate::refresh_tray(&app);
    write(&app, &settings)?;
    // Kun når valget er ændret: ellers tog hvert gem i en testkopi nøglen fra den installerede (8/10).
    if settings.start_with_windows != stored_autostart {
        crate::autostart::apply(&app, settings.start_with_windows);
    }
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

pub fn set_audio_tools(app: &AppHandle, dir: &std::path::Path) -> Result<(), String> {
    let mut settings = load(app);
    settings.audio_tools_dir = Some(dir.to_path_buf());
    write(app, &settings)
}

/// »Tilføj mappe …«: Brugeren vælger selv mappen i Windows' mappevælger. Returnerer den nye liste.
#[tauri::command]
pub async fn add_library(app: AppHandle) -> Result<Vec<PathBuf>, String> {
    let picked = pick_folder(&app)?;
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

/// Dokumenter. På telefonen er det en mappe i appens eget lager: Androids fælles lager er langsomt
/// til mange filer. Hårde links er heller ikke tilladt her (files::write_atomic_new).
/// Synkroniseringen skal senere fylde den (ADR-0054).
pub(crate) fn documents_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    #[cfg(desktop)]
    return app.path().document_dir();
    #[cfg(mobile)]
    return Ok(app.path().app_data_dir()?.join("Dokumenter"));
}

#[cfg(desktop)]
fn pick_folder(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    Ok(app
        .dialog()
        .file()
        .set_title(t!(
            "Vælg en mappe til biblioteket",
            "Choose a folder for the library"
        ))
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok()))
}

/// Telefonen har ingen mappevælger. Dens bibliotek er appens egen mappe (welcome.rs).
#[cfg(mobile)]
fn pick_folder(_app: &AppHandle) -> Result<Option<PathBuf>, String> {
    Err(t!(
        "På telefonen bruger Gode Tekster sin egen mappe.",
        "On the phone, Gode Tekster uses its own folder."
    )
    .to_owned())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visningen_af_markdown_oversaettes_fra_den_gamle_kontakt() {
        assert_eq!(parse(None).mark_mode, "markoer");
        assert_eq!(parse(Some(br#"{"hideMarks":true}"#)).mark_mode, "skjul");
        assert_eq!(parse(Some(br#"{"hideMarks":false}"#)).mark_mode, "markoer");
        assert_eq!(
            parse(Some(br#"{"hideMarks":true,"markMode":"alle"}"#)).mark_mode,
            "alle"
        );
        assert_eq!(parse(Some(br#"{"markMode":"noget"}"#)).mark_mode, "markoer");
    }

    #[test]
    fn ordklasserne_viser_tillaegsord_og_biord_foerste_gang() {
        let off = |raw: &[u8]| parse(Some(raw)).word_classes_off;
        assert_eq!(parse(None).word_classes_off, ["n", "v", "c"]);
        // Aldrig valgt i en ældre udgave: den nye standard.
        assert_eq!(off(br#"{"hiddenWordClasses":[]}"#), ["n", "v", "c"]);
        // Valgt i en ældre udgave: valget bliver stående.
        assert_eq!(off(br#"{"hiddenWordClasses":["n"]}"#), ["n"]);
        // Valgt i denne udgave, også alle til: det huskes.
        assert!(off(br#"{"wordClassesOff":[],"hiddenWordClasses":["n"]}"#).is_empty());
        let saved = serde_json::to_value(parse(Some(br#"{"hiddenWordClasses":["n"]}"#)))
            .unwrap_or_default();
        assert!(saved.get("hiddenWordClasses").is_none());
    }

    #[test]
    fn udseendet_oversaettes_fra_den_gamle_moerk_kontakt() {
        assert_eq!(parse(None).theme, "lys");
        assert_eq!(parse(Some(br#"{"dark":true}"#)).theme, "moerk");
        assert_eq!(parse(Some(br#"{"dark":false}"#)).theme, "lys");
        assert_eq!(
            parse(Some(br#"{"dark":true,"theme":"aften"}"#)).theme,
            "aften"
        );
        assert_eq!(parse(Some(br#"{"theme":"auto"}"#)).theme, "auto");
        assert_eq!(parse(Some(br#"{"theme":"lilla"}"#)).theme, "lys");
    }

    #[test]
    fn bom_og_et_forkert_felt_nulstiller_ikke_bibliotekerne() {
        // fejljagt 19/10: begge gav standarden, og næste gem skrev bibliotekerne væk.
        let s = parse(Some(
            b"\xEF\xBB\xBF{\"libraries\":[\"C:/Tekster\"],\"theme\":\"aften\"}",
        ));
        assert_eq!(s.libraries.len(), 1);
        assert_eq!(s.theme, "aften");
        let s = parse(Some(
            br#"{"libraries":["C:/Tekster"],"theme":"aften","markMode":42}"#,
        ));
        assert_eq!(s.libraries.len(), 1);
        assert_eq!(s.theme, "aften");
        assert_eq!(s.mark_mode, "markoer");
    }
}
