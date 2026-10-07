//! Billeder til teksten (2/10): et billede kopieres altid ind i en undermappe `medier` ved
//! siden af teksten og får et navn ud fra teksten, et løbenummer og billedets eget navn, fx
//! `medier/artikel-1-stefan-uhl.jpg`. Teksten peger på kopien med en relativ sti, så billedet
//! følger med, når mappen flyttes, og originalen røres aldrig.
//!
//! Der skrives kun ved siden af en tekst, der er åben (document.rs `open_paths`).

use std::path::{Path, PathBuf};

use tauri::AppHandle;

/// Alle gængse fotoformater (tjekket 2/10). HEIC og TIFF laves om til JPEG (convert.rs).
const IMAGE_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "heic", "heif", "tif", "tiff",
];
const MAX_BYTES: usize = 50 * 1024 * 1024;

/// Små bogstaver, æøå bevaret, alt andet bliver én bindestreg. Højst 40 tegn.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let trimmed: String = out.trim_end_matches('-').chars().take(40).collect();
    trimmed.trim_end_matches('-').to_owned()
}

/// Det næste ledige navn i `medier`: `<tekst>-<n>-<billede>.<ext>`.
pub fn media_name(dir: &Path, doc_stem: &str, original: &str, ext: &str) -> String {
    let prefix = slug(doc_stem);
    let prefix = if prefix.is_empty() {
        t!("billede", "image").to_owned()
    } else {
        prefix
    };
    let what = slug(original);
    let mut n = 1;
    loop {
        let name = if what.is_empty() {
            format!("{prefix}-{n}.{ext}")
        } else {
            format!("{prefix}-{n}-{what}.{ext}")
        };
        // Et nummer er brugt, hvis der findes en fil med samme forstavelse og nummer.
        let taken = std::fs::read_dir(dir).ok().is_some_and(|rd| {
            rd.filter_map(|e| e.ok()).any(|e| {
                let f = e.file_name().to_string_lossy().to_lowercase();
                f.starts_with(&format!("{prefix}-{n}-")) || f.starts_with(&format!("{prefix}-{n}."))
            })
        });
        if !taken {
            return name;
        }
        n += 1;
    }
}

fn ext_of(name: &str) -> Result<String, String> {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if IMAGE_EXT.contains(&ext.as_str()) {
        Ok(if ext == "jpeg" { "jpg".to_owned() } else { ext })
    } else {
        Err(t!(
            "Kun billeder (jpg, png, heic, webp, gif, avif, tiff, bmp, svg) kan sættes ind.",
            "Only images (jpg, png, heic, webp, gif, avif, tiff, bmp, svg) can be inserted."
        )
        .to_owned())
    }
}

/// Skriv billedet i `medier` ved siden af en åben tekst. Returnerer stien, teksten skal bruge.
fn store(app: &AppHandle, doc: &str, original: &str, bytes: &[u8]) -> Result<String, String> {
    let doc = PathBuf::from(doc);
    if !crate::document::open_paths(app).contains(&doc) {
        return Err(t!(
            "Billeder kan kun sættes ind i den åbne tekst.",
            "Images can only be inserted into the open text."
        )
        .to_owned());
    }
    if bytes.len() > MAX_BYTES {
        return Err(t!("Billedet er over 50 MB.", "The image is over 50 MB.").to_owned());
    }
    let mut ext = ext_of(original)?;
    let converted;
    let bytes = if crate::convert::CONVERT_EXT.contains(&ext.as_str()) {
        converted = crate::convert::to_jpeg(bytes, &ext)?;
        ext = "jpg".to_owned();
        &converted[..]
    } else {
        bytes
    };
    let dir = doc
        .parent()
        .ok_or(t!(
            "Tekstens mappe blev ikke fundet.",
            "The text's folder was not found."
        ))?
        .join("medier");
    std::fs::create_dir_all(&dir).map_err(|e| {
        t!(
            format!("Mappen medier kunne ikke laves: {e}"),
            format!("The medier folder could not be created: {e}")
        )
    })?;
    let stem = doc
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let original_stem = Path::new(original)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = media_name(&dir, &stem, &original_stem, &ext);
    crate::files::write_atomic(&dir.join(&name), bytes).map_err(|e| {
        t!(
            format!("Billedet kunne ikke gemmes: {e}"),
            format!("The image could not be saved: {e}")
        )
    })?;
    crate::applog::write(app, "billede lagt i medier");
    Ok(format!("medier/{name}"))
}

/// »Indsæt billede …« (Ctrl+Alt+I): Windows' vælger, og så en kopi i `medier`.
#[tauri::command]
pub async fn pick_image(app: AppHandle, doc: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let start = PathBuf::from(&doc);
    let mut dialog = app
        .dialog()
        .file()
        .set_title(t!("Vælg et billede", "Choose an image"))
        .add_filter(t!("Billeder", "Images"), IMAGE_EXT);
    if let Some(dir) = start.parent() {
        dialog = dialog.set_directory(dir);
    }
    let Some(picked) = dialog.blocking_pick_file().and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let bytes = std::fs::read(&picked).map_err(|e| {
        t!(
            format!("Billedet kunne ikke læses: {e}"),
            format!("The image could not be read: {e}")
        )
    })?;
    let name = picked
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    store(&app, &doc, &name, &bytes).map(Some)
}

/// Procent-afkodning af en header (fladen sender stier og navne med `encodeURIComponent`).
fn percent_decode(s: &str) -> String {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or_else(|| {
            t!(
                "Billedet kom uden oplysninger om teksten.",
                "The image came without information about the text."
            )
            .to_owned()
        })
}

/// Et billede trukket ind fra Stifinder eller sat ind med Ctrl+V (skærmbillede). Bytes kommer rå
/// over IPC (ikke som JSON-tal), teksten og navnet i headerne `x-doc` og `x-name`.
#[tauri::command]
pub async fn save_image(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(t!(
            "Billedet kom ikke som data.",
            "The image did not arrive as data."
        )
        .to_owned());
    };
    let doc = header(&request, "x-doc")?;
    let name = header(&request, "x-name")?;
    store(&app, &doc, &name, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navne_er_korte_og_laesbare() {
        assert_eq!(slug("Anne Holm (2024).JPG"), "anne-holm-2024-jpg");
        assert_eq!(slug("Ærø: Broen over Bæltet"), "ærø-broen-over-bæltet");
        assert_eq!(slug("---"), "");
    }

    #[test]
    fn loebenummeret_springer_brugte_over() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            media_name(dir.path(), "ARTIKEL", "Anne Holm", "jpg"),
            "artikel-1-anne-holm.jpg"
        );
        std::fs::write(dir.path().join("artikel-1-anne-holm.jpg"), b"x").unwrap();
        assert_eq!(
            media_name(dir.path(), "ARTIKEL", "Graf", "png"),
            "artikel-2-graf.png"
        );
        assert_eq!(
            media_name(dir.path(), "ARTIKEL", "", "png"),
            "artikel-2.png"
        );
    }

    #[test]
    fn headere_afkodes() {
        assert_eq!(
            percent_decode("C%3A%5Ctekster%5C%C3%A6r%C3%B8.md"),
            r"C:\tekster\ærø.md"
        );
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    #[test]
    fn kun_billeder() {
        assert_eq!(ext_of("a.JPEG").unwrap(), "jpg");
        assert!(ext_of("virus.exe").is_err());
    }
}
