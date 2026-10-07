//! Første start (delbar udgave 3/10, plan punkt 1): mappen `Dokumenter\Gode Tekster` laves stille,
//! velkomsthilsenen og vejledningen lægges i den, mappen bliver første bibliotek, og programmet
//! åbner på hilsenen. Ingen guide og intet mappevalg: man kan skrive med det samme.
//!
//! »Første start« betyder, at indstillingsfilen ikke fandtes, da programmet startede. Det afgøres
//! i `setup`, før noget kan nå at skrive filen. En eksisterende fil i mappen overskrives aldrig.

use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

const WELCOME: &str = include_str!("../welcome/velkommen.md");
const GUIDE: &str = include_str!("../welcome/vejledning.md");
pub const WELCOME_NAME: &str = "Velkommen.md";
pub const GUIDE_NAME: &str = "Sådan virker Gode Tekster.md";

// Engelsk (i18n.rs, 5/10). Mappen hedder det samme på begge sprog.
const WELCOME_EN: &str = include_str!("../welcome/velkommen.en.md");
const GUIDE_EN: &str = include_str!("../welcome/vejledning.en.md");
pub const WELCOME_NAME_EN: &str = "Welcome.md";
pub const GUIDE_NAME_EN: &str = "How Gode Tekster works.md";

/// Navn og tekst for hilsenen og vejledningen, i den rækkefølge.
fn texts(english: bool) -> [(&'static str, &'static str); 2] {
    if english {
        [(WELCOME_NAME_EN, WELCOME_EN), (GUIDE_NAME_EN, GUIDE_EN)]
    } else {
        [(WELCOME_NAME, WELCOME), (GUIDE_NAME, GUIDE)]
    }
}

static FIRST_RUN: OnceLock<bool> = OnceLock::new();

/// Kaldes én gang i `setup`. Testkørsler (GT_TEST) er aldrig en første start.
pub fn detect(app: &AppHandle) {
    let first = !crate::settings::exists(app) && std::env::var("GT_TEST").is_err();
    let _ = FIRST_RUN.set(first);
}

/// Første start: læg teksterne og returnér hilsenen, der skal åbnes. Kun én gang pr. kørsel.
pub fn prepare(app: &AppHandle) -> Option<PathBuf> {
    static DONE: OnceLock<()> = OnceLock::new();
    if !FIRST_RUN.get().copied().unwrap_or(false) || DONE.set(()).is_err() {
        return None;
    }
    let dir = app.path().document_dir().ok()?.join("Gode Tekster");
    match write_texts(&dir, crate::i18n::english()) {
        Ok(welcome) => {
            crate::settings::add_library_path(app, &dir);
            crate::applog::write(
                app,
                "første start: velkomst lagt i Dokumenter\\Gode Tekster",
            );
            Some(welcome)
        }
        Err(e) => {
            crate::applog::write(app, &format!("FEJL første start: {e}"));
            None
        }
    }
}

/// Mappen og de to tekster. Findes en af dem allerede (geninstallation), bliver den stående.
fn write_texts(dir: &std::path::Path, english: bool) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let texts = texts(english);
    for (name, text) in texts {
        let path = dir.join(name);
        if !path.exists() {
            crate::files::write_atomic(&path, text.replace("\r\n", "\n").as_bytes())
                .map_err(|e| std::io::Error::other(e.to_string()))?;
        }
    }
    Ok(dir.join(texts[0].0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teksterne_laegges_uden_at_overskrive() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().join("Gode Tekster");
        let welcome = write_texts(&d, false).unwrap();
        assert!(std::fs::read_to_string(&welcome)
            .unwrap()
            .starts_with("# Velkommen"));
        assert!(d.join(GUIDE_NAME).is_file());
        std::fs::write(&welcome, "Min egen tekst").unwrap();
        write_texts(&d, false).unwrap();
        assert_eq!(std::fs::read_to_string(&welcome).unwrap(), "Min egen tekst");
    }

    #[test]
    fn engelske_tekster_med_engelske_navne() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().join("Gode Tekster");
        let welcome = write_texts(&d, true).unwrap();
        assert_eq!(welcome, d.join("Welcome.md"));
        assert!(std::fs::read_to_string(&welcome)
            .unwrap()
            .starts_with("# Welcome"));
        assert!(d.join(GUIDE_NAME_EN).is_file());
        assert!(!d.join(WELCOME_NAME).exists());
    }

    #[test]
    fn hilsenen_linker_til_vejledningen() {
        // Linket i hilsenen skal ramme filnavnet, ellers virker Ctrl+klik ikke. På begge sprog.
        for [(_, welcome), (guide_name, guide)] in [texts(false), texts(true)] {
            let encoded = guide_name.replace(' ', "%20");
            assert!(welcome.contains(&format!("]({encoded})")), "{encoded}");
            assert!(
                !welcome.contains('—') && !guide.contains('—'),
                "ingen lange tankestreger"
            );
        }
        // Fraklip-eksemplet nederst i vejledningen har samme mærke på begge sprog.
        assert!(GUIDE_EN.contains(
            "<!-- gt:parkeret id=p1 dato=2026-10-05
"
        ));
    }
}
