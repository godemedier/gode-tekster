//! Kernen i synkroniseringen (ADR-0054). Delt af serveren, pc'en og telefonen, så reglerne for
//! stier og protokollen kun findes ét sted.
//!
//! - [`sti`]: hvordan en sti skrives på tværs af Windows, Android og Linux.
//! - [`filter`]: hvilke filer der synkes.
//! - [`protokol`]: typerne, der går over nettet.
//! - [`plan`]: hvad der skal ske med en fil, når basen, disken og serveren kendes.
//! - [`store`] (featuren `store`): serverens lager med compare-and-swap.

pub mod filter;
pub mod plan;
pub mod protokol;
pub mod sti;
#[cfg(feature = "store")]
pub mod store;

/// Indholdets id: blake3 af de rå bytes, som hex. Linjeskift og BOM tæller med, så en fil aldrig
/// ser ændret ud, fordi et program læste den anderledes.
pub fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Er det en gyldig hash fra [`hash`]? Serveren bruger den som filnavn, så den tjekkes stramt.
pub fn is_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Største fil, der synkes (oplægget: 20 MB).
pub const MAX_SIZE: u64 = 20 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_er_hex_og_genkendes() {
        let h = hash(b"Kim Skribent");
        assert!(is_hash(&h));
        assert!(!is_hash("../../etc/passwd"));
        assert!(!is_hash(&h.to_uppercase()));
    }
}
