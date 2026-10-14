//! Stier på tværs af Windows, Android og Linux.
//!
//! På nettet er en sti relativ til synkmappen, med `/` og i Unicode NFC. Windows skelner ikke store
//! og små bogstaver, Android og Linux gør, så serveren nøgler på [`key`] og afviser to filer, der
//! kun adskiller sig dér. Navne, Windows ikke kan gemme, afvises, allerede når de oprettes på
//! telefonen eller i browseren (oplægget, »Kendte fælder«).

use std::fmt;
use std::path::{Component, Path, PathBuf};

use unicode_normalization::UnicodeNormalization;

/// Plads til roden af synkmappen under Windows' MAX_PATH på 260 tegn.
pub const MAX_CHARS: usize = 200;
/// Højeste længde af ét navn i bytes (NTFS og ext4 tillader 255).
const MAX_PART_BYTES: usize = 255;

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "COM¹", "COM²", "COM³", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
    "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StiFejl {
    Tom,
    Absolut,
    Prik,
    Tegn(char),
    Reserveret(String),
    Slutter(String),
    ForLang,
}

impl fmt::Display for StiFejl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StiFejl::Tom => write!(f, "Navnet er tomt."),
            StiFejl::Absolut => write!(f, "Stien skal ligge i synkmappen."),
            StiFejl::Prik => write!(f, "Et navn må ikke være ».« eller »..«."),
            StiFejl::Tegn(c) if c.is_control() => write!(f, "Navnet indeholder et usynligt tegn."),
            StiFejl::Tegn(c) => write!(f, "Windows tillader ikke tegnet »{c}« i et navn."),
            StiFejl::Reserveret(n) => write!(f, "»{n}« er et navn, Windows har reserveret."),
            StiFejl::Slutter(n) => {
                write!(
                    f,
                    "»{n}« slutter med punktum eller mellemrum, og det tåler Windows ikke."
                )
            }
            StiFejl::ForLang => write!(f, "Navnet eller stien er for lang til Windows."),
        }
    }
}

/// Gør en relativ sti klar til nettet: `/` som skilletegn, NFC, og kun navne, alle tre systemer kan
/// gemme. Backslash læses som skilletegn, så en sti fra Windows kan gives direkte.
pub fn normalize(rel: &str) -> Result<String, StiFejl> {
    let s: String = rel.replace('\\', "/").nfc().collect();
    if s.is_empty() {
        return Err(StiFejl::Tom);
    }
    let b = s.as_bytes();
    let drive = b.len() >= 2
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && b.get(2).is_none_or(|c| *c == b'/');
    if s.starts_with('/') || drive {
        return Err(StiFejl::Absolut);
    }
    if s.chars().count() > MAX_CHARS {
        return Err(StiFejl::ForLang);
    }
    for part in s.split('/') {
        check_part(part)?;
    }
    Ok(s)
}

fn check_part(part: &str) -> Result<(), StiFejl> {
    if part.is_empty() {
        return Err(StiFejl::Tom);
    }
    if part == "." || part == ".." {
        return Err(StiFejl::Prik);
    }
    if part.len() > MAX_PART_BYTES {
        return Err(StiFejl::ForLang);
    }
    if let Some(c) = part
        .chars()
        .find(|c| (*c as u32) < 32 || "<>:\"|?*".contains(*c))
    {
        return Err(StiFejl::Tegn(c));
    }
    if part.ends_with('.') || part.ends_with(' ') {
        return Err(StiFejl::Slutter(part.to_owned()));
    }
    // »NUL.txt« og »con .md« er lige så reserverede som »NUL«.
    let stem = part
        .split('.')
        .next()
        .unwrap_or(part)
        .trim_end()
        .to_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(StiFejl::Reserveret(part.to_owned()));
    }
    Ok(())
}

/// Nøglen, serveren kender filen på: små bogstaver, så `Noter.md` og `noter.md` er én fil.
pub fn key(norm: &str) -> String {
    norm.to_lowercase()
}

/// Stien på disken under `root`.
pub fn to_native(root: &Path, norm: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for part in norm.split('/') {
        p.push(part);
    }
    p
}

/// Den relative sti for en fil under `root`, med `/`. Ikke normaliseret: kalderen afgør, hvad et
/// ugyldigt navn betyder. `None` uden for roden eller for navne, der ikke er gyldig Unicode.
pub fn from_native(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str()?),
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Navnet på en konfliktkopi ved siden af originalen:
/// `Artikel (konflikt fra Telefon 2026-10-14 1532).md`. Tegn, Windows ikke tåler, fjernes fra
/// enhedens navn. Tiden gives af kalderen, så navnet kan testes.
pub fn conflict_name(norm: &str, device: &str, when: &str) -> String {
    let (dir, name) = match norm.rfind('/') {
        Some(i) => (&norm[..=i], &norm[i + 1..]),
        None => ("", norm),
    };
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let device: String = device
        .chars()
        .filter(|c| (*c as u32) >= 32 && !"<>:\"/\\|?*".contains(*c))
        .take(40)
        .collect();
    let device = device.trim();
    let device = if device.is_empty() {
        "anden enhed"
    } else {
        device
    };
    format!("{dir}{stem} (konflikt fra {device} {when}){ext}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backslash_og_nfd_bliver_til_nfc_med_skraastreg() {
        let nfd = "Skriv\\Fo\u{308}rste udkast.md"; // ö som o + prikker
        assert_eq!(normalize(nfd).as_deref(), Ok("Skriv/F\u{f6}rste udkast.md"));
        assert_eq!(
            normalize("Æblet/øl og ål.md").as_deref(),
            Ok("Æblet/øl og ål.md")
        );
    }

    #[test]
    fn windows_navne_afvises() {
        assert_eq!(normalize("a/b?.md"), Err(StiFejl::Tegn('?')));
        assert_eq!(normalize("a:b.md"), Err(StiFejl::Tegn(':')));
        assert_eq!(normalize("C:/x.md"), Err(StiFejl::Absolut));
        assert_eq!(normalize("/x.md"), Err(StiFejl::Absolut));
        assert!(matches!(normalize("NUL.txt"), Err(StiFejl::Reserveret(_))));
        assert!(matches!(
            normalize("noter/con .md"),
            Err(StiFejl::Reserveret(_))
        ));
        assert!(matches!(normalize("COM¹"), Err(StiFejl::Reserveret(_))));
        assert!(normalize("CONTRA.md").is_ok());
        assert!(matches!(normalize("mappe./x.md"), Err(StiFejl::Slutter(_))));
        assert!(matches!(normalize("x.md "), Err(StiFejl::Slutter(_))));
        assert_eq!(normalize("a//b.md"), Err(StiFejl::Tom));
        assert_eq!(normalize("../b.md"), Err(StiFejl::Prik));
        assert_eq!(normalize("a\u{7}.md"), Err(StiFejl::Tegn('\u{7}')));
        assert_eq!(normalize(&"x".repeat(MAX_CHARS + 1)), Err(StiFejl::ForLang));
    }

    #[test]
    fn noeglen_ser_bort_fra_store_bogstaver() {
        assert_eq!(key("Noter/ÆBLE.md"), key("noter/æble.md"));
    }

    #[test]
    fn frem_og_tilbage_paa_disken() {
        let root = Path::new("synkrod");
        let p = to_native(root, "Skriv/Kapitel 1.md");
        assert_eq!(from_native(root, &p).as_deref(), Some("Skriv/Kapitel 1.md"));
        assert_eq!(from_native(root, Path::new("andet/x.md")), None);
    }

    #[test]
    fn konfliktkopien_staar_ved_siden_af() {
        assert_eq!(
            conflict_name("Skriv/Artikel.md", "Telefon", "2026-10-14 1532"),
            "Skriv/Artikel (konflikt fra Telefon 2026-10-14 1532).md"
        );
        assert_eq!(
            conflict_name("README", "pc: \"kontor\"", "t"),
            "README (konflikt fra pc kontor t)"
        );
        assert_eq!(
            conflict_name(".skjult", "", "t"),
            ".skjult (konflikt fra anden enhed t)"
        );
        assert!(normalize(&conflict_name("a/b.md", "Min telefon", "2026-10-14 1532")).is_ok());
    }
}
