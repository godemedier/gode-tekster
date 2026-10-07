//! Dansk og engelsk (5/10). Sproget er `language` i indstillingerne: "auto" følger Windows'
//! sprog (dansk kun, når Windows er på dansk), ellers "da" eller "en". Fladen spørger her
//! (`ui_language`), så Rust og fladen altid er enige.
//!
//! Teksterne står begge to ved kaldet: `t!("Filen blev ikke fundet.", "The file was not found.")`,
//! også med `format!` i hver gren.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

static ENGLISH: AtomicBool = AtomicBool::new(false);

/// Dansk eller engelsk tekst efter sproget. Begge grene skal have samme type.
#[macro_export]
macro_rules! t {
    ($da:expr, $en:expr $(,)?) => {
        if $crate::i18n::english() {
            $en
        } else {
            $da
        }
    };
}

pub fn english() -> bool {
    // Tests kører parallelt: hver testtråd har sit eget sprog, så en engelsk test aldrig får en
    // dansk test ved siden af til at fejle.
    #[cfg(test)]
    return TEST_ENGLISH.with(std::cell::Cell::get);
    #[cfg(not(test))]
    ENGLISH.load(Ordering::Relaxed)
}

#[cfg(test)]
thread_local! {
    static TEST_ENGLISH: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Sæt sproget ud fra indstillingen. Kaldes ved start og når indstillingerne gemmes.
pub fn apply(setting: &str) {
    let en = match setting {
        "da" => false,
        "en" => true,
        _ => !windows_is_danish(),
    };
    ENGLISH.store(en, Ordering::Relaxed);
    #[cfg(test)]
    TEST_ENGLISH.with(|c| c.set(en));
}

pub fn init(app: &AppHandle) {
    // Testkørsler kan vælge sproget uden at røre brugerens indstillinger.
    if let (Ok(_), Ok(l)) = (std::env::var("GT_TEST"), std::env::var("GT_SPROG")) {
        return apply(&l);
    }
    apply(&crate::settings::load(app).language);
}

#[cfg(windows)]
fn windows_is_danish() -> bool {
    // Det primære sprog-id er de nederste 10 bit. Dansk er 0x06 (LANG_DANISH).
    let id = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() };
    id & 0x3ff == 0x06
}

#[cfg(not(windows))]
fn windows_is_danish() -> bool {
    true
}

/// Til fladen: "da" eller "en".
#[tauri::command]
pub fn ui_language() -> &'static str {
    if english() {
        "en"
    } else {
        "da"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sproget_kan_vaelges_og_folger_ellers_windows() {
        apply("en");
        assert_eq!(t!("Gem", "Save"), "Save");
        apply("da");
        assert_eq!(t!("Gem", "Save"), "Gem");
        assert_eq!(ui_language(), "da");
    }
}
