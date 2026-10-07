//! ChatGPT via OpenAIs Codex-program og brugerens eget ChatGPT-abonnement (delbar udgave 3/10, fase 3).
//! Samme form som Claude-kaldet: prompten via stdin, svaret efter et JSON-skema (`--output-schema`)
//! skrevet til en fil (`-o`), en tom arbejdsmappe og en skrivebeskyttet sandkasse, så agenten ikke kan
//! røre noget på pc'en, selv hvis en webside forsøger at give den ordrer. Ingen API-nøgle i miljøet,
//! så kaldet går på abonnementet.
//!
//! Ikke prøvet mod et rigtigt ChatGPT-login endnu (Codex var ikke installeret 3/10). Flagene er fra
//! OpenAIs dokumentation for `codex exec`; kender programmet ikke `--search`, prøves igen uden.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::claude::{in_path, Progress};

/// codex.exe, hvor OpenAIs installationer lægger den. Aldrig en .cmd (ADR-0010).
pub fn codex_exe() -> Result<PathBuf, String> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let candidates = [
        in_path("codex.exe"),
        env("LOCALAPPDATA").map(|l| l.join(r"Microsoft\WinGet\Links\codex.exe")),
        env("APPDATA").map(|a| {
            a.join(r"npm\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\codex\codex.exe")
        }),
        env("USERPROFILE").map(|h| h.join(r".local\bin\codex.exe")),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            t!(
                "ChatGPT-hjælpen kræver OpenAIs Codex-program og et ChatGPT-abonnement.",
                "ChatGPT help needs OpenAI's Codex app and a ChatGPT subscription."
            )
            .to_owned()
        })
}

fn base(exe: PathBuf) -> Command {
    let mut cmd = Command::new(exe);
    cmd.env_remove("OPENAI_API_KEY").env_remove("CODEX_API_KEY");
    cmd
}

/// Logget ind med »Sign in with ChatGPT«? `codex login status` lykkes kun, når der er et login.
pub fn logged_in() -> bool {
    let Ok(exe) = codex_exe() else { return false };
    crate::ai::quick_output(base(exe).args(["login", "status"]), Duration::from_secs(20)).is_some()
}

pub fn run(
    app: &AppHandle,
    prompt: &str,
    schema: &Value,
    web: bool,
    timeout: Duration,
    progress: &Channel<Progress>,
) -> Result<Value, String> {
    let exe = codex_exe()?;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| {
            t!(
                format!("Programmets datamappe blev ikke fundet: {e}"),
                format!("The app's data folder was not found: {e}")
            )
        })?
        .join("ai-codex");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| {
        t!(
            format!("Arbejdsmappen kunne ikke laves: {e}"),
            format!("The working folder could not be created: {e}")
        )
    })?;
    let schema_file = dir.join("skema.json");
    let out_file = dir.join("svar.json");
    std::fs::write(&schema_file, schema.to_string()).map_err(|e| {
        t!(
            format!("Skemaet kunne ikke gemmes: {e}"),
            format!("The schema could not be saved: {e}")
        )
    })?;
    let _ = progress.send(Progress::Step {
        text: t!(
            "Venter på svar fra ChatGPT",
            "Waiting for an answer from ChatGPT"
        )
        .to_owned(),
    });
    let too_slow = t!(
        "ChatGPT svarede ikke i tide.",
        "ChatGPT did not answer in time."
    );

    let attempt = |search: bool| -> Result<String, String> {
        let mut cmd = base(exe.clone());
        cmd.args([
            "exec",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--ephemeral",
        ])
        .arg("--output-schema")
        .arg(&schema_file)
        .arg("-o")
        .arg(&out_file);
        if search {
            cmd.arg("--search");
        }
        cmd.arg("-")
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().map_err(|e| {
            t!(
                format!("ChatGPT-hjælpen kunne ikke startes: {e}"),
                format!("ChatGPT help could not be started: {e}")
            )
        })?;
        if let Some(mut stdin) = child.stdin.take() {
            let text = prompt.to_owned();
            std::thread::spawn(move || {
                let _ = stdin.write_all(text.as_bytes());
            });
        }
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut err = String::new();
                    if let Some(mut e) = child.stderr.take() {
                        let _ = e.read_to_string(&mut err);
                    }
                    if status.success() {
                        return std::fs::read_to_string(&out_file).map_err(|_| {
                            t!("ChatGPT gav intet svar.", "ChatGPT gave no answer.").to_owned()
                        });
                    }
                    return Err(err);
                }
                Ok(None) if start.elapsed() < timeout => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                _ => {
                    let _ = child.kill();
                    return Err(too_slow.to_owned());
                }
            }
        }
    };

    let text = match attempt(web) {
        Ok(t) => t,
        // Et ældre Codex kender ikke --search: prøv igen uden websøgning.
        Err(e) if web && e.contains("--search") => attempt(false)?,
        Err(e) if e == too_slow => return Err(e),
        Err(e) => {
            let first = e
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or(t!("ukendt fejl", "unknown error"))
                .chars()
                .take(200)
                .collect::<String>();
            return Err(t!(
                format!("ChatGPT svarede med en fejl: {first}"),
                format!("ChatGPT answered with an error: {first}")
            ));
        }
    };
    let _ = std::fs::remove_dir_all(&dir);
    crate::ai::parse_json(&text)
}
