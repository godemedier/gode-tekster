//! Renskriv (3/10, lavet om 6/10): en hurtigt skrevet tekst bliver renskrevet, hvor den
//! står. Før lavede den interviewnoter om til en ny fil. Nu er teksten ikke nødvendigvis et
//! interview, renskriften erstatter teksten i dokumentet, og den gamle tekst lægges i fraklip
//! (claudepanel.ts). Stave- og tastefejl, tegnsætning og afsnit rettes, ordlyden og stemmen bliver.
//! Er teksten interviewnoter, beholder renskriften opskriften fra september 2026: kilden i første
//! person, spørgsmålene i kursiv. Utydelige steder får [?n] i teksten og en forklaring i en note
//! til skribenten nederst. Claude svarer i faste felter, og teksten stilles op her.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::claude::{data_block, Progress};

#[derive(Debug, Deserialize)]
pub struct Unclear {
    pub nr: u32,
    /// Det, der stod i teksten.
    pub teksten: String,
    pub bud: String,
}

#[derive(Debug, Deserialize)]
pub struct Cleaned {
    pub tekst: String,
    #[serde(default)]
    pub uklare: Vec<Unclear>,
}

fn prompt(text: &str) -> (String, Value) {
    let prompt = format!(
        "Du renskriver en tekst, der er skrevet hurtigt: noter, et udkast eller et interview. Den \
         har tastefejl, og tegnsætningen halter.\n\
         Regler for renskriften:\n\
         - Ret stave- og tastefejl, tegnsætning (især kommaer), store begyndelsesbogstaver og \
         mellemrum. Skriv forkortelser fra tastningen ud (ift. bliver til i forhold til), men lad \
         almindelige forkortelser stå.\n\
         - Bevar ordlyden, rækkefølgen og skribentens stemme. Omskriv ikke, forkort ikke, og læg \
         intet til. Fjern kun ord, der er tastet to gange.\n\
         - Gør en halv sætning hel med små ord, kun når meningen er sikker.\n\
         - Del teksten i afsnit, hvor emnet skifter. Behold overskrifter og lister, der står i \
         teksten. Lav ikke nye overskrifter.\n\
         - Er teksten noter fra et interview, så skriv kilden i første person uden \
         anførselstegn og journalistens spørgsmål i kursiv (*…*), der hvor de blev stillet. Ændr \
         aldrig, hvad kilden sagde, og læg aldrig ord i munden på kilden.\n\
         - Behold markdown og programmets mærker præcis, som de står: [^1], {{--…--}}, <!-- … -->, \
         links og billeder.\n\
         - Er et sted utydeligt, så skriv dit bedste bud og sæt [?1], [?2] og så videre lige \
         efter. Forklar hvert sted i 'uklare' med tekstens ordlyd og dit bud.\n\
         Felterne:\n\
         - 'tekst': hele den renskrevne tekst i markdown, på tekstens eget sprog.\n\
         - 'uklare': de utydelige steder, tomt hvis der ingen er.\n\
         {}{}",
        // På engelsk: renskriften følger tekstens sprog, forklaringerne programmets (i18n.rs).
        t!("", "Write 'bud' in the same language as the text.\n"),
        data_block(text)
    );
    let schema = json!({
        "type": "object",
        "properties": {
            "tekst": {"type": "string"},
            "uklare": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "nr": {"type": "integer"},
                    "teksten": {"type": "string"},
                    "bud": {"type": "string"}
                },
                "required": ["nr", "teksten", "bud"]
            }}
        },
        "required": ["tekst", "uklare"]
    });
    (prompt, schema)
}

/// Teksten, som den skal stå i dokumentet: renskriften og de uklare steder som en note til
/// skribenten nederst. En pil i en note må ikke lukke noten før tid.
pub fn markdown(c: &Cleaned) -> String {
    let mut out = c.tekst.trim().to_owned();
    if !c.uklare.is_empty() {
        out.push_str(t!("\n\n<!-- Uklare steder:", "\n\n<!-- Unclear passages:"));
        for u in &c.uklare {
            let (nr, text, guess) = (u.nr, u.teksten.trim(), u.bud.trim().trim_end_matches('.'));
            let line = t!(
                format!("\n[?{nr}] Der stod: »{text}«. Bud: {guess}."),
                format!("\n[?{nr}] It said: \u{201C}{text}\u{201D}. Best guess: {guess}.")
            );
            out.push_str(&line.replace("-->", "-- >"));
        }
        out.push_str("\n-->");
    }
    out
}

/// Renskriv teksten. Returnerer renskriften som markdown; fladen sætter den ind i stedet for den
/// gamle tekst og lægger den gamle i fraklip.
#[tauri::command]
pub async fn claude_clean(
    app: AppHandle,
    text: String,
    progress: Channel<Progress>,
) -> Result<String, String> {
    let (prompt, schema) = prompt(&text);
    let _ = progress.send(Progress::Step {
        text: t!("Læser teksten", "Reading the text").to_owned(),
    });
    let v = tauri::async_runtime::spawn_blocking(move || {
        crate::ai::run(
            &app,
            &prompt,
            &schema,
            false,
            Duration::from_secs(420),
            &progress,
        )
    })
    .await
    .map_err(|e| {
        t!(
            format!("Renskrivningen stoppede uventet: {e}"),
            format!("Clean up stopped unexpectedly: {e}")
        )
    })??;
    let cleaned: Cleaned = serde_json::from_value(v).map_err(|_| {
        t!(
            "Svaret havde ikke den aftalte form.",
            "The answer was not in the expected format."
        )
        .to_owned()
    })?;
    if cleaned.tekst.trim().is_empty() {
        return Err(t!(
            "Der kom ingen renskrevet tekst tilbage.",
            "No cleaned-up text came back."
        )
        .to_owned());
    }
    Ok(markdown(&cleaned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renskriften_med_uklare_steder_som_note() {
        let c = Cleaned {
            tekst: "Jeg køber ind [?1] til hele Forsvaret.\n".to_owned(),
            uklare: vec![Unclear {
                nr: 1,
                teksten: "kber ind --> vist".to_owned(),
                bud: "køber ind.".to_owned(),
            }],
        };
        let md = markdown(&c);
        assert!(md.starts_with("Jeg køber ind [?1] til hele Forsvaret.\n\n<!-- Uklare steder:\n"));
        assert!(
            md.contains("[?1] Der stod: »kber ind -- > vist«. Bud: køber ind."),
            "{md}"
        );
        assert!(md.ends_with("\n-->"));
        assert_eq!(md.matches("-->").count(), 1, "kun notens egen afslutning");
    }

    #[test]
    fn uden_uklare_steder_kun_teksten() {
        let c = Cleaned {
            tekst: "  Ren tekst.  \n".to_owned(),
            uklare: Vec::new(),
        };
        assert_eq!(markdown(&c), "Ren tekst.");
    }

    #[test]
    fn prompten_er_ikke_kun_til_interview_og_beholder_maerkerne() {
        let (prompt, schema) = prompt("noter");
        assert!(prompt.contains("noter, et udkast eller et interview"));
        assert!(prompt.contains("{--…--}"), "klammerne i format! er escapet");
        assert!(prompt.contains("Lav ikke nye overskrifter"));
        assert_eq!(schema["required"], json!(["tekst", "uklare"]));
    }

    #[test]
    fn paa_engelsk() {
        crate::i18n::apply("en");
        let c = Cleaned {
            tekst: "I buy things [?1].".to_owned(),
            uklare: vec![Unclear {
                nr: 1,
                teksten: "by thngs".to_owned(),
                bud: "buy things".to_owned(),
            }],
        };
        let md = markdown(&c);
        let (prompt, _) = prompt("notes");
        crate::i18n::apply("da");
        assert!(md.contains("<!-- Unclear passages:\n[?1] It said: \u{201C}by thngs\u{201D}. Best guess: buy things."));
        assert!(prompt.contains("same language as the text"));
    }
}

#[cfg(test)]
mod live {
    /// Skriver prompten og skemaet til filer, så et script kan prøve dem mod Claude:
    /// `GT_CLEAN_DIR=<mappe> cargo test skriv_prompt -- --ignored`. Teksten læses fra <mappe>/noter.md.
    #[test]
    #[ignore]
    fn skriv_prompt() {
        let dir = std::env::var("GT_CLEAN_DIR").unwrap();
        let notes = std::fs::read_to_string(format!("{dir}/noter.md")).unwrap();
        let (prompt, schema) = super::prompt(&notes);
        std::fs::write(format!("{dir}/prompt.txt"), prompt).unwrap();
        std::fs::write(format!("{dir}/schema.json"), schema.to_string()).unwrap();
    }
}
