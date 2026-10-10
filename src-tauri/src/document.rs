//! Kommandoerne om det åbne dokument: åbn (med stivagt), gem, backup, versioner og testtilstand.
//! Binder `files`, `annotations` og `history` sammen.
//!
//! Filens kodning, stempel og annotationsblok bliver her i Rust. Editoren sender kun tekst og
//! forfatter-intervaller frem og tilbage (ADR-0009, ADR-0013).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::annotations::{self, Author, Authorship, BlockInfo, Kind, Span};
use crate::applog;
use crate::files::{self, Encoding, FileError, FileMeta};
use crate::history::History;

struct OpenDoc {
    meta: FileMeta,
    block: Option<BlockInfo>,
    owner: String,
}

pub struct AppState {
    pub started: Instant,
    docs: Mutex<HashMap<PathBuf, OpenDoc>>,
    /// Filer, hvis original allerede er kopieret til backup i denne session.
    backed_up: Mutex<HashSet<PathBuf>>,
    /// Filer uden for bibliotekerne, som brugeren selv har valgt (»Åbn med«, dialogen, sidst åbne).
    chosen: Mutex<HashSet<String>>,
    pub shown_once: std::sync::atomic::AtomicBool,
}

impl AppState {
    pub fn new(started: Instant) -> Self {
        AppState {
            started,
            docs: Mutex::new(HashMap::new()),
            backed_up: Mutex::new(HashSet::new()),
            chosen: Mutex::new(HashSet::new()),
            shown_once: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDto {
    path: String,
    name: String,
    text: String,
    authors: Vec<Authorship>,
    /// Den forfatter, tastet tekst tilskrives.
    me: Author,
    stale_blocks: Vec<Span>,
    mixed_eol: bool,
    cursor: Option<usize>,
    /// Filen havde en forfatterblok. Uden den spores intet, og der tilføjes ingen (ADR-0013).
    has_block: bool,
    /// Tekst, der er kommet udefra siden programmets seneste version (vises med en stribe).
    external: Vec<Span>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveError {
    /// `changed-on-disk`, `mixed-eol`, `unencodable`, `gone`, `not-open` eller `io`.
    kind: &'static str,
    pub(crate) message: String,
}

impl From<FileError> for SaveError {
    fn from(e: FileError) -> Self {
        let kind = match &e {
            FileError::ChangedOnDisk { .. } => "changed-on-disk",
            FileError::MixedLineEndings => "mixed-eol",
            FileError::Unencodable => "unencodable",
            FileError::Gone => "gone",
            FileError::Io(_) => "io",
        };
        SaveError {
            kind,
            message: e.to_string(),
        }
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, SaveError> {
    app.path().app_local_data_dir().map_err(|e| SaveError {
        kind: "io",
        message: t!(
            format!("Programmets datamappe kunne ikke findes: {e}"),
            format!("The app's data folder could not be found: {e}")
        ),
    })
}

/// Den menneskelige forfatter, brugeren skriver som. Har filen præcis én, bruges den (iA skriver ofte
/// `@:` uden navn), ellers navnet fra indstillingen »Dit navn« (tomt giver `@:`).
fn me_for(authors: &[Authorship], name: &str) -> Author {
    let humans: Vec<&Author> = authors
        .iter()
        .map(|a| &a.author)
        .filter(|a| a.kind == Kind::Human)
        .collect();
    match humans.as_slice() {
        [only] => (*only).clone(),
        _ => Author {
            kind: Kind::Human,
            name: name.to_owned(),
            identifier: None,
        },
    }
}

/// Sammenlign filen med programmets seneste version (ADR-0009):
/// - iA-hashen passer: blokken er sand (iA eller programmet selv har skrevet den).
/// - Hashen passer ikke: en anden har rettet. Forfatterskabet flyttes gennem rettelsen, og den nye
///   tekst bliver Claudes. Uden en tidligere version bliver intervallerne til huller (ukendt).
/// - Ingen blok: intet forfatterskab, men rettelserne udefra vises stadig med stribe.
///
/// Er teksten anderledes end seneste version, gemmes den som ny version (`external` eller `first`).
fn with_history(
    app: &AppHandle,
    path: &Path,
    parsed: &annotations::Parsed,
) -> (Vec<Authorship>, Vec<Span>) {
    let key = path.to_string_lossy();
    let hash_valid = parsed.block.as_ref().is_some_and(|b| b.hash_valid);
    let has_block = parsed.block.is_some();
    let Some(history) = app.try_state::<History>() else {
        return (
            if hash_valid || !has_block {
                parsed.authors.clone()
            } else {
                Vec::new()
            },
            Vec::new(),
        );
    };
    let last = history.last(&key).ok().flatten();
    let (authors, external, source) = match last {
        None => (
            if hash_valid {
                parsed.authors.clone()
            } else {
                Vec::new()
            },
            Vec::new(),
            "first",
        ),
        Some(v) if v.text == parsed.text => (
            if hash_valid {
                parsed.authors.clone()
            } else {
                v.authors
            },
            Vec::new(),
            "",
        ),
        // Rettet i iA: blokken er sand, og ændringerne er skribentens egne. Ingen stribe.
        Some(_) if hash_valid => (parsed.authors.clone(), Vec::new(), "external"),
        Some(v) => {
            let m = crate::authorship::map_external(&v.text, &parsed.text, &v.authors);
            let authors = if has_block { m.authors } else { Vec::new() };
            (authors, m.external, "external")
        }
    };
    if !source.is_empty() {
        if let Err(e) = history.record_now(&key, &parsed.text, &authors, source) {
            applog::write(app, &format!("version kunne ikke gemmes: {e}"));
        }
    }
    (authors, external)
}

fn key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

/// Brugeren har selv valgt filen (Stifinder, dialogen, sidst åbne): den må åbnes, selv om den
/// ligger uden for bibliotekerne.
/// Den åbne tekst får nyt navn (en ny tekst efter sin første linje, ui/autoName.ts). Filen omdøbes,
/// og tilstanden, vinduets titel, »ét vindue pr. tekst« og overvågningen følger med, så teksten
/// ikke skal åbnes igen, og markøren og fortrydelsen bliver, hvor de er.
#[tauri::command]
pub fn rename_open_document(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let from = PathBuf::from(&path);
    let to = crate::library::rename_path(&app, &from, &new_name)?;
    if let Ok(mut docs) = state.docs.lock() {
        if let Some(doc) = docs.remove(&from) {
            docs.insert(to.clone(), doc);
        }
    }
    if let Ok(mut set) = state.backed_up.lock() {
        set.insert(to.clone());
    }
    choose(&app, &to);
    if let (Some(w), Some(name)) = (app.get_webview_window(window.label()), to.file_name()) {
        let _ = w.set_title(&crate::windows::title_of(&name.to_string_lossy()));
    }
    crate::windows::showing(&app, window.label(), &to);
    crate::watcher::set_open_file(&app, window.label(), &to);
    applog::write(&app, "ny tekst fik navn efter første linje");
    Ok(to.to_string_lossy().into_owned())
}

pub fn choose(app: &AppHandle, path: &Path) {
    if let Ok(mut c) = app.state::<AppState>().chosen.lock() {
        c.insert(key(path));
    }
}

/// Stien fra kommandolinjen som fuld Windows-sti. En relativ sti eller en med `/` gav før en
/// tekst, der ikke kunne finde sine billeder (fundet ved måling 2/10).
pub fn arg_path(arg: &str, cwd: &Path) -> PathBuf {
    let p = cwd.join(arg);
    std::path::absolute(&p).unwrap_or(p)
}

/// Er filen åben lige nu? Bruges af fraklip, der kun må hentes ved siden af en åben tekst.
pub fn open_paths(app: &AppHandle) -> Vec<PathBuf> {
    app.state::<AppState>()
        .docs
        .lock()
        .map(|d| d.keys().cloned().collect())
        .unwrap_or_default()
}

pub(crate) fn forget_window(app: &AppHandle, label: &str) {
    if let Ok(mut docs) = app.state::<AppState>().docs.lock() {
        docs.retain(|_, doc| doc.owner != label);
    }
}

#[tauri::command]
pub fn release_document(app: AppHandle, window: tauri::Window, path: String) {
    if let Ok(mut docs) = app.state::<AppState>().docs.lock() {
        let path = PathBuf::from(path);
        if docs.get(&path).is_some_and(|d| d.owner == window.label()) {
            docs.remove(&path);
        }
    }
}

/// Kun tekstfiler, og kun fra et bibliotek, fra brugerens eget valg eller allerede åbne. Fladen
/// kan ellers bede om at åbne (og siden gemme over) enhver fil på pc'en (sikkerhedsreview 2/10).
pub(crate) fn may_open(app: &AppHandle, state: &AppState, path: &Path) -> Result<(), SaveError> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let denied = |message: &str| SaveError {
        kind: "io",
        message: message.to_owned(),
    };
    if !["md", "markdown", "txt"].contains(&ext.as_str()) {
        return Err(denied(t!(
            "Kun tekstfiler (.md, .markdown, .txt) kan åbnes her.",
            "Only text files (.md, .markdown, .txt) can be opened here."
        )));
    }
    let chosen = state.chosen.lock().is_ok_and(|c| c.contains(&key(path)));
    let open = state.docs.lock().is_ok_and(|d| d.contains_key(path));
    // Kun i testtilstand: trykprøvens kopier i tests\private må åbnes uden at ligge i et bibliotek.
    let test_copy = std::env::var("GT_TEST").is_ok_and(|v| v == "1")
        && path
            .to_string_lossy()
            .to_lowercase()
            .contains("\\tests\\private\\");
    if chosen || open || test_copy || crate::library::in_library(app, path) {
        Ok(())
    } else {
        Err(denied(t!(
            "Filen ligger uden for dine biblioteker. Åbn den med Ctrl+Shift+O.",
            "The file is outside your libraries. Open it with Ctrl+Shift+O."
        )))
    }
}

fn open_path(
    app: &AppHandle,
    state: &AppState,
    window: &str,
    path: &Path,
) -> Result<DocumentDto, SaveError> {
    may_open(app, state, path)?;
    // Reservation og indlæsning sker under samme lås som gem. To vinduer må ikke dele et stempel.
    let mut docs = state.docs.lock().map_err(|_| SaveError {
        kind: "io",
        message: t!(
            "Intern fejl: dokumentlisten er låst.",
            "Internal error: the document list is locked."
        )
        .to_owned(),
    })?;
    if docs
        .iter()
        .any(|(p, d)| crate::windows::same(p, path) && d.owner != window)
    {
        return Err(SaveError {
            kind: "already-open",
            message: t!(
                "Teksten er allerede åben i et andet vindue.",
                "The text is already open in another window."
            )
            .to_owned(),
        });
    }
    let opened = files::open(path)?;
    let parsed = annotations::parse(&opened.text, opened.meta.eol);
    let (authors, external) = with_history(app, path, &parsed);
    let me = me_for(&authors, &crate::settings::author_name(app));
    let dto = DocumentDto {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        text: parsed.text,
        authors,
        external,
        me,
        stale_blocks: parsed.stale_blocks,
        mixed_eol: opened.meta.mixed_eol,
        cursor: crate::session::cursor_for(app, path),
        has_block: parsed.block.is_some(),
    };
    docs.insert(
        path.to_path_buf(),
        OpenDoc {
            meta: opened.meta,
            block: parsed.block,
            owner: window.to_owned(),
        },
    );
    drop(docs);
    // En note er ikke »den sidste tekst«: hovedvinduet skal ikke åbne på en note (ADR-0039).
    if !crate::notes::is_note(window) {
        crate::session::remember(app, path, None);
    }
    crate::watcher::set_open_file(app, window, path);
    crate::windows::showing(app, window, path);
    if let Some(dir) = path.parent() {
        crate::library::allow_images(app, dir);
    }
    if let Some(w) = app.get_webview_window(window) {
        let _ = w.set_title(&crate::windows::title_of(&dto.name));
    }
    applog::write(app, "aabnet en fil");
    Ok(dto)
}

#[tauri::command]
pub async fn open_document(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    path: String,
) -> Result<DocumentDto, SaveError> {
    open_path(&app, &state, window.label(), Path::new(&path))
}

/// Filen fra kommandolinjen (»Åbn med« i Stifinder), ellers den sidst åbne.
#[tauri::command]
pub async fn initial_document(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Option<DocumentDto>, SaveError> {
    // Et ekstra vindue viser den tekst, det blev åbnet med, eller er tomt (Ctrl+N).
    if window.label() != "main" {
        return match crate::windows::take_pending(&app, window.label())
            .or_else(|| crate::windows::path_for(&app, window.label()))
        {
            Some(p) if p.exists() => open_path(&app, &state, window.label(), &p).map(Some),
            _ => Ok(None),
        };
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let from_args = std::env::args()
        .skip(1)
        .find(|a| !a.starts_with("--"))
        .map(|a| arg_path(&a, &cwd));
    let last = crate::session::last_path(&app);
    let candidate = crate::windows::path_for(&app, window.label())
        .or(from_args)
        .or_else(|| last.clone())
        .or_else(|| crate::welcome::prepare(&app))
        .filter(|p| p.exists())
        // Ingen tekst at starte på: en blank tekst, som man kan skrive i med det samme (5/10).
        .or_else(|| crate::library::blank_text(&app, last.as_deref()));
    match candidate {
        Some(p) => {
            choose(&app, &p);
            open_path(&app, &state, "main", &p).map(Some)
        }
        None => Ok(None),
    }
}

/// Windows' egen fil-dialog (Ctrl+Shift+O), til filer uden for bibliotekerne.
#[tauri::command]
pub async fn pick_document(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Option<DocumentDto>, SaveError> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .add_filter(t!("Tekst", "Text"), &["md", "markdown", "txt"])
        .blocking_pick_file();
    match picked.and_then(|p| p.into_path().ok()) {
        Some(p) => {
            choose(&app, &p);
            open_path(&app, &state, window.label(), &p).map(Some)
        }
        None => Ok(None),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    path: String,
    text: String,
    authors: Vec<Authorship>,
    cursor: usize,
    /// Brugeren har sagt ja til at ensrette blandede linjeskift.
    #[serde(default)]
    allow_eol_normalize: bool,
    /// Brugeren har valgt »Behold min udgave«: filen på disken lægges i backup og overskrives.
    #[serde(default)]
    overwrite_external: bool,
    /// Brugeren har valgt at gemme som UTF-8, fordi den gamle kodning ikke kan rumme teksten.
    #[serde(default)]
    force_utf8: bool,
}

#[tauri::command]
pub async fn save_document(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    req: SaveRequest,
) -> Result<(), SaveError> {
    let path = PathBuf::from(&req.path);
    let mut docs = state.docs.lock().map_err(|_| SaveError {
        kind: "io",
        message: t!(
            "Intern fejl: dokumentlisten er låst.",
            "Internal error: the document list is locked."
        )
        .to_owned(),
    })?;
    let (mut meta, block) = {
        let doc = docs.get(&path).ok_or(SaveError {
            kind: "not-open",
            message: t!("Filen er ikke åben.", "The file is not open.").to_owned(),
        })?;
        if doc.owner != window.label() {
            return Err(SaveError {
                kind: "not-open",
                message: t!(
                    "Filen er ikke åben i dette vindue.",
                    "The file is not open in this window."
                )
                .to_owned(),
            });
        }
        (doc.meta.clone(), doc.block.clone())
    };
    if req.force_utf8 && meta.encoding == Encoding::Windows1252 {
        meta.encoding = Encoding::Utf8;
    }

    // Uden blok fra start ignoreres forfatterskabet, så filen aldrig får en blok, den ikke havde.
    let authors: &[Authorship] = if block.is_some() { &req.authors } else { &[] };
    let full = annotations::write(&req.text, authors, block.as_ref(), meta.eol);
    let backup_dir = data_dir(&app)?.join("backup");

    // Første gem af en fil i denne session: originalen kopieres som den var på disken. Historikken
    // gemmer teksten, men ikke filens bytes (kodning, linjeskift, iA-blok), så kopien bliver.
    let first = state
        .backed_up
        .lock()
        .map(|set| !set.contains(&path))
        .unwrap_or(false);
    if (first || req.overwrite_external) && path.exists() {
        files::backup(&path, &backup_dir)?;
        if let Ok(mut set) = state.backed_up.lock() {
            set.insert(path.clone());
        }
    }

    // Omdøbt eller flyttet i mappen udefra: følg filen i stedet for at genskabe den på det gamle navn.
    if !req.overwrite_external && !path.exists() {
        if let Some(moved) = files::find_moved(&path, &meta.stamp) {
            if let Some(doc) = docs.remove(&path) {
                docs.insert(moved.clone(), doc);
            }
            drop(docs);
            choose(&app, &moved);
            if let (Some(w), Some(name)) =
                (app.get_webview_window(window.label()), moved.file_name())
            {
                let _ = w.set_title(&crate::windows::title_of(&name.to_string_lossy()));
            }
            crate::windows::showing(&app, window.label(), &moved);
            crate::watcher::set_open_file(&app, window.label(), &moved);
            applog::write(&app, "aaben fil omdoebt udefra, fulgt");
            return Err(SaveError {
                kind: "moved",
                message: moved.to_string_lossy().into_owned(),
            });
        }
    }

    let expected = if req.overwrite_external {
        None
    } else {
        Some(&meta.stamp)
    };
    let stamp = match files::save(&path, &full, &meta, expected, req.allow_eol_normalize) {
        Ok(s) => s,
        Err(e) => {
            let mut save_err = SaveError::from(e);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "fil".to_owned());
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let dest = backup_dir.join(format!("{now}-emergency-{name}"));
            std::fs::create_dir_all(&backup_dir).ok();
            if files::write_atomic(&dest, full.as_bytes()).is_ok() {
                let msg = t!(
                    " Nødkopi er lagt i mappen Gode Tekster/backup.",
                    " An emergency copy was saved in the Gode Tekster/backup folder."
                );
                save_err.message.push_str(msg);
            }
            return Err(save_err);
        }
    };

    meta.stamp = stamp;
    if req.allow_eol_normalize {
        meta.mixed_eol = false;
    }
    let new_block = annotations::parse(&full, meta.eol).block;
    docs.insert(
        path.clone(),
        OpenDoc {
            meta,
            block: new_block,
            owner: window.label().to_owned(),
        },
    );
    drop(docs);
    // En note er aldrig »den sidste tekst« (ADR-0039): ellers åbnede hovedvinduet den ved næste start.
    if !crate::notes::is_note(window.label()) {
        crate::session::remember(&app, &path, Some(req.cursor));
    }
    if let Some(history) = app.try_state::<History>() {
        if let Err(e) = history.record_now(&path.to_string_lossy(), &req.text, authors, "app") {
            applog::write(&app, &format!("version kunne ikke gemmes: {e}"));
        }
        if let Ok(Some(n)) = history.thin_if_due() {
            applog::write(&app, &format!("historik udtyndet: {n} versioner"));
        }
    }
    Ok(())
}

// --- versioner (fanen Versioner) ---------------------------------------------------------------

#[tauri::command]
pub async fn history_list(
    app: AppHandle,
    path: String,
) -> Result<Vec<crate::history::VersionInfo>, String> {
    // Uden historik (databasen kunne ikke åbnes) er listen tom. En fejl i en læsning er en fejl,
    // ikke »ingen versioner« (L-592).
    let Some(h) = app.try_state::<History>() else {
        return Ok(Vec::new());
    };
    h.list(&path).map_err(|e| {
        t!(
            format!("Versionerne kunne ikke hentes: {e}"),
            format!("The versions could not be loaded: {e}")
        )
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDto {
    text: String,
    authors: Vec<Authorship>,
}

#[tauri::command]
pub fn history_get(app: AppHandle, id: i64) -> Result<VersionDto, String> {
    let h = app.try_state::<History>().ok_or(t!(
        "Historikken er ikke tilgængelig.",
        "Version history is not available."
    ))?;
    let v = h.get(id).map_err(|e| {
        t!(
            format!("Versionen kunne ikke hentes: {e}"),
            format!("The version could not be loaded: {e}")
        )
    })?;
    Ok(VersionDto {
        text: v.text,
        authors: v.authors,
    })
}

#[tauri::command]
pub fn history_label(app: AppHandle, id: i64, label: String) -> Result<(), String> {
    let h = app.try_state::<History>().ok_or(t!(
        "Historikken er ikke tilgængelig.",
        "Version history is not available."
    ))?;
    h.set_label(id, &label).map_err(|e| {
        t!(
            format!("Versionen kunne ikke navngives: {e}"),
            format!("The version could not be named: {e}")
        )
    })
}

/// Før en gammel udgave hentes frem: den nuværende gemmes som sin egen version (designprincip 3).
#[tauri::command]
pub fn history_keep(
    app: AppHandle,
    path: String,
    text: String,
    authors: Vec<Authorship>,
) -> Result<(), String> {
    let h = app.try_state::<History>().ok_or(t!(
        "Historikken er ikke tilgængelig.",
        "Version history is not available."
    ))?;
    h.record_now(&path, &text, &authors, "restore")
        .map(|_| ())
        .map_err(|e| {
            t!(
                format!("Den nuværende udgave kunne ikke gemmes som version: {e}"),
                format!("The current text could not be saved as a version: {e}")
            )
        })
}

/// Er filen på disken en anden end den, programmet sidst læste eller gemte? Hashen afgør det
/// (ADR-0013), så egne gem og OneDrive, der kun rører tiden, aldrig giver falsk alarm.
pub fn changed_externally(app: &AppHandle, path: &Path) -> bool {
    let state = app.state::<AppState>();
    let known = state
        .docs
        .lock()
        .ok()
        .and_then(|d| d.get(path).map(|doc| doc.meta.stamp.clone()));
    let Some(known) = known else { return false };
    // Hurtigt svar først: efter programmets eget gem passer størrelse og tid, og filen skal
    // ikke læses og hashes igen.
    if files::stat_unchanged(path, &known) {
        return false;
    }
    files::current_stamp(path).is_ok_and(|now| now.hash != known.hash)
}

/// Gemmer editorens tekst som en kopi i backup, før en anden udgave hentes ind.
#[tauri::command]
pub async fn backup_text(app: AppHandle, path: String, text: String) -> Result<(), SaveError> {
    let dir = data_dir(&app)?.join("backup");
    std::fs::create_dir_all(&dir).map_err(|e| SaveError::from(FileError::Io(e)))?;
    let name = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tekst.md".to_owned());
    let stamp = crate::history::now_ms();
    files::write_atomic(
        &dir.join(format!("{stamp}-ikke-gemt-{name}")),
        text.as_bytes(),
    )
    .map_err(SaveError::from)
}

#[derive(Serialize)]
pub struct TestMode {
    /// `GT_TEST_PANELS=1`: vis begge paneler uden at gemme valget (til skærmbilleder).
    panels: bool,
    /// `GT_MEASURE=1`: mål acceptkriterie 6 (intet hopper) og skriv resultatet i loggen.
    measure: bool,
    /// `GT_SCENARIE=navn`: et testscenarie i measure.ts, som et script uden for programmet styrer.
    scenario: Option<String>,
}

#[tauri::command]
pub fn test_mode() -> TestMode {
    let on = |k: &str| std::env::var(k).is_ok_and(|v| v == "1");
    TestMode {
        panels: on("GT_TEST_PANELS"),
        measure: on("GT_MEASURE"),
        scenario: std::env::var("GT_SCENARIE").ok().filter(|v| !v.is_empty()),
    }
}

/// En linje i programmets log fra fladen (kun målinger i testtilstand).
#[tauri::command]
pub fn log_line(app: AppHandle, text: String) {
    applog::write(&app, &text.chars().take(300).collect::<String>());
}

/// Fladen melder, at editoren er tegnet og har fokus. Først nu vises vinduet (ADR-0014).
#[tauri::command]
pub fn app_ready(app: AppHandle, window: tauri::Window, state: State<'_, AppState>) {
    // En note vises uden at tage fokus, hvis den kommer igen ved start (notes.rs).
    if crate::notes::is_note(window.label()) {
        crate::notes::ready(&app, window.label());
        return;
    }
    // Et ekstra vindue vises bare, når det er klar.
    if window.label() != "main" {
        crate::windows::focus(&app, window.label());
        return;
    }
    let ms = state.started.elapsed().as_millis();
    applog::write(&app, &format!("klar efter {ms} ms"));
    // Startet ved login: vinduet bliver skjult første gang. Næste fil eller et klik viser det.
    if crate::autostart::started_hidden()
        && !state
            .shown_once
            .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    crate::show_main(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arg_path_er_fuld_og_med_backslash() {
        let p = arg_path("tests/proeve/A.md", Path::new(r"C:\dev\gt"));
        assert_eq!(p, PathBuf::from(r"C:\dev\gt\tests\proeve\A.md"));
        let abs = arg_path(r"D:\tekst\B.md", Path::new(r"C:\dev"));
        assert_eq!(abs, PathBuf::from(r"D:\tekst\B.md"));
    }
}
