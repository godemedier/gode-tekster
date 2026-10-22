//! Segl på AI-svar, der gemmes i filen (sikkerhedsfund 3, audit 9/10). Et faktatjek eller en research
//! i en `gt:claude`-blok er bare tekst, så en fremmed .md kan bære »Korrekt« og »Citatet står på
//! dst.dk«, uden at noget er tjekket. Når svaret gemmes, laver fladen et segl over modellens del
//! (blake3 med en nøgle, der kun findes på denne pc). Ved visning tjekkes seglet: uden et gyldigt
//! segl vises blokken som »Fra filen, ikke tjekket her«.
//!
//! Nøglen ligger i Windows' legitimationsadministrator som Gemini- og Mistral-nøglen
//! (`credentials.rs`) og laves første gang. Fladen ser aldrig nøglen, kun seglet.

use std::sync::OnceLock;

const TARGET: &str = "Gode Tekster/Segl";

/// Nøglen, læst eller lavet én gang pr. kørsel. `None`, hvis den hverken kan læses eller gemmes:
/// så kan intet forsegles, og alt vises som ikke tjekket her.
fn key() -> Option<[u8; 32]> {
    static KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();
    *KEY.get_or_init(|| {
        if let Some(k) = crate::credentials::read(TARGET).and_then(|hex| decode(&hex)) {
            return Some(k);
        }
        let mut k = [0u8; 32];
        getrandom::fill(&mut k).ok()?;
        crate::credentials::write(TARGET, "Segl", &encode(&k)).ok()?;
        Some(k)
    })
}

fn encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode(hex: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    if hex.len() != 64 {
        return None;
    }
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(hex.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(out)
}

fn seal_with(key: &[u8; 32], text: &str) -> String {
    blake3::keyed_hash(key, text.as_bytes())
        .to_hex()
        .to_string()
}

fn check_with(key: &[u8; 32], text: &str, seal: &str) -> bool {
    // `blake3::Hash` sammenlignes i konstant tid.
    blake3::Hash::from_hex(seal).is_ok_and(|s| s == blake3::keyed_hash(key, text.as_bytes()))
}

/// Seglet over `text` (modellens del af blokken som JSON).
#[tauri::command]
pub fn seal_text(text: String) -> Result<String, String> {
    key().map(|k| seal_with(&k, &text)).ok_or_else(|| {
        t!(
            "Svaret kunne ikke forsegles, fordi nøglen ikke kunne gemmes i Windows.",
            "The answer could not be sealed because the key could not be saved in Windows."
        )
        .to_owned()
    })
}

/// Er `seal` lavet over `text` på denne pc?
#[tauri::command]
pub fn seal_check(text: String, seal: String) -> bool {
    key().is_some_and(|k| check_with(&k, &text, &seal))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seglet_passer_kun_til_teksten_og_noeglen() {
        let k = [7u8; 32];
        let s = seal_with(&k, r#"[{"quote":"a"}]"#);
        assert!(check_with(&k, r#"[{"quote":"a"}]"#, &s));
        assert!(!check_with(&k, r#"[{"quote":"b"}]"#, &s));
        assert!(!check_with(&[8u8; 32], r#"[{"quote":"a"}]"#, &s));
        assert!(!check_with(&k, r#"[{"quote":"a"}]"#, "ikke et segl"));
        assert_eq!(decode(&encode(&k)), Some(k));
        assert_eq!(decode("zz"), None);
    }
}
