//! ChatGPT-lydintegration via OpenAIs Codex app-server og WebRTC v3.
//! Håndterer datakanalens `input_transcript.added`-hændelser, kompenserer for
//! readiness-forsinkelsen før afspilning og sikrer, at delvise `transcript/done`
//! ikke smider tekst væk.

use serde::{Deserialize, Serialize};

pub const DEFAULT_MODEL: &str = "chatgpt-realtime";
pub const READINESS_DELAY_MS: u64 = 1500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputTranscriptEvent {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    #[serde(default)]
    pub speaker: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CodexTranscriptCollector {
    readiness_delay_ms: u64,
    events: Vec<InputTranscriptEvent>,
    done_texts: Vec<String>,
}

impl CodexTranscriptCollector {
    pub fn new(readiness_delay_ms: u64) -> Self {
        Self {
            readiness_delay_ms,
            events: Vec::new(),
            done_texts: Vec::new(),
        }
    }

    /// Tilføjer en input-transskription fra datakanalen (`input_transcript.added`).
    /// Tidskoden forskydes med readiness-forsinkelsen, så den matcher originalfilens tidslinje.
    pub fn add_input_transcript(&mut self, start_ms: u64, end_ms: u64, text: String) {
        self.add_input_transcript_with_speaker(start_ms, end_ms, text, None);
    }

    /// Tilføjer en input-transskription med eventuel talerangivelse.
    pub fn add_input_transcript_with_speaker(
        &mut self,
        start_ms: u64,
        end_ms: u64,
        text: String,
        speaker: Option<String>,
    ) {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return;
        }
        let adjusted_start = start_ms.saturating_sub(self.readiness_delay_ms);
        let adjusted_end = end_ms.saturating_sub(self.readiness_delay_ms);
        self.events.push(InputTranscriptEvent {
            start_ms: adjusted_start,
            end_ms: adjusted_end,
            text: trimmed.to_owned(),
            speaker,
        });
    }

    /// Registrerer en app-server `thread/realtime/transcript/done`-besked til log/krydstjek.
    /// Erstatter ALDRIG `input_transcript.added`, da done-beskeder kan mangle ord.
    pub fn add_done_transcript(&mut self, text: String) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            self.done_texts.push(trimmed.to_owned());
        }
    }

    pub fn events(&self) -> &[InputTranscriptEvent] {
        &self.events
    }

    pub fn words_count(&self) -> usize {
        self.events
            .iter()
            .map(|e| e.text.split_whitespace().count())
            .sum()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// Parser en JSON-besked fra datakanalen (`oai-events`).
    /// Returnerer `Ok(true)` hvis beskeden var en `input_transcript.added`-hændelse.
    pub fn parse_data_channel_message(&mut self, json_str: &str) -> Result<bool, String> {
        let val: serde_json::Value =
            serde_json::from_str(json_str).map_err(|e| format!("Ugyldig JSON: {e}"))?;
        let event_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if event_type == "input_transcript.added" {
            let start = val.get("start_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            let end = val.get("end_ms").and_then(|v| v.as_u64()).unwrap_or(start);
            let speaker = val
                .get("speaker")
                .and_then(|s| s.as_str())
                .or_else(|| {
                    val.get("item")
                        .and_then(|i| i.get("speaker"))
                        .and_then(|s| s.as_str())
                })
                .map(|s| s.to_owned());
            let text = val
                .get("item")
                .and_then(|i| i.get("text"))
                .and_then(|t| t.as_str())
                .or_else(|| val.get("text").and_then(|t| t.as_str()))
                .unwrap_or("");
            if !text.is_empty() {
                self.add_input_transcript_with_speaker(start, end, text.to_owned(), speaker);
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Genererer færdig Markdown med klikbare tidskoder og metadataheader.
    pub fn to_markdown(&self, audio_name: &str, duration_ms: u64, complete: bool) -> String {
        let mut out = String::new();
        let meta = serde_json::json!({
            "version": 1,
            "audio": audio_name,
            "duration": duration_ms,
            "provider": "codex",
            "model": DEFAULT_MODEL,
            "complete": complete,
            "timing": "segments"
        })
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");

        out.push_str(&format!("<!-- gt:lyd {meta} -->\n# Transskription\n\n"));

        // Gruppér events efter pauser, talerskift eller højst 20 sekunder
        let mut current_block: Vec<&InputTranscriptEvent> = Vec::new();
        let flush = |block: &mut Vec<&InputTranscriptEvent>, out: &mut String| {
            if let Some(first) = block.first() {
                let ms = first.start_ms;
                let sec = ms / 1000;
                let time_str = format!("{:02}:{:02}:{:02}", sec / 3600, sec / 60 % 60, sec % 60);
                let safe_link = audio_name
                    .bytes()
                    .map(|b| {
                        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                            (b as char).to_string()
                        } else {
                            format!("%{b:02X}")
                        }
                    })
                    .collect::<String>();
                out.push_str(&format!(
                    "[{time_str}]({safe_link}#t={:.3})",
                    ms as f64 / 1000.0
                ));
                if let Some(speaker) = &first.speaker {
                    out.push_str(&format!(" **{speaker}**"));
                }
                out.push_str("\n\n");
                let text = block
                    .iter()
                    .map(|e| e.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                out.push_str(&text);
                out.push_str("\n\n");
            }
            block.clear();
        };

        for ev in &self.events {
            if let Some(last) = current_block.last() {
                if ev.start_ms.saturating_sub(last.end_ms) > 1500
                    || ev.end_ms.saturating_sub(current_block[0].start_ms) > 20000
                    || ev.speaker != current_block[0].speaker
                {
                    flush(&mut current_block, &mut out);
                }
            }
            current_block.push(ev);
        }
        flush(&mut current_block, &mut out);

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_delay_offsets_timestamps() {
        let mut collector = CodexTranscriptCollector::new(1500);
        collector.add_input_transcript(1500, 2500, "Første sætning.".to_owned());
        collector.add_input_transcript(3000, 4500, "Anden sætning.".to_owned());

        let events = collector.events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].start_ms, 0);
        assert_eq!(events[0].end_ms, 1000);
        assert_eq!(events[1].start_ms, 1500);
        assert_eq!(events[1].end_ms, 3000);
    }

    #[test]
    fn parse_data_channel_message_handles_input_transcript() {
        let mut collector = CodexTranscriptCollector::new(1500);
        let json = r#"{"type":"input_transcript.added","start_ms":2000,"end_ms":3000,"item":{"text":"Hej verden"}}"#;
        assert!(collector.parse_data_channel_message(json).unwrap());
        assert_eq!(collector.events().len(), 1);
        assert_eq!(collector.events()[0].start_ms, 500);
        assert_eq!(collector.events()[0].text, "Hej verden");
    }

    #[test]
    fn input_transcript_preserves_words_over_done() {
        let mut collector = CodexTranscriptCollector::new(0);
        collector.add_input_transcript(0, 1000, "Ordrig sætning med mange detaljer".to_owned());
        collector.add_done_transcript("Ordrig sætning".to_owned());

        // words_count kommer fra input_transcript, ikke den afkortede done
        assert_eq!(collector.words_count(), 5);
        assert_eq!(collector.events().len(), 1);
    }

    #[test]
    fn to_markdown_generates_valid_headers_and_time_links() {
        let mut collector = CodexTranscriptCollector::new(1000);
        collector.add_input_transcript(2000, 3000, "Tale i starten.".to_owned());
        let md = collector.to_markdown("optagelse.wav", 10000, true);

        assert!(md.contains("<!-- gt:lyd"));
        assert!(md.contains("\"provider\":\"codex\""));
        assert!(md.contains("[00:00:01](optagelse.wav#t=1.000)"));
        assert!(md.contains("Tale i starten."));
    }

    #[test]
    fn multi_speaker_splits_paragraphs_and_marks_speaker() {
        let mut collector = CodexTranscriptCollector::new(0);
        collector.add_input_transcript_with_speaker(
            0,
            2000,
            "Hej fra person et.".to_owned(),
            Some("Taler 1".to_owned()),
        );
        collector.add_input_transcript_with_speaker(
            2200,
            4000,
            "Goddag fra person to.".to_owned(),
            Some("Taler 2".to_owned()),
        );
        let md = collector.to_markdown("samtale.wav", 10000, true);
        assert!(md.contains("**Taler 1**"));
        assert!(md.contains("**Taler 2**"));
        assert!(md.contains("Hej fra person et."));
        assert!(md.contains("Goddag fra person to."));
    }
}
