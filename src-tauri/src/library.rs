//! Biblioteket i venstre panel (ADR-0007, plan 2-9 del A): mapper og filer som i iA Writer.
//!
//! Reglerne for, hvad der skjules og dæmpes, er afprøvet 2/10-2026 mod et bibliotek med godt
//! tusind .md-filer. De lå først i `src/lib/library.ts`, men bor nu her, så skjulte mapper som
//! `node_modules` aldrig læses fra disken. Alle filoperationer kræver, at stien ligger inde i et
//! af brugerens biblioteker.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::AppHandle;

use crate::settings;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    Normal,
    Dimmed,
    Hidden,
}

/// Mapper uden tekster: afhængigheder og byggeoutput. Mapper med punktum skjules altid.
const HIDDEN_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "__pycache__",
    "vendor",
    "spejl",
];

/// Husets kontraktfiler, som Claude skriver. En fast liste med præcis husets stavemåde, aldrig
/// »store bogstaver«: skribenter kalder selv deres tekster ARTIKEL, FRAKLIP, RÅNOTER, VINKEL.
const CONTRACT_NAMES: &[&str] = &[
    "AGENTS",
    "CLAUDE",
    "README",
    "STRATEGI",
    "ARKITEKTUR",
    "TODO",
    "todo",
    "TODO-teknisk",
    "IDEER",
    "HANDOFF",
    "HANDOFF-ARKIV",
    "ARKIV",
    "CONTEXT",
    "SKILL",
    "KUNDE",
    "LÆSMIG",
    "LAESMIG",
    "METODE",
    "SOA",
    "POLITIK",
    "HAENDELSESLOG",
    "HAENDELSER",
    "FORTEGNELSE",
    "DRIFT",
    "DATAKLASSER",
    "DATAFLOW",
    "STANDARD",
    "LESSONS",
    "REGISTRY",
    "SKRIVESTIL",
    "KALENDER",
    "BACKUP",
    "DEPLOY",
    "MEMORY",
    "LICENSE",
    "CHANGELOG",
    "CONTRIBUTING",
    "SECURITY",
    "TOOL-VERSIONS",
    "VENDOR",
];

/// Mapper med husets egen dokumentation.
const CONTRACT_DIRS: &[&str] = &["docs", "audit", "lektioner"];

/// Filtyper, biblioteket viser. `.docx` importeres (del G).
const TEXT_EXT: &[&str] = &["md", "markdown", "txt", "docx"];

fn is_hidden_dir(name: &str) -> bool {
    name.starts_with('.') || HIDDEN_DIRS.contains(&name.to_lowercase().as_str())
}

fn is_contract_file(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".md") else {
        return false;
    };
    CONTRACT_NAMES.contains(&stem) || stem.starts_with("HANDOFF-")
}

/// Synlighed for en sti relativt til biblioteket (`/` eller `\`).
pub fn visibility_of(rel: &str) -> Visibility {
    let parts: Vec<&str> = rel.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    let Some((name, dirs)) = parts.split_last() else {
        return Visibility::Normal;
    };
    if dirs.iter().any(|d| is_hidden_dir(d)) {
        return Visibility::Hidden;
    }
    if dirs
        .iter()
        .any(|d| CONTRACT_DIRS.contains(&d.to_lowercase().as_str()))
    {
        return Visibility::Dimmed;
    }
    if is_contract_file(name) {
        Visibility::Dimmed
    } else {
        Visibility::Normal
    }
}

/// Husets regler (dæmpede kontraktfiler, skjult byggeoutput) gælder kun i en kodemappe: der er en
/// `.git` eller en `AGENTS.md` i biblioteket eller over det. En journalists Dokumenter-mappe med
/// »docs« eller »out« skal se ud, som den er (fremmed-gennemgangen før deling 3/10).
pub fn house_rules(root: &Path) -> bool {
    root.ancestors()
        .any(|d| d.join(".git").exists() || d.join("AGENTS.md").is_file())
}

/// Mapper, der altid skjules: punktum-mapper og afhængigheder. Resten af HIDDEN_DIRS kun i en kodemappe.
fn always_hidden(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case("node_modules")
}

/// Synlighed efter husets regler, eller kun de altid skjulte mapper uden for en kodemappe.
fn visibility(rel: &str, house: bool) -> Visibility {
    if house {
        return visibility_of(rel);
    }
    let parts: Vec<&str> = rel.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    match parts.split_last() {
        Some((_, dirs)) if dirs.iter().any(|d| always_hidden(d)) => Visibility::Hidden,
        _ => Visibility::Normal,
    }
}

/// En git-worktree har en `.git`-FIL (ikke mappe) og viser de samme filer som originalen.
fn is_worktree(dir: &Path) -> bool {
    dir.join(".git").is_file()
}

/// OneDrive-pladsholder: at læse den henter filen fra skyen. Uddraget springes over.
#[cfg(windows)]
pub(crate) fn is_cloud_placeholder(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    const OFFLINE: u32 = 0x0000_1000;
    meta.file_attributes() & (RECALL_ON_DATA_ACCESS | OFFLINE) != 0
}

#[cfg(not(windows))]
pub(crate) fn is_cloud_placeholder(_meta: &fs::Metadata) -> bool {
    false
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub modified_ms: u64,
    pub visibility: Visibility,
    /// To linjers uddrag af teksten (kun filer).
    pub preview: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    pub name: String,
    /// Mappen over, hvis den stadig er inde i biblioteket.
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
}

pub(crate) fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Uddrag som i iA: teksten uden markdown-tegn og uden forfatterblok, cirka to linjer.
pub fn preview_of(text: &str) -> String {
    // Forfatterblokken (ADR-0009) og alt efter den hører ikke til uddraget.
    let text = text.split("\n---\nAnnotations:").next().unwrap_or(text);
    let mut out = String::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t == "---" || t.starts_with("Annotations:") || t.starts_with("<!--") {
            continue;
        }
        let t = t.trim_start_matches(['#', '>', '-', '*', '+', ' ']);
        let cleaned: String = t
            .chars()
            .filter(|c| !matches!(c, '*' | '_' | '`' | '~'))
            .collect();
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(cleaned.trim());
        if out.chars().count() > 160 {
            break;
        }
    }
    out.chars().take(160).collect()
}

fn read_preview(path: &Path, meta: &fs::Metadata) -> String {
    if is_cloud_placeholder(meta) || path.extension().is_some_and(|e| e == "docx") {
        return String::new();
    }
    let mut buf = vec![0u8; 4096];
    let n = fs::File::open(path)
        .and_then(|mut f| f.read(&mut buf))
        .unwrap_or(0);
    buf.truncate(n);
    preview_of(&String::from_utf8_lossy(&buf))
}

/// Den mappe i bibliotekerne, stien ligger i. `None` = uden for alle biblioteker.
fn library_root_of(libraries: &[PathBuf], path: &Path) -> Option<PathBuf> {
    let canon = dunce_canonical(path)?;
    libraries
        .iter()
        .filter_map(|l| dunce_canonical(l))
        .find(|root| canon.starts_with(root))
}

/// Kanonisk sti uden `\\?\`-præfiks, så den kan sammenlignes og vises.
fn dunce_canonical(path: &Path) -> Option<PathBuf> {
    let c = fs::canonicalize(path).ok()?;
    let s = c.to_string_lossy();
    Some(PathBuf::from(
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_string(),
    ))
}

/// Billeder vises gennem Tauris asset-protokol (del A, billeder). Scope er tomt fra start og
/// åbnes kun for bibliotekerne og mappen med den åbne fil, så fladen ikke kan læse andet.
pub fn allow_images(app: &AppHandle, dir: &Path) {
    use tauri::Manager;
    // Aldrig et helt drev eller hele brugermappen: en fremmed tekst i roden ville ellers kunne
    // vise (og lægge i en PDF) ethvert billede på pc'en.
    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    if dir.parent().is_none() || profile.as_deref() == Some(dir) {
        return;
    }
    if let Err(e) = app.asset_protocol_scope().allow_directory(dir, true) {
        crate::applog::write(app, &format!("billedmappe kunne ikke åbnes: {e}"));
    }
}

pub fn allow_library_images(app: &AppHandle) {
    for lib in settings::load(app).libraries {
        if lib.is_dir() {
            allow_images(app, &lib);
        }
    }
}

pub fn in_library(app: &AppHandle, path: &Path) -> bool {
    guard(app, path).is_ok()
}

fn guard(app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
    let libs = settings::load(app).libraries;
    library_root_of(&libs, path).ok_or_else(|| {
        t!(
            "Stien ligger uden for dine biblioteker.",
            "The path is outside your libraries."
        )
        .to_owned()
    })
}

/// Et nyt navn må ikke indeholde stier eller tegn, Windows forbyder.
fn valid_name(name: &str) -> Result<&str, String> {
    let n = name.trim();
    let bad = n.is_empty()
        || n == "."
        || n == ".."
        || n.chars()
            .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        || Path::new(n).components().count() != 1
        || !matches!(Path::new(n).components().next(), Some(Component::Normal(_)));
    if bad {
        Err(t!(
            "Navnet må ikke indeholde / \\ : * ? \" < > |",
            "The name cannot contain / \\ : * ? \" < > |"
        )
        .to_owned())
    } else {
        Ok(n)
    }
}

fn list(path: &Path, root: &Path) -> Result<Folder, String> {
    let mut entries = Vec::new();
    let house = house_rules(root);
    let rd = fs::read_dir(path).map_err(|e| {
        t!(
            format!("Mappen kunne ikke læses: {e}"),
            format!("The folder could not be read: {e}")
        )
    })?;
    for item in rd.filter_map(|e| e.ok()) {
        let p = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        let Ok(meta) = item.metadata() else { continue };
        let rel = p
            .strip_prefix(root)
            .unwrap_or(&p)
            .to_string_lossy()
            .replace('\\', "/");
        if meta.is_dir() {
            if (if house {
                is_hidden_dir(&name)
            } else {
                always_hidden(&name)
            }) || is_worktree(&p)
            {
                continue;
            }
            let vis = visibility(&format!("{rel}/x.md"), house);
            if vis == Visibility::Hidden {
                continue;
            }
            entries.push(Entry {
                name,
                path: p.to_string_lossy().into_owned(),
                is_dir: true,
                modified_ms: modified_ms(&meta),
                visibility: if house
                    && CONTRACT_DIRS
                        .contains(&item.file_name().to_string_lossy().to_lowercase().as_str())
                {
                    Visibility::Dimmed
                } else {
                    vis
                },
                preview: String::new(),
            });
        } else {
            let ext = p
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !TEXT_EXT.contains(&ext.as_str()) || name.starts_with('~') || name.starts_with('.') {
                continue;
            }
            let vis = visibility(&rel, house);
            if vis == Visibility::Hidden {
                continue;
            }
            entries.push(Entry {
                preview: read_preview(&p, &meta),
                name,
                path: p.to_string_lossy().into_owned(),
                is_dir: false,
                modified_ms: modified_ms(&meta),
                visibility: vis,
            });
        }
    }
    let parent = path
        .parent()
        .filter(|pp| pp.starts_with(root) && *pp != path)
        .map(|pp| pp.to_string_lossy().into_owned());
    Ok(Folder {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        parent,
        entries,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub path: String,
    pub name: String,
    pub exists: bool,
}

#[tauri::command]
pub fn list_libraries(app: AppHandle) -> Vec<Library> {
    settings::load(&app)
        .libraries
        .into_iter()
        .map(|p| Library {
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.to_string_lossy().into_owned()),
            exists: p.is_dir(),
            path: p.to_string_lossy().into_owned(),
        })
        .collect()
}

#[tauri::command]
pub async fn list_folder(app: AppHandle, path: String) -> Result<Folder, String> {
    let p = PathBuf::from(&path);
    let root = guard(&app, &p)?;
    let canon =
        dunce_canonical(&p).ok_or(t!("Mappen findes ikke.", "The folder does not exist."))?;
    list(&canon, &root)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub name: String,
    pub path: String,
    /// Mappen relativt til biblioteket, til visning i hurtigåbningen.
    pub folder: String,
    pub modified_ms: u64,
    pub dimmed: bool,
}

/// Alle tekstfiler i bibliotekerne til hurtigåbningen (Ctrl+O). Skjulte mapper og worktrees
/// springes over, så `node_modules` aldrig læses. Højst 20.000 filer.
#[tauri::command]
pub async fn list_all_files(app: AppHandle) -> Vec<FileHit> {
    files_in(settings::load(&app).libraries)
}

/// Tekstfilerne i bibliotekerne. Et bibliotek inde i et andet (`Dokumenter\Gode Tekster` i
/// `Dokumenter`) giver ikke filerne to gange (6/10: søgningen læste hundredvis af filer
/// dobbelt). Det første bibliotek, der har filen, bestemmer mappen, der vises.
pub fn files_in(libraries: Vec<PathBuf>) -> Vec<FileHit> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for root in libraries.into_iter().filter_map(|l| dunce_canonical(&l)) {
        let house = house_rules(&root);
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for item in rd.filter_map(|e| e.ok()) {
                let p = item.path();
                let name = item.file_name().to_string_lossy().into_owned();
                let Ok(ft) = item.file_type() else { continue };
                if ft.is_dir() {
                    let hidden = if house {
                        is_hidden_dir(&name)
                    } else {
                        always_hidden(&name)
                    };
                    if !hidden && !is_worktree(&p) {
                        stack.push(p);
                    }
                    continue;
                }
                let ext = p
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if !TEXT_EXT.contains(&ext.as_str()) || name.starts_with('~') {
                    continue;
                }
                let rel = p
                    .strip_prefix(&root)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .replace('\\', "/");
                let vis = visibility(&rel, house);
                if vis == Visibility::Hidden {
                    continue;
                }
                let folder = rel
                    .rsplit_once('/')
                    .map(|(f, _)| f.to_owned())
                    .unwrap_or_default();
                if !seen.insert(p.clone()) {
                    continue;
                }
                out.push(FileHit {
                    modified_ms: item.metadata().map(|m| modified_ms(&m)).unwrap_or(0),
                    dimmed: vis == Visibility::Dimmed,
                    name,
                    path: p.to_string_lossy().into_owned(),
                    folder,
                });
                if out.len() >= 20_000 {
                    return out;
                }
            }
        }
    }
    out
}

/// Ingen tekst at starte på (5/10): en blank tekst i mappen, den sidste tekst lå i, hvis
/// den er i et bibliotek, ellers i det første bibliotek, ellers i Dokumenter\Gode Tekster (som så
/// bliver bibliotek). En tom »Uden titel« dér genbruges, så tomme filer ikke hober sig op. Navnet
/// kommer, når første linje er skrevet (ui/autoName.ts).
pub fn blank_text(app: &AppHandle, last: Option<&Path>) -> Option<PathBuf> {
    let libs = settings::load(app).libraries;
    let dir = last
        .and_then(Path::parent)
        .filter(|d| d.is_dir() && library_root_of(&libs, d).is_some())
        .map(Path::to_path_buf)
        .or_else(|| libs.iter().find(|l| l.is_dir()).cloned())
        .or_else(|| {
            use tauri::Manager;
            let d = app.path().document_dir().ok()?.join("Gode Tekster");
            fs::create_dir_all(&d).ok()?;
            settings::add_library_path(app, &d);
            Some(d)
        })?;
    let base = t!("Uden titel", "Untitled");
    let empty_untitled = fs::read_dir(&dir).ok()?.flatten().find(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        let stem = name.strip_suffix(".md").unwrap_or("");
        let numbered = stem
            .strip_prefix(base)
            .is_some_and(|rest| rest.is_empty() || rest.trim_start().parse::<u32>().is_ok());
        numbered && e.metadata().is_ok_and(|m| m.is_file() && m.len() == 0)
    });
    if let Some(e) = empty_untitled {
        return Some(e.path());
    }
    let p = unique(&dir, base, ".md");
    fs::write(&p, "").ok()?;
    Some(p)
}

fn unique(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{base}{ext}"));
    let mut i = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{base} {i}{ext}"));
        i += 1;
    }
    candidate
}

#[tauri::command]
pub async fn create_file(app: AppHandle, dir: String) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    guard(&app, &d)?;
    let p = unique(&d, t!("Uden titel", "Untitled"), ".md");
    fs::write(&p, "").map_err(|e| {
        t!(
            format!("Filen kunne ikke oprettes: {e}"),
            format!("The file could not be created: {e}")
        )
    })?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn create_folder(app: AppHandle, dir: String) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    guard(&app, &d)?;
    let p = unique(&d, t!("Ny mappe", "New folder"), "");
    fs::create_dir(&p).map_err(|e| {
        t!(
            format!("Mappen kunne ikke oprettes: {e}"),
            format!("The folder could not be created: {e}")
        )
    })?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn rename_entry(
    app: AppHandle,
    path: String,
    new_name: String,
) -> Result<String, String> {
    rename_path(&app, &PathBuf::from(&path), &new_name).map(|t| t.to_string_lossy().into_owned())
}

/// Omdøb en fil eller mappe inden for bibliotekerne. Også document.rs, når en ny tekst får navn
/// efter sin første linje (5/10).
pub fn rename_path(app: &AppHandle, p: &Path, new_name: &str) -> Result<PathBuf, String> {
    let p = p.to_path_buf();
    guard(app, &p)?;
    let name = valid_name(new_name)?;
    let parent = p
        .parent()
        .ok_or(t!("Ingen mappe over.", "There is no folder above."))?;
    // En fil må kun hedde noget, biblioteket viser som tekst. Ellers kunne en tekst blive til en
    // .cmd, der kører ved næste login (sikkerhedsreview 2/10).
    if p.is_file() {
        let ext = Path::new(name)
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase());
        if ext.as_deref().is_some_and(|e| !TEXT_EXT.contains(&e)) {
            return Err(t!(
                "En tekst kan kun hedde .md, .markdown, .txt eller .docx.",
                "A text can only end in .md, .markdown, .txt or .docx."
            )
            .to_owned());
        }
    }
    // En fil uden filtype beholder sin gamle (»ARTIKEL« → »ARTIKEL.md«).
    let target = if p.is_file() && Path::new(name).extension().is_none() {
        let ext = p
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        parent.join(format!("{name}{ext}"))
    } else {
        parent.join(name)
    };
    if target.exists() && !target.eq(&p) {
        return Err(t!(
            "Der findes allerede noget med det navn.",
            "Something with that name already exists."
        )
        .to_owned());
    }
    fs::rename(&p, &target).map_err(|e| {
        t!(
            format!("Kunne ikke omdøbe: {e}"),
            format!("Could not rename: {e}")
        )
    })?;
    Ok(target)
}

/// Til papirkurven, aldrig slettet for altid.
#[tauri::command]
pub async fn delete_entry(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let root = guard(&app, &p)?;
    if dunce_canonical(&p).as_deref() == Some(root.as_path()) {
        return Err(t!(
            "Et helt bibliotek kan ikke slettes herfra.",
            "A whole library cannot be deleted from here."
        )
        .to_owned());
    }
    trash::delete(&p).map_err(|e| {
        t!(
            format!("Kunne ikke lægge i papirkurven: {e}"),
            format!("Could not move to the Recycle Bin: {e}")
        )
    })
}

#[tauri::command]
pub async fn move_entry(app: AppHandle, path: String, dir: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let d = PathBuf::from(&dir);
    guard(&app, &p)?;
    guard(&app, &d)?;
    if d.starts_with(&p) {
        return Err(t!(
            "En mappe kan ikke flyttes ind i sig selv.",
            "A folder cannot be moved into itself."
        )
        .to_owned());
    }
    let name = p.file_name().ok_or(t!("Intet navn.", "No name."))?;
    let target = d.join(name);
    if target.exists() {
        return Err(t!(
            "Der findes allerede noget med det navn i mappen.",
            "Something with that name already exists in the folder."
        )
        .to_owned());
    }
    fs::rename(&p, &target).map_err(|e| {
        t!(
            format!("Kunne ikke flytte: {e}"),
            format!("Could not move: {e}")
        )
    })?;
    Ok(target.to_string_lossy().into_owned())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clipping {
    pub name: String,
    pub path: String,
}

/// Fraklipsfiler ved siden af teksten (`FRAKLIP.md`, `FRAKLIP-kopi.md` …), som kan hentes ind i
/// fanen Fraklip (ADR-0008). Kræver ikke, at teksten ligger i et bibliotek: brugeren har åbnet den.
#[tauri::command]
pub async fn sibling_clippings(app: AppHandle, path: String) -> Vec<Clipping> {
    let p = PathBuf::from(&path);
    if !crate::document::open_paths(&app).contains(&p) {
        return Vec::new();
    }
    let Some(dir) = p.parent() else {
        return Vec::new();
    };
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|f| {
            let name = f
                .file_name()
                .map(|n| n.to_string_lossy().to_uppercase())
                .unwrap_or_default();
            name.starts_with("FRAKLIP") && name.ends_with(".MD") && !f.eq(&p)
        })
        .map(|f| Clipping {
            name: f
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: f.to_string_lossy().into_owned(),
        })
        .collect()
}

/// Teksten i en fil uden forfatterblok (til import af fraklip). Kun FRAKLIP*.md i samme mappe
/// som en åben tekst.
#[tauri::command]
pub async fn read_clipping(app: AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_uppercase())
        .unwrap_or_default();
    let beside_open = crate::document::open_paths(&app)
        .iter()
        .any(|o| o.parent().is_some() && o.parent() == p.parent());
    if !name.starts_with("FRAKLIP") || !name.ends_with(".MD") || !beside_open {
        return Err(t!(
            "Kun fraklipsfiler ved siden af den åbne tekst kan hentes ind.",
            "Only clippings files next to the open text can be brought in."
        )
        .to_owned());
    }
    let opened = crate::files::open(&p).map_err(|e| {
        t!(
            format!("Fraklipsfilen kunne ikke læses: {e}"),
            format!("The clippings file could not be read: {e}")
        )
    })?;
    Ok(crate::annotations::parse(&opened.text, opened.meta.eol).text)
}

/// Word-import (del G): bytes af en .docx i et bibliotek. Fladen oversætter dem til markdown.
#[tauri::command]
pub async fn read_docx(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let p = PathBuf::from(&path);
    guard(&app, &p)?;
    let is_docx = p
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("docx"));
    if !is_docx {
        return Err(t!(
            "Kun Word-filer (.docx) kan hentes ind.",
            "Only Word files (.docx) can be imported."
        )
        .to_owned());
    }
    let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
    if size > 50 * 1024 * 1024 {
        return Err(t!(
            "Word-filen er over 50 MB og kan ikke hentes ind.",
            "The Word file is over 50 MB and cannot be imported."
        )
        .to_owned());
    }
    let bytes = fs::read(&p).map_err(|e| {
        t!(
            format!("Word-filen kunne ikke læses: {e}"),
            format!("The Word file could not be read: {e}")
        )
    })?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Den nye .md ved siden af Word-filen, med samme navn (eller »Navn 2.md«, hvis det er taget).
/// Word-filen røres ikke.
#[tauri::command]
pub async fn create_import(app: AppHandle, source: String, text: String) -> Result<String, String> {
    let src = PathBuf::from(&source);
    guard(&app, &src)?;
    let dir = src
        .parent()
        .ok_or(t!("Mappen findes ikke.", "The folder does not exist."))?;
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| t!("Fra Word", "From Word").to_owned());
    let target = unique(dir, &stem, ".md");
    crate::files::write_atomic(&target, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Samme sager som den tidligere `library.test.ts`, med stier som i et rigtigt bibliotek (2/10).

    #[test]
    fn skribentens_egne_tekster_vises_normalt() {
        for f in [
            "Fagbladet/artikler/en-sag/udkast.md",
            "Kunde B/dokumenter/Egen research/noter.md",
            "Kunde A/dokumenter/aftale/Oplæg for redaktionen.md",
            "Strategi_Kunde.docx.md",
            "Fagbladet/artikler/en-sag/ARTIKEL.md",
            "Fagbladet/artikler/en-sag/FRAKLIP.md",
            "RÅNOTER.md",
            "VIDEO MANUS.md",
            "KILDER.md",
            "strategi.md",
            "politik.md",
            "kunde.md",
        ] {
            assert_eq!(visibility_of(f), Visibility::Normal, "{f}");
        }
    }

    #[test]
    fn husets_kontraktfiler_daempes() {
        for f in [
            "AGENTS.md",
            "CLAUDE.md",
            "HANDOFF.md",
            "HANDOFF-ARKIV.md",
            "TODO.md",
            "TODO-teknisk.md",
            "Kunde A/KUNDE.md",
            "Kunde A/ARKIV.md",
            "LÆSMIG.md",
            "LICENSE.md",
            "projekt/todo.md",
            "Kunde A/docs/styring/politik.md",
            "noter\\lektioner\\git.md",
        ] {
            assert_eq!(visibility_of(f), Visibility::Dimmed, "{f}");
        }
    }

    #[test]
    fn maskinens_mapper_skjules() {
        for f in [
            "app/node_modules/pkg/notes.md",
            "Kunde A/.claude/worktrees/x/AGENTS.md",
            "Kunde A/web/.next/server/x.md",
            "gode-tekster/src-tauri/target/debug/x.md",
            "spejl/bruger/x.md",
        ] {
            assert_eq!(visibility_of(f), Visibility::Hidden, "{f}");
        }
    }

    #[test]
    fn uddrag_uden_markdown_og_forfatterblok() {
        let text = "# Overskrift\n\n**Fed** start af teksten.\n\n---\nAnnotations: 0,5 SHA-256 abc  \n...\n";
        assert_eq!(preview_of(text), "Overskrift Fed start af teksten.");
    }

    #[test]
    fn ugyldige_navne_afvises() {
        assert!(valid_name("ARTIKEL").is_ok());
        assert!(valid_name("Ny mappe").is_ok());
        for bad in ["", "..", "a/b", "a\\b", "x:y", "spørgsmål?"] {
            assert!(valid_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn worktree_genkendes_paa_git_filen() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".git"), "gitdir: x").unwrap();
        assert!(is_worktree(dir.path()));
        let repo = tempfile::tempdir().unwrap();
        fs::create_dir(repo.path().join(".git")).unwrap();
        assert!(!is_worktree(repo.path()));
    }

    #[test]
    fn mappeliste_springer_skjult_over() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        fs::create_dir(r.join("artikler")).unwrap();
        fs::create_dir(r.join("node_modules")).unwrap();
        fs::create_dir(r.join("wt")).unwrap();
        fs::write(r.join("wt/.git"), "gitdir: x").unwrap();
        fs::write(r.join("ARTIKEL.md"), "# Titel\nTekst").unwrap();
        fs::write(r.join("AGENTS.md"), "regler").unwrap();
        fs::write(r.join("billede.png"), "x").unwrap();
        let f = list(r, r).unwrap();
        let mut names: Vec<_> = f
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.visibility))
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                ("AGENTS.md", Visibility::Dimmed),
                ("ARTIKEL.md", Visibility::Normal),
                ("artikler", Visibility::Normal)
            ]
        );
    }
}
