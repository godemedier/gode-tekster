//! Hvad der synkes (ADR-0054): kun tekst (`.md`, `.txt`) og billeder i mapper, der hedder
//! `medier` (ADR-0023). En positivliste frem for en liste over mapper at holde ude: så kommer
//! videoer, lydfiler, zip og projekters rådata aldrig med ved et uheld. Skjulte navne (punktum
//! først) og andre programmers midlertidige filer synkes aldrig.

use crate::{sti, MAX_SIZE};

/// Navnet på filen i synkroden, der holder flere mapper ude (en sti pr. linje, `#` er kommentar).
pub const IGNORE_FILE: &str = ".godesynk-ignorer";

const TEXT: &[&str] = &["md", "markdown", "txt"];
const IMAGES: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];
const MEDIA_DIR: &str = "medier";

/// Stier fra [`IGNORE_FILE`], som nøgler.
#[derive(Debug, Default, Clone)]
pub struct Ignorer {
    prefixes: Vec<String>,
}

impl Ignorer {
    pub fn parse(text: &str) -> Self {
        let prefixes = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .filter_map(|l| sti::normalize(l.trim_matches('/')).ok())
            .map(|p| sti::key(&p))
            .collect();
        Ignorer { prefixes }
    }

    pub fn ignores(&self, norm: &str) -> bool {
        let k = sti::key(norm);
        self.prefixes
            .iter()
            .any(|p| k == *p || (k.starts_with(p.as_str()) && k[p.len()..].starts_with('/')))
    }
}

/// Synkes filen? `norm` er en normaliseret sti ([`sti::normalize`]).
pub fn synced(norm: &str, size: u64, ignorer: &Ignorer) -> bool {
    if size > MAX_SIZE || ignorer.ignores(norm) {
        return false;
    }
    let parts: Vec<&str> = norm.split('/').collect();
    let Some((name, dirs)) = parts.split_last() else {
        return false;
    };
    if parts.iter().any(|p| p.starts_with('.')) || is_temp(name) {
        return false;
    }
    let ext = match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_lowercase(),
        _ => return false,
    };
    if TEXT.contains(&ext.as_str()) {
        return true;
    }
    IMAGES.contains(&ext.as_str()) && dirs.iter().any(|d| d.eq_ignore_ascii_case(MEDIA_DIR))
}

/// Kun tekst kan flettes. Alt andet får en konfliktkopi.
pub fn mergeable(norm: &str) -> bool {
    let name = norm.rsplit('/').next().unwrap_or(norm);
    name.rfind('.')
        .is_some_and(|i| TEXT.contains(&name[i + 1..].to_lowercase().as_str()))
}

/// Word, Office og editorers midlertidige filer (`~$Artikel.docx`, `Artikel.md~`, `x.tmp`).
fn is_temp(name: &str) -> bool {
    let lower = name.to_lowercase();
    name.starts_with("~$")
        || name.ends_with('~')
        || lower.ends_with(".tmp")
        || lower.ends_with(".swp")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: &str) -> bool {
        synced(p, 100, &Ignorer::default())
    }

    #[test]
    fn tekst_ja_alt_andet_nej() {
        assert!(s("Skriv/Kapitel 1.md"));
        assert!(s("Noter/liste.TXT"));
        assert!(!s("Videoer/ferie.mp4"));
        assert!(!s("Research/data/høring.json"));
        assert!(!s("Research/data/arkiv.zip"));
        assert!(!s("Forsikring/police.pdf"));
        assert!(!s("README"));
    }

    #[test]
    fn billeder_kun_i_medier() {
        assert!(s("Skriv/medier/forside.jpg"));
        assert!(s("Skriv/Medier/x/forside.PNG"));
        assert!(!s("photos/forside.jpg"));
    }

    #[test]
    fn skjult_og_midlertidigt_holdes_ude() {
        assert!(!s(".godesynk"));
        assert!(!s("Skriv/.papirkurv/gammel.md"));
        assert!(!s("Skriv/.Artikel.md.123-456.gt.tmp"));
        assert!(!s("Skriv/~$Artikel.md"));
        assert!(!s("Skriv/Artikel.md~"));
        assert!(!s(".obsidian/app.md"));
    }

    #[test]
    fn for_stor_fil_synkes_ikke() {
        assert!(!synced("a.md", MAX_SIZE + 1, &Ignorer::default()));
    }

    #[test]
    fn ignorerfilen_holder_mapper_ude() {
        let ign = Ignorer::parse("# rådata\nProjekter/Målinger/data\n/Arkiv_/\n\n");
        assert!(!synced("projekter/målinger/data/x.md", 1, &ign));
        assert!(!synced("Arkiv_/gammel.md", 1, &ign));
        assert!(synced("Projekter/Målinger/notat.md", 1, &ign));
        assert!(synced("Arkiv_2/ny.md", 1, &ign));
    }

    #[test]
    fn kun_tekst_flettes() {
        assert!(mergeable("a/b.md"));
        assert!(!mergeable("a/medier/b.png"));
    }
}
