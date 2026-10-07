//! Gemini via Gemini API med brugerens egen, gratis nøgle fra Google AI Studio (delbar udgave 3/10,
//! fase 3). Gemini CLI tager ikke længere forbrugerkonti (juni 2026), men API'et har en gratis kvote,
//! og for brugere i EØS gælder betalingsvilkårene for data også på den (Googles vilkår 28/4 2026).
//!
//! Nøglen ligger i Windows' legitimationsadministrator under »Gode Tekster/Gemini« (credentials.rs)
//! og forlader aldrig Rust: fladen kan gemme og slette den, ikke læse den. Svaret bedes om som JSON efter skemaet; med
//! websøgning (Google Search) prøves skemaet først, og afviser API'et kombinationen, bedes der om
//! JSON i prompten i stedet.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::claude::Progress;

const TARGET: &str = "Gode Tekster/Gemini";
/// Googles aliaser for nyeste Flash og Flash-Lite. Målt med en gratis nøgle 4/10: alle modeller svarede
/// uden websøgning, men `gemini-flash-latest` var overbelastet (503), så Lite tager over ved 503 og 429.
/// `gemini-2.5-flash` er lukket for nye brugere (404). Med websøgning (Google Search) svarede alle
/// modeller 429 »exceeded your current quota«: den gratis kvote har ingen websøgning.
const MODELS: [&str; 2] = ["gemini-flash-latest", "gemini-flash-lite-latest"];

/// Når Google afviser websøgning, er det ikke en midlertidig kvote: faktatjek og research kan ikke
/// køre med den nøgle. Sig det, og sig hvad der virker.
fn no_search() -> String {
    t!(
        "Faktatjek og research kræver websøgning, og den er ikke med i Googles gratis kvote for din nøgle. Skær og Renskriv virker. Vælg Claude eller ChatGPT under Indstillinger, eller slå betaling til i Google AI Studio.",
        "Fact-check and Research need web search, and Google's free tier does not include it for your key. Trim and Clean up work. Choose Claude or ChatGPT in Settings, or turn on billing in Google AI Studio."
    )
    .to_owned()
}

fn read_key() -> Option<String> {
    crate::credentials::read(TARGET)
}

pub fn has_key() -> bool {
    read_key().is_some()
}

/// HTTPS med Windows' egne certifikater. Bruges også af mistral.rs.
pub(crate) fn agent(timeout: Duration) -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into()
}

fn post(key: &str, body: &Value, timeout: Duration) -> Result<(u16, Value), String> {
    let mut last = (0, Value::Null);
    for model in MODELS {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        );
        let mut resp = agent(timeout)
            .post(&url)
            .header("x-goog-api-key", key)
            .content_type("application/json")
            .send(body.to_string())
            .map_err(|e| {
                t!(
                    format!("Gemini kunne ikke nås: {e}"),
                    format!("Gemini could not be reached: {e}")
                )
            })?;
        let status = resp.status().as_u16();
        let text = resp
            .body_mut()
            .with_config()
            .limit(10 * 1024 * 1024)
            .read_to_string()
            .unwrap_or_default();
        let v = serde_json::from_str(&text).unwrap_or(Value::Null);
        // Kvote eller overbelastning: prøv næste model.
        if status != 429 && status != 503 {
            return Ok((status, v));
        }
        last = (status, v);
    }
    Ok(last)
}

/// Teksten i svaret (alle dele af første kandidat).
fn answer_text(v: &Value) -> String {
    v["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn error_text(status: u16, v: &Value) -> String {
    let msg = v["error"]["message"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(200)
        .collect::<String>();
    match status {
        400 if msg.contains("API key") => t!(
            "Gemini afviste nøglen. Hent en ny i Google AI Studio.",
            "Gemini rejected the key. Get a new one in Google AI Studio."
        )
        .to_owned(),
        401 | 403 => t!(
            "Gemini afviste nøglen. Hent en ny i Google AI Studio.",
            "Gemini rejected the key. Get a new one in Google AI Studio."
        )
        .to_owned(),
        429 => t!(
            "Gemini-kvoten er brugt for nu. Prøv igen senere.",
            "The Gemini quota is used up for now. Try again later."
        )
        .to_owned(),
        503 => t!(
            "Gemini er overbelastet lige nu. Prøv igen om lidt.",
            "Gemini is overloaded right now. Try again in a moment."
        )
        .to_owned(),
        _ => t!(
            format!("Gemini svarede med en fejl ({status}): {msg}"),
            format!("Gemini answered with an error ({status}): {msg}")
        ),
    }
}

/// Byg forespørgslen: med skema, og med Google Search, når opgaven kræver websøgning.
pub fn request(prompt: &str, schema: Option<&Value>, web: bool) -> Value {
    let mut body = json!({
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2}
    });
    if let Some(s) = schema {
        body["generationConfig"]["responseMimeType"] = json!("application/json");
        body["generationConfig"]["responseJsonSchema"] = s.clone();
    }
    if web {
        body["tools"] = json!([{"google_search": {}}]);
    }
    body
}

pub fn run(
    app: &tauri::AppHandle,
    prompt: &str,
    schema: &Value,
    web: bool,
    timeout: Duration,
    progress: &Channel<Progress>,
) -> Result<Value, String> {
    let key = read_key().ok_or(t!(
        "Gemini-hjælpen mangler din nøgle. Indsæt den under Indstillinger.",
        "Gemini needs your key. Paste it in Settings."
    ))?;
    let _ = progress.send(Progress::Step {
        text: if web {
            t!("Gemini søger og læser", "Gemini is searching and reading")
        } else {
            t!(
                "Venter på svar fra Gemini",
                "Waiting for an answer from Gemini"
            )
        }
        .to_owned(),
    });
    let (status, v) = post(&key, &request(prompt, Some(schema), web), timeout)?;
    // Googles egen fejltekst i loggen (aldrig nøglen), så en kvote- eller modelfejl kan læses (4/10).
    let log = |s: u16, v: &Value| {
        if !(200..300).contains(&s) {
            let m = v["error"]["message"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(500)
                .collect::<String>();
            crate::applog::write(app, &format!("gemini {s}: {m}"));
        }
    };
    log(status, &v);
    let v = if status == 400 && web {
        // Skema og websøgning sammen afvises af nogle modeller: bed om JSON i prompten i stedet.
        let p = format!("{prompt}\n\nSvar KUN med JSON, der passer til dette skema, uden anden tekst:\n{schema}");
        let (s2, v2) = post(&key, &request(&p, None, true), timeout)?;
        log(s2, &v2);
        if s2 == 429 {
            return Err(no_search());
        }
        if !(200..300).contains(&s2) {
            return Err(error_text(s2, &v2));
        }
        v2
    } else if status == 429 && web {
        return Err(no_search());
    } else if !(200..300).contains(&status) {
        return Err(error_text(status, &v));
    } else {
        v
    };
    crate::ai::parse_json(&answer_text(&v))
}

/// »Gem nøgle«: prøv den med en lille forespørgsel, og gem den kun, hvis Google tager imod den.
#[tauri::command]
pub async fn gemini_set_key(key: String) -> Result<(), String> {
    let key = key.trim().to_owned();
    if key.len() < 20 || key.contains(char::is_whitespace) {
        return Err(t!(
            "Det ligner ikke en nøgle fra Google AI Studio.",
            "That does not look like a key from Google AI Studio."
        )
        .to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (status, v) = post(
            &key,
            &request("Svar med ordet ja.", None, false),
            Duration::from_secs(30),
        )?;
        if !(200..300).contains(&status) {
            return Err(error_text(status, &v));
        }
        crate::credentials::write(TARGET, "Gemini API", &key)?;
        crate::ai::statuses(true);
        Ok(())
    })
    .await
    .map_err(|e| {
        t!(
            format!("Nøglen kunne ikke prøves: {e}"),
            format!("The key could not be tested: {e}")
        )
    })?
}

#[tauri::command]
pub fn gemini_clear_key() {
    crate::credentials::delete(TARGET);
    crate::ai::statuses(true);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forespoergslen_har_skema_og_soegning() {
        let schema = json!({"type": "object"});
        let r = request("Hej", Some(&schema), true);
        assert_eq!(
            r["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert_eq!(
            r["generationConfig"]["responseJsonSchema"]["type"],
            "object"
        );
        assert!(r["tools"][0].get("google_search").is_some());
        let plain = request("Hej", None, false);
        assert!(plain.get("tools").is_none());
        assert!(plain["generationConfig"]
            .get("responseJsonSchema")
            .is_none());
    }

    #[test]
    fn svarteksten_samles() {
        let v =
            json!({"candidates": [{"content": {"parts": [{"text": "{\"a\":"}, {"text": "1}"}]}}]});
        assert_eq!(answer_text(&v), "{\"a\":1}");
    }
}
