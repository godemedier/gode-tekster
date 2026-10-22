//! Mistral via Mistrals API med brugerens egen nøgle fra Mistral AI Studio (6/10). Bygget som
//! gemini.rs: nøglen ligger i Windows' legitimationsadministrator under »Gode Tekster/Mistral«
//! (credentials.rs) og forlader aldrig Rust. Mistral er europæisk og har en gratis plan.
//!
//! Svaret bedes om som JSON efter skemaet (`response_format` med `json_schema`). Websøgning findes kun
//! i Mistrals agent-API og er ikke med her, så faktatjek og research kan ikke køre på Mistral.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::claude::Progress;

const TARGET: &str = "Gode Tekster/Mistral";
const URL: &str = "https://api.mistral.ai/v1/chat/completions";
/// Den store model først. Ved kvote (429) eller overbelastning (503) tager den lille over.
const MODELS: [&str; 2] = ["mistral-medium-latest", "mistral-small-latest"];

fn no_search() -> String {
    t!(
        "Faktatjek og research kræver websøgning, og den har Mistral-forbindelsen ikke. Skær, Renskriv og kommandoerne virker. Vælg Claude eller ChatGPT under Indstillinger til faktatjek.",
        "Fact-check and Research need web search, which the Mistral connection does not have. Trim, Clean up and the commands work. Choose Claude or ChatGPT in Settings for fact-checking."
    )
    .to_owned()
}

pub fn has_key() -> bool {
    crate::credentials::read(TARGET).is_some()
}

/// Forespørgslen: én besked, lav temperatur og svaret som JSON efter skemaet, når der er et.
pub fn request(model: &str, prompt: &str, schema: Option<&Value>) -> Value {
    let mut body = json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2
    });
    if let Some(s) = schema {
        body["response_format"] = json!({
            "type": "json_schema",
            "json_schema": {"name": "svar", "schema": s, "strict": false}
        });
    }
    body
}

fn post(
    key: &str,
    prompt: &str,
    schema: Option<&Value>,
    timeout: Duration,
) -> Result<(u16, Value), String> {
    let mut last = (0, Value::Null);
    for model in MODELS {
        let mut resp = crate::gemini::agent(timeout)
            .post(URL)
            .header("Authorization", &format!("Bearer {key}"))
            .content_type("application/json")
            .send(request(model, prompt, schema).to_string())
            .map_err(|e| {
                t!(
                    format!("Mistral kunne ikke nås: {e}"),
                    format!("Mistral could not be reached: {e}")
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
        if status != 429 && status != 503 {
            return Ok((status, v));
        }
        last = (status, v);
    }
    Ok(last)
}

/// Teksten i svaret. Indholdet er normalt en streng, men kan komme som en liste af dele.
fn answer_text(v: &Value) -> String {
    let content = &v["choices"][0]["message"]["content"];
    if let Some(s) = content.as_str() {
        return s.to_owned();
    }
    content
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
    let msg = v["message"]
        .as_str()
        .or_else(|| v["error"]["message"].as_str())
        .or_else(|| v["detail"].as_str())
        .unwrap_or("")
        .chars()
        .take(200)
        .collect::<String>();
    match status {
        401 | 403 => t!(
            "Mistral afviste nøglen. Hent en ny i Mistral AI Studio.",
            "Mistral rejected the key. Get a new one in Mistral AI Studio."
        )
        .to_owned(),
        429 => t!(
            "Mistral-kvoten er brugt for nu. Prøv igen om lidt.",
            "The Mistral quota is used up for now. Try again in a moment."
        )
        .to_owned(),
        503 => t!(
            "Mistral er overbelastet lige nu. Prøv igen om lidt.",
            "Mistral is overloaded right now. Try again in a moment."
        )
        .to_owned(),
        _ => t!(
            format!("Mistral svarede med en fejl ({status}): {msg}"),
            format!("Mistral answered with an error ({status}): {msg}")
        ),
    }
}

pub fn run(
    app: &tauri::AppHandle,
    prompt: &str,
    schema: &Value,
    web: bool,
    timeout: Duration,
    progress: &Channel<Progress>,
) -> Result<Value, String> {
    if web {
        return Err(no_search());
    }
    let key = crate::credentials::read(TARGET).ok_or(t!(
        "Mistral mangler din nøgle. Indsæt den under Indstillinger.",
        "Mistral needs your key. Paste it in Settings."
    ))?;
    let _ = progress.send(Progress::Step {
        text: t!(
            "Venter på svar fra Mistral",
            "Waiting for an answer from Mistral"
        )
        .to_owned(),
    });
    let (status, v) = post(&key, prompt, Some(schema), timeout)?;
    if !(200..300).contains(&status) {
        // Mistrals egen fejltekst i loggen (aldrig nøglen), så en kvote- eller modelfejl kan læses.
        crate::applog::write(
            app,
            &format!("mistral {status}: {}", error_text(status, &v)),
        );
        return Err(error_text(status, &v));
    }
    crate::ai::parse_json(&answer_text(&v))
}

/// »Gem nøgle«: prøv den med en lille forespørgsel, og gem den kun, hvis Mistral tager imod den.
#[tauri::command]
pub async fn mistral_set_key(key: String) -> Result<(), String> {
    let key = key.trim().to_owned();
    if key.len() < 20 || key.contains(char::is_whitespace) {
        return Err(t!(
            "Det ligner ikke en nøgle fra Mistral AI Studio.",
            "That does not look like a key from Mistral AI Studio."
        )
        .to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (status, v) = post(&key, "Svar med ordet ja.", None, Duration::from_secs(30))?;
        if !(200..300).contains(&status) {
            return Err(error_text(status, &v));
        }
        crate::credentials::write(TARGET, "Mistral API", &key)?;
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
pub fn mistral_clear_key() {
    crate::credentials::delete(TARGET);
    crate::ai::statuses(true);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forespoergslen_har_skemaet_som_json_schema() {
        let schema = json!({"type": "object"});
        let r = request("mistral-small-latest", "Hej", Some(&schema));
        assert_eq!(r["model"], "mistral-small-latest");
        assert_eq!(r["messages"][0]["content"], "Hej");
        assert_eq!(r["response_format"]["type"], "json_schema");
        assert_eq!(
            r["response_format"]["json_schema"]["schema"]["type"],
            "object"
        );
        assert!(request("m", "Hej", None).get("response_format").is_none());
    }

    #[test]
    fn svarteksten_som_streng_eller_dele() {
        let v = json!({"choices": [{"message": {"content": "{\"a\":1}"}}]});
        assert_eq!(answer_text(&v), "{\"a\":1}");
        let parts = json!({"choices": [{"message": {"content": [{"type": "text", "text": "{\"a\":"}, {"type": "text", "text": "2}"}]}}]});
        assert_eq!(answer_text(&parts), "{\"a\":2}");
    }

    #[test]
    fn websoegning_afvises_med_en_forklaring() {
        assert!(no_search().contains("websøgning"));
    }
}
