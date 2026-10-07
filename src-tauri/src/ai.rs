//! AI-hjælpen med brugerens egen sprogmodel (delbar udgave 3/10, plan fase 3). Skær, faktatjek,
//! research og renskriv sender samme opgave og samme JSON-skema hertil, og laget her vælger
//! udbyderen fra indstillingen »AI-hjælp«:
//!
//! - **Claude** via brugerens eget Claude-program og Pro/Max-abonnement (claude.rs). Anthropics
//!   vilkår: brugeren logger selv ind i det uændrede program, og ingen funktion må hedde »Claude Code«.
//! - **ChatGPT** via OpenAIs Codex-program og brugerens ChatGPT-abonnement (codex.rs).
//! - **Gemini** via Gemini API med brugerens egen, gratis nøgle i Windows' legitimationsadministrator
//!   (gemini.rs). Gemini CLI tager ikke længere forbrugerkonti (juni 2026).
//! - **Mistral** via Mistrals API med brugerens egen nøgle, gemt som Geminis (mistral.rs, 6/10).
//!
//! Svaret valideres af den, der kalder (samme skema for alle). Gode Medier ser hverken tekst eller nøgler.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::claude::Progress;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
    Gemini,
    Mistral,
}

impl Provider {
    pub const ALL: [Provider; 4] = [
        Provider::Claude,
        Provider::Codex,
        Provider::Gemini,
        Provider::Mistral,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "ChatGPT",
            Provider::Gemini => "Gemini",
            Provider::Mistral => "Mistral",
        }
    }

    fn parse(s: &str) -> Option<Provider> {
        Provider::ALL
            .into_iter()
            .find(|p| format!("{p:?}").eq_ignore_ascii_case(s))
    }
}

#[derive(Clone, Serialize)]
pub struct Status {
    pub id: Provider,
    pub name: &'static str,
    /// Klar til brug: installeret og logget ind, eller nøglen er gemt.
    pub ready: bool,
    /// Til indstillingerne: hvad der mangler, eller hvad der bruges.
    pub detail: String,
    /// Har den websøgning til faktatjek og research?
    pub web: bool,
}

/// Et kort kald til et program (login-tjek). Uden konsolvindue, med loft på tiden. Svaret, hvis
/// programmet lykkedes.
pub fn quick_output(cmd: &mut Command, timeout: Duration) -> Option<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
}

fn status_of(p: Provider) -> Status {
    let (ready, detail) = match p {
        Provider::Claude => match crate::claude::claude_exe() {
            Err(_) => (false, t!("Ikke fundet. Kræver Claude-programmet og et Claude Pro- eller Max-abonnement.", "Not found. Needs the Claude app and a Claude Pro or Max subscription.").to_owned()),
            Ok(_) if crate::claude::claude_logged_in() => (true, t!("Klar, via dit eget Claude-abonnement.", "Ready, using your own Claude subscription.").to_owned()),
            Ok(_) => (false, t!("Fundet, men ikke logget ind på et Pro- eller Max-abonnement. Log ind i Claude-programmet.", "Found, but not signed in to a Pro or Max subscription. Sign in to the Claude app.").to_owned()),
        },
        Provider::Codex => match crate::codex::codex_exe() {
            Err(_) => (false, t!("Ikke fundet. Kræver OpenAIs Codex-program og et ChatGPT-abonnement.", "Not found. Needs OpenAI's Codex app and a ChatGPT subscription.").to_owned()),
            Ok(_) if crate::codex::logged_in() => (true, t!("Klar, via dit eget ChatGPT-abonnement.", "Ready, using your own ChatGPT subscription.").to_owned()),
            Ok(_) => (false, t!("Fundet, men ikke logget ind. Kør »codex login« og vælg »Sign in with ChatGPT«.", "Found, but not signed in. Run \"codex login\" and choose \"Sign in with ChatGPT\".").to_owned()),
        },
        Provider::Gemini => {
            if crate::gemini::has_key() {
                (true, t!("Klar, med din egen nøgle fra Google AI Studio. Faktatjek og research kræver websøgning: den virker, når betaling er slået til for nøglen, men ikke med den gratis kvote.", "Ready, with your own key from Google AI Studio. Fact-check and Research need web search: it works when billing is turned on for the key, but not on the free tier.").to_owned())
            } else {
                (false, t!("Indsæt en gratis nøgle fra Google AI Studio.", "Paste a free key from Google AI Studio.").to_owned())
            }
        }
        Provider::Mistral => {
            if crate::mistral::has_key() {
                (true, t!("Klar til Skær, Renskriv og kommandoerne, med din egen nøgle fra Mistral. Faktatjek og research kræver websøgning, som forbindelsen ikke har.", "Ready for Trim, Clean up and the commands, with your own key from Mistral. Fact-check and Research need web search, which the connection does not have.").to_owned())
            } else {
                (false, t!("Indsæt en nøgle fra Mistral AI Studio. Der er en gratis plan.", "Paste a key from Mistral AI Studio. There is a free plan.").to_owned())
            }
        }
    };
    Status {
        id: p,
        name: p.name(),
        ready,
        detail,
        web: true,
    }
}

/// Login-tjek tager sekunder (Claude cirka 5 s), så svaret gemmes et minut. Sproget gemmes med,
/// fordi `detail` er tekst til fladen.
static CACHE: Mutex<Option<(Instant, bool, Vec<Status>)>> = Mutex::new(None);

pub fn statuses(refresh: bool) -> Vec<Status> {
    if !refresh {
        if let Ok(g) = CACHE.lock() {
            if let Some((at, en, s)) = g.as_ref() {
                if at.elapsed() < Duration::from_secs(60) && *en == crate::i18n::english() {
                    return s.clone();
                }
            }
        }
    }
    let fresh: Vec<Status> = std::thread::scope(|sc| {
        let handles: Vec<_> = Provider::ALL
            .into_iter()
            .map(|p| sc.spawn(move || status_of(p)))
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    if let Ok(mut g) = CACHE.lock() {
        *g = Some((Instant::now(), crate::i18n::english(), fresh.clone()));
    }
    fresh
}

/// Udbyderen fra indstillingen, ellers den første, der er klar.
pub fn chosen(app: &AppHandle) -> Option<Provider> {
    // Kun i testkørsler: GT_AI=claude vælger udbyder uden at røre brugerens indstillinger (4/10).
    if std::env::var("GT_TEST").is_ok() {
        if let Some(p) = std::env::var("GT_AI")
            .ok()
            .as_deref()
            .and_then(Provider::parse)
        {
            return Some(p);
        }
    }
    if let Some(p) = crate::settings::load(app)
        .ai_provider
        .as_deref()
        .and_then(Provider::parse)
    {
        return Some(p);
    }
    statuses(false).into_iter().find(|s| s.ready).map(|s| s.id)
}

#[derive(Serialize)]
pub struct AiState {
    pub chosen: Option<Provider>,
    pub providers: Vec<Status>,
}

/// Til indstillingerne og fanen Input: hvilke udbydere er klar, og hvilken bruges.
#[tauri::command]
pub async fn ai_status(app: AppHandle, refresh: bool) -> AiState {
    tauri::async_runtime::spawn_blocking(move || {
        let providers = statuses(refresh);
        AiState {
            chosen: chosen(&app),
            providers,
        }
    })
    .await
    .unwrap_or(AiState {
        chosen: None,
        providers: Vec::new(),
    })
}

/// Opgaven til den valgte udbyder. Svaret er JSON efter skemaet.
pub fn run(
    app: &AppHandle,
    prompt: &str,
    schema: &Value,
    web: bool,
    timeout: Duration,
    progress: &Channel<Progress>,
) -> Result<Value, String> {
    match chosen(app) {
        Some(Provider::Claude) => crate::claude::run(app, prompt, schema, web, timeout, progress),
        Some(Provider::Codex) => crate::codex::run(app, prompt, schema, web, timeout, progress),
        Some(Provider::Gemini) => crate::gemini::run(app, prompt, schema, web, timeout, progress),
        Some(Provider::Mistral) => crate::mistral::run(app, prompt, schema, web, timeout, progress),
        None => Err(t!(
            "AI-hjælpen er ikke sat op. Vælg Claude, ChatGPT, Gemini eller Mistral under Indstillinger.",
            "AI help is not set up. Choose Claude, ChatGPT, Gemini or Mistral in Settings."
        )
        .to_owned()),
    }
}

/// Ét kald helt uden værktøjer (egne »/«-kommandoer, commands.rs): ingen websøgning og ingen
/// hentning af sider hos nogen udbyder. Claude får en tom værktøjsliste (`--tools ""`), Codex
/// kaldes uden `--search` i sin skrivebeskyttede sandkasse, og Gemini og Mistral får intet `tools`-felt.
/// Returnerer også, hvem der svarede. Fremdriften har ingen modtager: uden værktøjer er der ingen
/// trin at vise. Claude-kald kan stadig stoppes med `claude_cancel`.
pub fn run_without_tools(
    app: &AppHandle,
    prompt: &str,
    schema: &Value,
    timeout: Duration,
) -> Result<(Value, Provider), String> {
    const WEB: bool = false;
    let progress: Channel<Progress> = Channel::new(|_| Ok(()));
    let provider = chosen(app).ok_or_else(|| {
        t!(
            "AI-hjælpen er ikke sat op. Vælg Claude, ChatGPT, Gemini eller Mistral under Indstillinger.",
            "AI help is not set up. Choose Claude, ChatGPT, Gemini or Mistral in Settings."
        )
        .to_owned()
    })?;
    let answer = match provider {
        Provider::Claude => crate::claude::run(app, prompt, schema, WEB, timeout, &progress),
        Provider::Codex => crate::codex::run(app, prompt, schema, WEB, timeout, &progress),
        Provider::Gemini => crate::gemini::run(app, prompt, schema, WEB, timeout, &progress),
        Provider::Mistral => crate::mistral::run(app, prompt, schema, WEB, timeout, &progress),
    }?;
    Ok((answer, provider))
}

/// JSON fra en sprogmodel, også når den har pakket det ind i ```json … ```.
pub fn parse_json(text: &str) -> Result<Value, String> {
    let t = text.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t).trim();
    serde_json::from_str(t)
        .or_else(|_| {
            // Tekst før eller efter: det yderste objekt.
            match (t.find('{'), t.rfind('}')) {
                (Some(a), Some(b)) if b > a => serde_json::from_str(&t[a..=b]),
                _ => serde_json::from_str::<Value>("x"),
            }
        })
        .map_err(|_| {
            t!(
                "Svaret havde ikke den aftalte form.",
                "The answer was not in the expected format."
            )
            .to_owned()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_findes_ogsaa_i_indpakning() {
        assert_eq!(parse_json("```json\n{\"a\":1}\n```").unwrap()["a"], 1);
        assert_eq!(parse_json("Her er svaret: {\"a\":2} Tak.").unwrap()["a"], 2);
        assert!(parse_json("intet her").is_err());
    }

    #[test]
    fn udbydernavne() {
        assert_eq!(Provider::parse("codex"), Some(Provider::Codex));
        assert_eq!(Provider::Codex.name(), "ChatGPT");
        assert_eq!(Provider::parse("ukendt"), None);
        assert_eq!(Provider::parse("mistral"), Some(Provider::Mistral));
    }
}
