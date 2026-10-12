//! Kilder (ADR-0049): slå en DOI op og få kildens oplysninger som CSL-JSON, så fladen kan udfylde
//! formularen i fanen Kilder. doi.org sender videre til det register, der ejer DOI'en (Crossref,
//! DataCite, mEDRA), og svarer i CSL-JSON, når der bedes om det. Svaret er data udefra: kun kendte
//! felter med den rigtige type kommer igennem, og tekster afkortes. Intet skrives i en fil, før
//! brugeren har gemt kilden.

use std::time::Duration;

use serde_json::{Map, Value};

/// Højst så mange tegn i et tekstfelt fra registeret.
const MAX_TEXT: usize = 1000;
/// Højst så mange forfattere og redaktører.
const MAX_NAMES: usize = 100;

/// DOI'en uden præfiks (»https://doi.org/«, »doi:«). Kun det, DOI-standarden tillader i praksis.
fn clean_doi(raw: &str) -> Option<String> {
    let mut s = raw.trim();
    for prefix in [
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi.org/",
        "doi:",
        "DOI:",
    ] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.trim();
            break;
        }
    }
    let ok = s.starts_with("10.")
        && s.contains('/')
        && s.len() <= 300
        && !s.chars().any(|c| c.is_whitespace() || c.is_control());
    ok.then(|| s.to_owned())
}

/// Tegn, der må stå urørt i stien. Resten procentkodes (`/` i DOI'en er en del af stien).
fn encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/:;()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn text(v: &Value) -> Option<String> {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        // Crossref giver nogle gange titlen som liste.
        Value::Array(a) => a.first().and_then(|f| f.as_str())?.to_owned(),
        _ => return None,
    };
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    (!s.is_empty()).then(|| s.chars().take(MAX_TEXT).collect())
}

fn names(v: &Value) -> Option<Value> {
    let list: Vec<Value> = v
        .as_array()?
        .iter()
        .take(MAX_NAMES)
        .filter_map(|n| {
            let mut out = Map::new();
            for key in ["family", "given", "literal"] {
                if let Some(t) = n.get(key).and_then(text) {
                    out.insert(key.into(), Value::String(t));
                }
            }
            // Nogle registre giver kun »name« for organisationer.
            if out.is_empty() {
                if let Some(t) = n.get("name").and_then(text) {
                    out.insert("literal".into(), Value::String(t));
                }
            }
            (!out.is_empty()).then_some(Value::Object(out))
        })
        .collect();
    (!list.is_empty()).then_some(Value::Array(list))
}

fn date(v: &Value) -> Option<Value> {
    let parts = v.get("date-parts")?.as_array()?.first()?.as_array()?;
    let nums: Vec<Value> = parts
        .iter()
        .take(3)
        .filter_map(|p| match p {
            Value::Number(n) => n.as_u64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        })
        .filter(|n| *n > 0 && *n < 10_000)
        .map(Value::from)
        .collect();
    (!nums.is_empty()).then(|| serde_json::json!({ "date-parts": [nums] }))
}

/// Kun felterne, fladen kender, med den type, den venter.
pub fn sanitize(raw: &Value) -> Option<Value> {
    let obj = raw.as_object()?;
    let mut out = Map::new();
    let kind = obj
        .get("type")
        .and_then(text)
        .unwrap_or_else(|| "book".into());
    // Crossref kalder en bog »monograph« eller »edited-book« i nogle svar.
    let kind = match kind.as_str() {
        "journal-article" => "article-journal".into(),
        "book-chapter" => "chapter".into(),
        "monograph" | "edited-book" | "reference-book" => "book".into(),
        "proceedings-article" => "paper-conference".into(),
        _ => kind,
    };
    out.insert("type".into(), Value::String(kind));
    for key in [
        "title",
        "container-title",
        "publisher",
        "publisher-place",
        "volume",
        "issue",
        "page",
        "edition",
        "DOI",
        "URL",
    ] {
        if let Some(t) = obj.get(key).and_then(text) {
            out.insert(key.into(), Value::String(t));
        }
    }
    for key in ["author", "editor"] {
        if let Some(n) = obj.get(key).and_then(names) {
            out.insert(key.into(), n);
        }
    }
    let issued = obj
        .get("issued")
        .and_then(date)
        .or_else(|| obj.get("published-print").and_then(date))
        .or_else(|| obj.get("published-online").and_then(date));
    if let Some(d) = issued {
        out.insert("issued".into(), d);
    }
    out.contains_key("title").then_some(Value::Object(out))
}

fn agent() -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .https_only(true)
        .http_status_as_error(false)
        .user_agent(concat!(
            "GodeTekster/",
            env!("CARGO_PKG_VERSION"),
            " (kildeopslag)"
        ))
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into()
}

fn lookup(doi: &str) -> Result<Value, String> {
    let doi = clean_doi(doi).ok_or_else(|| {
        t!(
            "Det ligner ikke en DOI. En DOI begynder med 10., fx 10.1038/nature12373.",
            "That does not look like a DOI. A DOI starts with 10., e.g. 10.1038/nature12373."
        )
        .to_owned()
    })?;
    let url = format!("https://doi.org/{}", encode_path(&doi));
    let mut resp = agent()
        .get(&url)
        .header("Accept", "application/vnd.citationstyles.csl+json")
        .call()
        .map_err(|_| {
            t!(
                "DOI'en kunne ikke slås op. Er computeren på nettet?",
                "The DOI could not be looked up. Is the computer online?"
            )
            .to_owned()
        })?;
    match resp.status().as_u16() {
        200..=299 => {}
        404 => {
            return Err(t!(
                "DOI'en findes ikke i registrene.",
                "The DOI was not found in the registries."
            )
            .to_owned())
        }
        s => {
            return Err(t!(
                format!("DOI'en kunne ikke slås op (fejl {s})."),
                format!("The DOI could not be looked up (error {s}).")
            ))
        }
    }
    let body = resp
        .body_mut()
        .with_config()
        .limit(2 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_str(&body).map_err(|_| {
        t!(
            "Registeret svarede ikke med kildeoplysninger.",
            "The registry did not answer with source details."
        )
        .to_owned()
    })?;
    let mut clean = sanitize(&raw).ok_or_else(|| {
        t!(
            "Registeret kender DOI'en, men ikke dens titel.",
            "The registry knows the DOI but not its title."
        )
        .to_owned()
    })?;
    if let Some(obj) = clean.as_object_mut() {
        obj.insert("DOI".into(), Value::String(doi));
    }
    Ok(clean)
}

#[tauri::command]
pub async fn lookup_doi(doi: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || lookup(&doi))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn doi_prefixes_and_garbage() {
        assert_eq!(
            clean_doi(" https://doi.org/10.1038/nature12373 ").as_deref(),
            Some("10.1038/nature12373")
        );
        assert_eq!(clean_doi("doi:10.1000/xyz").as_deref(), Some("10.1000/xyz"));
        assert_eq!(clean_doi("11.1000/xyz"), None);
        assert_eq!(clean_doi("10.1000"), None);
        assert_eq!(clean_doi("10.1000/a b"), None);
        assert_eq!(encode_path("10.1000/a<b>#?"), "10.1000/a%3Cb%3E%23%3F");
    }

    /// Mod de rigtige registre (Crossref og DataCite). Kræver net: `cargo test -- --ignored doi_`.
    #[test]
    #[ignore]
    fn doi_lookup_against_registries() {
        let crossref = lookup("https://doi.org/10.1038/nature12373").expect("Crossref svarer");
        assert_eq!(crossref["type"], "article-journal");
        assert!(crossref["title"].as_str().is_some_and(|t| !t.is_empty()));
        assert!(crossref["author"].as_array().is_some_and(|a| !a.is_empty()));
        assert_eq!(crossref["DOI"], "10.1038/nature12373");
        let datacite = lookup("10.5061/dryad.8515").expect("DataCite svarer");
        assert!(datacite["title"].as_str().is_some_and(|t| !t.is_empty()));
        assert!(lookup("10.1038/findes-ikke-gt-1234567").is_err());
    }

    #[test]
    fn only_known_fields_survive() {
        let raw = json!({
            "type": "journal-article",
            "title": ["  Klarhed   i forvaltningen "],
            "container-title": "Nordisk Sprogjournal",
            "volume": 14,
            "author": [{"family": "Nielsen", "given": "Mette", "ORCID": "x"}, {"name": "Sprognævnet"}, {"x": 1}],
            "issued": {"date-parts": [[2023, "4", 99999]]},
            "script": "<script>",
            "abstract": "lang tekst"
        });
        let clean = sanitize(&raw).expect("titel findes");
        assert_eq!(
            clean,
            json!({
                "type": "article-journal",
                "title": "Klarhed i forvaltningen",
                "container-title": "Nordisk Sprogjournal",
                "volume": "14",
                "author": [{"family": "Nielsen", "given": "Mette"}, {"literal": "Sprognævnet"}],
                "issued": {"date-parts": [[2023, 4]]}
            })
        );
        assert_eq!(sanitize(&json!({"type": "book"})), None);
        assert_eq!(sanitize(&json!("tekst")), None);
    }
}
