//! Filtransskription gennem den eksisterende Gemini-nøgle. Ingen prompt, værktøjer
//! eller modelswitch: lyden går til Googles ordrette speech-to-text-model.
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};

pub const DEFAULT_MODEL: &str = "gemini-3.5-transcribe";
const MAX_AUDIO: usize = 12 * 1024 * 1024;
const MAX_TEXT: usize = 100_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub text: String,
    pub words: Vec<Word>,
    pub model: String,
}

fn invalid() -> String {
    t!(
        "Gemini gav en transskription med ugyldig tekst eller ugyldige tidskoder. Prøv igen.",
        "Gemini returned invalid transcript text or timestamps. Try again."
    )
    .to_owned()
}

fn invalid_input() -> String {
    t!(
        "Lydprøven skal være en WAV-blok på højst ét minut. Vælg dansk, engelsk eller automatisk sprog.",
        "Audio must be a WAV block of at most one minute. Choose Danish, English, or automatic language."
    ).to_owned()
}

fn request(audio: &[u8], language: &str) -> Result<Value, String> {
    if audio.is_empty() || audio.len() > MAX_AUDIO {
        return Err(invalid_input());
    }
    let languages = match language {
        "auto" => vec![],
        "da" => vec!["da-DK"],
        "en" => vec!["en-US"],
        _ => return Err(invalid_input()),
    };
    Ok(json!({
        "model": DEFAULT_MODEL,
        "input": [{"type":"audio", "data":base64::engine::general_purpose::STANDARD.encode(audio), "mime_type":"audio/wav"}],
        "generation_config": {"transcription_config": {
            "language_codes": languages,
            "mode": {"type":"verbatim", "timestamp_granularities":["word"]}
        }},
        "store": false
    }))
}

fn offset(value: &Value, duration_ms: u64) -> Result<u64, String> {
    let seconds = value
        .as_str()
        .and_then(|s| s.strip_suffix('s'))
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or_else(invalid)?;
    let ms = seconds * 1000.0;
    if ms > duration_ms as f64 + 100.0 {
        return Err(invalid());
    }
    Ok((ms.round() as u64).min(duration_ms))
}

fn parse(value: &Value, duration_ms: u64) -> Result<Transcript, String> {
    if value["status"].as_str() != Some("completed") {
        return Err(invalid());
    }
    let mut result = Transcript {
        text: String::new(),
        words: Vec::new(),
        model: DEFAULT_MODEL.to_owned(),
    };
    let steps = value["steps"]
        .as_array()
        .filter(|s| s.len() <= 100)
        .ok_or_else(invalid)?;
    // Afprøvet mod API'et: ren stilhed giver completed med et eksplicit tomt steps-array.
    if steps.is_empty() {
        return Ok(result);
    }
    let mut output_seen = false;
    for step in steps.iter().filter(|s| s["type"] == "model_output") {
        for part in step["content"]
            .as_array()
            .filter(|s| s.len() <= 100)
            .ok_or_else(invalid)?
        {
            if part["type"] != "text" {
                return Err(invalid());
            }
            let text = part["text"].as_str().ok_or_else(invalid)?;
            output_seen = true;
            let separator = usize::from(!result.text.is_empty());
            if result
                .text
                .len()
                .saturating_add(text.len())
                .saturating_add(separator)
                > MAX_TEXT
            {
                return Err(invalid());
            }
            if !result.text.is_empty() {
                result.text.push('\n');
            }
            result.text.push_str(text);
            let annotations = match part.get("annotations") {
                None if text.trim().is_empty() => continue,
                None => return Err(invalid()),
                Some(v) => v
                    .as_array()
                    .filter(|a| a.len() <= 10_000)
                    .ok_or_else(invalid)?,
            };
            let first_word = result.words.len();
            let mut cursor = 0;
            for annotation in annotations.iter().filter(|a| a["type"] == "word_info") {
                let word = annotation["text"]
                    .as_str()
                    .filter(|t| !t.is_empty() && t.len() <= 1000)
                    .ok_or_else(invalid)?;
                let position = text[cursor..]
                    .find(word)
                    .map(|p| p + cursor)
                    .ok_or_else(invalid)?;
                if text[cursor..position].chars().any(char::is_alphanumeric) {
                    return Err(invalid());
                }
                cursor = position + word.len();
                let start_ms = offset(&annotation["start_offset"], duration_ms)?;
                let end_ms = offset(&annotation["end_offset"], duration_ms)?;
                if start_ms > end_ms
                    || result.words.len() >= 10_000
                    || result.words.last().is_some_and(|w| w.start_ms > start_ms)
                {
                    return Err(invalid());
                }
                let speaker = match annotation.get("speaker") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(
                        v.as_str()
                            .filter(|s| {
                                s.len() <= 32
                                    && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                            })
                            .ok_or_else(invalid)?
                            .to_owned(),
                    ),
                };
                result.words.push(Word {
                    text: word.to_owned(),
                    start_ms,
                    end_ms,
                    speaker,
                });
            }
            if !text.trim().is_empty()
                && (result.words.len() == first_word
                    || text[cursor..].chars().any(char::is_alphanumeric))
            {
                return Err(invalid());
            }
        }
    }
    // Stilhed må give tom tekst. Tale uden tidskoder må ikke foregive præcis placering.
    if !output_seen {
        return Err(invalid());
    }
    Ok(result)
}

/// Skal køres i lydimportens worker efter brugerens start. Bytebufferen er én lokal
/// WAV-blok på højst ét minut. Ingen filsti, nøgle eller råt fejlsvar går til fladen.
pub fn transcribe(audio: &[u8], duration_ms: u64, language: &str) -> Result<Transcript, String> {
    if duration_ms == 0 || duration_ms > 60_000 {
        return Err(invalid_input());
    }
    let body = request(audio, language)?;
    let key = crate::credentials::read("Gode Tekster/Gemini").ok_or_else(|| {
        t!(
            "Gemini mangler din nøgle. Indsæt den under AI-hjælp i indstillingerne.",
            "Gemini needs your key. Add it under AI help in Settings."
        )
        .to_owned()
    })?;
    let mut response = crate::gemini::agent(Duration::from_secs(60))
        .post("https://generativelanguage.googleapis.com/v1beta/interactions")
        .header("x-goog-api-key", &key)
        .content_type("application/json")
        .send(body.to_string())
        .map_err(|_| {
            t!(
                "Gemini kunne ikke nås. Kontrollér forbindelsen og prøv igen.",
                "Gemini could not be reached. Check your connection and try again."
            )
            .to_owned()
        })?;
    match response.status().as_u16() {
        200 => {},
        401 | 403 => return Err(t!("Gemini afviste adgangen. Kontrollér din nøgle og adgang til transskription i Google AI Studio.", "Gemini denied access. Check your key and transcription access in Google AI Studio.").to_owned()),
        429 => return Err(t!("Geminis kvote er brugt op. Vent og prøv igen, eller kontrollér kvoten i Google AI Studio.", "Gemini's quota is exhausted. Wait and try again, or check your quota in Google AI Studio.").to_owned()),
        400 | 404 => return Err(t!("Gemini kan ikke transskribere med denne forbindelse. Kontrollér adgang til Gemini 3.5 Transcribe i Google AI Studio.", "Gemini cannot transcribe with this connection. Check Gemini 3.5 Transcribe access in Google AI Studio.").to_owned()),
        _ => return Err(t!("Gemini kunne ikke transskribere nu. Prøv igen senere.", "Gemini could not transcribe right now. Try again later.").to_owned()),
    }
    let raw = response
        .body_mut()
        .with_config()
        .limit(2 * 1024 * 1024)
        .read_to_string()
        .map_err(|_| invalid())?;
    let value: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
    parse(&value, duration_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reply(text: &str, start: &str, end: &str) -> Value {
        json!({"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":text,"annotations":[{"type":"word_info","text":text,"start_offset":start,"end_offset":end}]}]}]})
    }
    #[test]
    fn afviser_falske_og_omvendte_tidskoder() {
        for (start, end) in [("NaNs", "1s"), ("-1s", "1s"), ("2s", "1s"), ("0s", "11s")] {
            assert!(parse(&reply("Hej", start, end), 10_000).is_err());
        }
        assert!(parse(&json!({"status":"in_progress","steps":[]}), 10_000).is_err());
        let mut missing = reply("Hej", "0s", "1s");
        missing["steps"][0]["content"][0]["annotations"] = json!([]);
        assert!(parse(&missing, 10_000).is_err());
    }
    #[test]
    fn bevarer_ord_og_tidskoder_uden_omskrivning() {
        let mut value = reply("Øh, øh, prøv.", "0.100s", "1.250s");
        value["steps"][0]["content"][0]["annotations"] = json!([
            {"type":"word_info","text":"Øh,","start_offset":"0.100s","end_offset":"0.250s"},
            {"type":"word_info","text":"øh,","start_offset":"0.300s","end_offset":"0.450s"},
            {"type":"word_info","text":"prøv.","start_offset":"0.500s","end_offset":"1.250s"}
        ]);
        let result = parse(&value, 10_000).unwrap();
        assert_eq!(result.text, "Øh, øh, prøv.");
        assert_eq!(result.words[0].start_ms, 100);
        assert_eq!(result.words[2].end_ms, 1250);
        assert!(parse(&json!({"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":""}]}]}),10_000).unwrap().text.is_empty());
    }

    #[test]
    fn tidskoder_daekker_hver_del_og_matcher_ordene() {
        let mut missing = reply("Hej", "0s", "1s");
        missing["steps"][0]["content"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"text","text":"Farvel"}));
        assert!(parse(&missing, 10_000).is_err());
        let mut mismatch = reply("Hej verden", "0s", "1s");
        mismatch["steps"][0]["content"][0]["annotations"][0]["text"] = json!("Farvel");
        assert!(parse(&mismatch, 10_000).is_err());
        mismatch["steps"][0]["content"][0]["annotations"][0]["text"] = json!("Hej");
        assert!(parse(&mismatch, 10_000).is_err());
        mismatch["steps"][0]["content"][0]["annotations"]
            .as_array_mut()
            .unwrap()
            .push(
                json!({"type":"word_info","text":"verden","start_offset":"1s","end_offset":"2s"}),
            );
        let transcript = parse(&mismatch, 10_000).unwrap();
        assert_eq!(transcript.words.len(), 2);
        assert_eq!(transcript.words[1].start_ms, 1000);
        assert!(parse(&json!({"status":"completed","steps":[]}), 10_000)
            .unwrap()
            .text
            .is_empty());
        assert!(parse(&json!({"status":"completed"}), 10_000).is_err());
        assert!(parse(
            &json!({"status":"completed","steps":[{"type":"new_unknown_format"}]}),
            10_000
        )
        .is_err());
    }

    #[test]
    fn tekstloft_medregner_linjeskift_mellem_delene() {
        let text = "x".repeat(MAX_TEXT / 2);
        let part = json!({"type":"text","text":text,"annotations":(0..50).map(|_|json!({"type":"word_info","text":"x".repeat(1000),"start_offset":"0s","end_offset":"1s"})).collect::<Vec<_>>()});
        assert!(parse(&json!({"status":"completed","steps":[{"type":"model_output","content":[part.clone()]}]}),60_000).is_ok());
        let value = json!({"status":"completed","steps":[{"type":"model_output","content":[part.clone(),part]}]});
        assert!(parse(&value, 60_000).is_err());
    }
    #[test]
    fn lyden_er_data_og_smart_er_slaaet_fra() {
        let body = request(b"synthetic", "da").unwrap();
        assert_eq!(
            body["generation_config"]["transcription_config"]["mode"]["type"],
            "verbatim"
        );
        assert_eq!(body["store"], false);
        assert_eq!(body["input"].as_array().unwrap().len(), 1);
        assert!(body.get("tools").is_none());
        assert!(request(b"", "da").is_err());
        assert!(request(b"synthetic", "unknown").is_err());
    }
    #[test]
    #[ignore = "Sender kun en særskilt syntetisk WAV-prøve med den lokalt konfigurerede nøgle"]
    fn lokal_syntetisk_lydproeve() {
        let path = std::env::var("GT_SYNTHETIC_AUDIO")
            .expect("Vælg en syntetisk testfil, aldrig en brugeroptagelse");
        let audio = std::fs::read(path).unwrap();
        let result = transcribe(&audio, 10_000, "da").unwrap();
        assert!(result.text.contains("dansk diktering"));
        assert!(result.text.contains("uden at blive omskrevet"));
        assert!(result.words.len() >= 20);
        println!(
            "PASS: syntetisk dansk tale, {} ord med validerede tidskoder",
            result.words.len()
        );
    }
}
