//! »Ret stavefejl« i fanen Sprog (5/10). Windows' egen stavekontrol (ISpellChecker), den
//! samme som WebView2 bruger til de røde streger, så ordbogen er Windows' danske, og et ord, der
//! tilføjes her, forsvinder også fra stregerne. Ingen ny afhængighed og ingen ordbog i programmet.
//!
//! Positionerne er i UTF-16-enheder ligesom JavaScript-strenge, så fladen kan bruge dem direkte.

use serde::Serialize;

#[derive(Serialize)]
pub struct SpellError {
    pub from: u32,
    pub to: u32,
    pub word: String,
    /// Forslag i Windows' rækkefølge (højst fem). Tom streg = slet (et ord, der står to gange).
    pub suggestions: Vec<String>,
}

#[cfg(windows)]
mod imp {
    use super::SpellError;
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Globalization::{
        GetUserDefaultLocaleName, ISpellChecker, ISpellCheckerFactory, ISpellingError,
        SpellCheckerFactory, CORRECTIVE_ACTION_DELETE, CORRECTIVE_ACTION_GET_SUGGESTIONS,
        CORRECTIVE_ACTION_REPLACE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };

    fn take(p: PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        // SAFETY: Windows har allokeret strengen med CoTaskMemAlloc; den læses og frigives her.
        unsafe {
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as *const _));
            s
        }
    }

    /// Ordbøgerne, der prøves i rækkefølge. På engelsk brugerens eget engelske sprog fra Windows
    /// (»en-AU«), ellers amerikansk og så britisk (i18n.rs, 5/10).
    fn tags() -> Vec<String> {
        if !crate::i18n::english() {
            return vec!["da-DK".to_owned(), "da".to_owned()];
        }
        let mut out = Vec::new();
        let mut buf = [0u16; 85]; // LOCALE_NAME_MAX_LENGTH
                                  // SAFETY: Windows skriver højst bufferens længde, inklusive det afsluttende nul.
        let n = unsafe { GetUserDefaultLocaleName(&mut buf) };
        if n > 1 {
            let name = String::from_utf16_lossy(&buf[..n as usize - 1]);
            if name.to_ascii_lowercase().starts_with("en-") {
                out.push(name);
            }
        }
        for tag in ["en-US", "en-GB"] {
            if !out.iter().any(|o| o.eq_ignore_ascii_case(tag)) {
                out.push(tag.to_owned());
            }
        }
        out
    }

    fn checker() -> Result<ISpellChecker, String> {
        let failed = || {
            t!(
                "Windows' stavekontrol kunne ikke startes.",
                "Windows spell check could not be started."
            )
            .to_owned()
        };
        // SAFETY: COM initialiseres på denne tråd (et andet tilstandsvalg er allerede i orden),
        // og fabrikken oprettes efter Windows' dokumentation.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let factory: ISpellCheckerFactory =
                CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER)
                    .map_err(|_| failed())?;
            for tag in tags() {
                let tag = HSTRING::from(tag);
                if factory
                    .IsSupported(&tag)
                    .map(|b| b.as_bool())
                    .unwrap_or(false)
                {
                    return factory.CreateSpellChecker(&tag).map_err(|_| failed());
                }
            }
            Err(t!(
                "Windows har ikke dansk stavekontrol installeret. Tilføj dansk under Indstillinger, Tid og sprog, Sprog.",
                "Windows does not have English spell check installed. Add English under Settings, Time & language, Language & region."
            )
            .to_owned())
        }
    }

    fn suggestions(c: &ISpellChecker, word: &str) -> Vec<String> {
        let mut out = Vec::new();
        // SAFETY: enumeratoren læses, til den er tom; hver streng frigives i `take`.
        unsafe {
            let Ok(list) = c.Suggest(&HSTRING::from(word)) else {
                return out;
            };
            loop {
                let mut one = [PWSTR::null()];
                let mut got = 0u32;
                if list.Next(&mut one, Some(&mut got)).is_err() || got == 0 {
                    break;
                }
                out.push(take(one[0]));
                if out.len() >= 5 {
                    break;
                }
            }
        }
        out
    }

    pub fn check(text: &str) -> Result<Vec<SpellError>, String> {
        let c = checker()?;
        let units: Vec<u16> = text.encode_utf16().collect();
        let mut out = Vec::new();
        // SAFETY: Check returnerer en enumerator over fejl; hver læses, til den er tom.
        unsafe {
            let errors = c.Check(&HSTRING::from(text)).map_err(|_| {
                t!(
                    "Stavekontrollen kunne ikke læse teksten.",
                    "Spell check could not read the text."
                )
                .to_owned()
            })?;
            loop {
                let mut e: Option<ISpellingError> = None;
                if errors.Next(&mut e).is_err() {
                    break;
                }
                let Some(e) = e else { break };
                let (Ok(from), Ok(len)) = (e.StartIndex(), e.Length()) else {
                    continue;
                };
                let to = (from + len).min(units.len() as u32);
                let word = String::from_utf16_lossy(&units[from as usize..to as usize]);
                let action = e.CorrectiveAction().unwrap_or_default();
                let suggestions = if action == CORRECTIVE_ACTION_REPLACE {
                    vec![e.Replacement().map(take).unwrap_or_default()]
                } else if action == CORRECTIVE_ACTION_DELETE {
                    vec![String::new()]
                } else if action == CORRECTIVE_ACTION_GET_SUGGESTIONS {
                    suggestions(&c, &word)
                } else {
                    Vec::new()
                };
                out.push(SpellError {
                    from,
                    to,
                    word,
                    suggestions,
                });
            }
        }
        Ok(out)
    }

    pub fn add(word: &str) -> Result<(), String> {
        let c = checker()?;
        // SAFETY: et rent kald; ordet kopieres af Windows.
        unsafe { c.Add(&HSTRING::from(word)) }.map_err(|_| {
            t!(
                "Ordet kunne ikke føjes til ordbogen.",
                "The word could not be added to the dictionary."
            )
            .to_owned()
        })
    }
}

#[cfg(not(windows))]
mod imp {
    use super::SpellError;
    pub fn check(_text: &str) -> Result<Vec<SpellError>, String> {
        Err(t!("Kun på Windows.", "Windows only.").to_owned())
    }
    pub fn add(_word: &str) -> Result<(), String> {
        Err(t!("Kun på Windows.", "Windows only.").to_owned())
    }
}

/// Stavefejlene i teksten (fladen har blanket markdown-tegn og skjulte blokke ud først).
#[tauri::command]
pub async fn spell_check(text: String) -> Result<Vec<SpellError>, String> {
    tauri::async_runtime::spawn_blocking(move || imp::check(&text))
        .await
        .map_err(|e| e.to_string())?
}

/// »Tilføj til ordbog«: Windows' egen brugerordbog, så stregen også forsvinder i teksten.
#[tauri::command]
pub async fn spell_add(word: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || imp::add(word.trim()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Kræver dansk stavekontrol i Windows. Springes over, hvis den mangler.
    #[test]
    fn finder_stavefejl_med_forslag() {
        let Ok(errors) = imp::check("Dette er en tekts med stavefjel.") else {
            return;
        };
        let words: Vec<&str> = errors.iter().map(|e| e.word.as_str()).collect();
        assert!(words.contains(&"tekts"), "{words:?}");
        assert!(words.contains(&"stavefjel"), "{words:?}");
        assert!(!words.contains(&"Dette"));
        let tekts = errors.iter().find(|e| e.word == "tekts").unwrap();
        assert_eq!((tekts.from, tekts.to), (12, 17));
    }
}
