//! Stier, der skal findes ens overalt: programmets datamappe og kanoniske stier uden Windows'
//! `\\?\`-præfiks.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Programmets datamappe (`%LOCALAPPDATA%\<id>`). Mappen er ikke nødvendigvis lavet endnu.
pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map_err(|e| {
        t!(
            format!("Programmets datamappe blev ikke fundet: {e}"),
            format!("The app's data folder was not found: {e}")
        )
    })
}

/// Kanonisk sti uden Windows' `\\?\`-præfiks, så den kan sammenlignes og vises. `None`, hvis
/// stien ikke findes.
pub(crate) fn canonical(path: &Path) -> Option<PathBuf> {
    let c = std::fs::canonicalize(path).ok()?;
    let s = c.to_string_lossy();
    Some(PathBuf::from(
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kanonisk_sti_uden_praefiks() {
        let dir = std::env::temp_dir();
        let c = canonical(&dir).unwrap();
        assert!(!c.to_string_lossy().starts_with(r"\\?\"));
        assert!(c.is_absolute());
        assert_eq!(canonical(&dir.join("findes-ikke-gt-paths")), None);
    }
}
