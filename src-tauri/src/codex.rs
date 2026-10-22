//! ChatGPT via OpenAIs Codex-program og brugerens eget ChatGPT-abonnement (delbar udgave 3/10, fase 3).
//! Samme form som Claude-kaldet: prompten via stdin, svaret efter et JSON-skema (`--output-schema`)
//! skrevet til en fil (`-o`), en tom arbejdsmappe og en skrivebeskyttet sandkasse, så agenten ikke kan
//! røre noget på pc'en, selv hvis en webside forsøger at give den ordrer. Ingen API-nøgle i miljøet,
//! så kaldet går på abonnementet.
//!
//! Ikke prøvet mod et rigtigt ChatGPT-login endnu (Codex var ikke installeret 3/10). Flagene er fra
//! OpenAIs dokumentation for `codex exec`. Brugerens konfiguration og shell-værktøjer er slået fra.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::claude::{in_path, Progress};

struct WorkDir(PathBuf);
impl WorkDir {
    fn new(root: &std::path::Path) -> std::io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::fs::create_dir_all(root)?;
        let path = root.join(format!(
            "{}-{}-{}",
            std::process::id(),
            crate::history::now_ms(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }
}
impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// codex.exe, hvor OpenAIs installationer lægger den. Aldrig en .cmd (ADR-0010).
pub fn codex_exe() -> Result<PathBuf, String> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let candidates = [
        in_path("codex.exe"),
        env("LOCALAPPDATA").map(|l| l.join(r"Microsoft\WinGet\Links\codex.exe")),
        env("APPDATA").map(|a| {
            a.join(r"npm\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\codex\codex.exe")
        }),
        env("APPDATA").map(|a| {
            a.join(r"npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe")
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
    let dir = crate::paths::data_dir(app)?.join("ai-codex");
    let work = WorkDir::new(&dir).map_err(|e| {
        t!(
            format!("Arbejdsmappen kunne ikke laves: {e}"),
            format!("The working folder could not be created: {e}")
        )
    })?;
    let dir = &work.0;
    let schema_file = dir.join("skema.json");
    let out_file = dir.join("svar.json");
    std::fs::write(&schema_file, strict(schema).to_string()).map_err(|e| {
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
            "--ignore-user-config",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--ephemeral",
            "-c",
            "features.shell_tool=false",
            "-c",
            "features.unified_exec=false",
        ])
        .arg("--output-schema")
        .arg(&schema_file)
        .arg("-o")
        .arg(&out_file);
        cmd.args([
            "-c",
            if search {
                "web_search=\"live\""
            } else {
                "web_search=\"disabled\""
            },
        ]);
        cmd.arg("-")
            .current_dir(dir)
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
        // Tøm røret under kørslen. Ellers kan en lang fejl blokere processen før dens exit.
        let stderr = child.stderr.take().map(|mut pipe| {
            std::thread::spawn(move || {
                let mut saved = Vec::new();
                let mut buffer = [0u8; 4096];
                while let Ok(n) = pipe.read(&mut buffer) {
                    if n == 0 {
                        break;
                    }
                    let room = 16_384usize.saturating_sub(saved.len());
                    saved.extend_from_slice(&buffer[..n.min(room)]);
                }
                String::from_utf8_lossy(&saved).into_owned()
            })
        });
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let err = stderr.and_then(|t| t.join().ok()).unwrap_or_default();
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
                    let _ = child.wait();
                    return Err(too_slow.to_owned());
                }
            }
        }
    };

    let text = match attempt(web) {
        Ok(t) => t,
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
    crate::ai::parse_json(&text).map(drop_nulls)
}

/// OpenAIs strenge skemaer (`codex --output-schema`) kræver `additionalProperties: false` på hvert
/// objekt og alle felter i `required`. Et felt, der var valgfrit, må i stedet være `null`. Uden det
/// afviste ChatGPT hele kaldet (»schema.additionalProperties is required«, set 20/10).
fn strict(schema: &Value) -> Value {
    let mut s = schema.clone();
    if let Some(obj) = s.as_object_mut() {
        if let Some(props) = obj.get("properties").and_then(Value::as_object).cloned() {
            let required: Vec<String> = obj
                .get("required")
                .and_then(Value::as_array)
                .map(|r| {
                    r.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            let mut out = serde_json::Map::new();
            for (k, v) in props {
                let mut v = strict(&v);
                if !required.contains(&k) {
                    nullable(&mut v);
                }
                out.insert(k, v);
            }
            let keys: Vec<Value> = out.keys().cloned().map(Value::String).collect();
            obj.insert("properties".into(), Value::Object(out));
            obj.insert("required".into(), Value::Array(keys));
            obj.insert("additionalProperties".into(), Value::Bool(false));
        }
        if let Some(items) = obj.get("items").cloned() {
            obj.insert("items".into(), strict(&items));
        }
    }
    s
}

/// Tillad `null` i et felt, der ikke var påkrævet.
fn nullable(v: &mut Value) {
    let Some(obj) = v.as_object_mut() else {
        return;
    };
    match obj.get("type").cloned() {
        Some(Value::String(t)) if t != "null" => {
            obj.insert("type".into(), serde_json::json!([t, "null"]));
        }
        Some(Value::Array(mut ts)) if !ts.contains(&Value::from("null")) => {
            ts.push(Value::from("null"));
            obj.insert("type".into(), Value::Array(ts));
        }
        _ => {}
    }
    if let Some(Value::Array(mut e)) = obj.get("enum").cloned() {
        if !e.contains(&Value::Null) {
            e.push(Value::Null);
            obj.insert("enum".into(), Value::Array(e));
        }
    }
}

/// Felter, ChatGPT har sat til `null`, fordi de var valgfrie, fjernes igen, så svaret ligner de
/// andre modellers og består den samme kontrol bagefter.
fn drop_nulls(v: Value) -> Value {
    match v {
        Value::Object(o) => Value::Object(
            o.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, drop_nulls(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.into_iter().map(drop_nulls).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skemaet_goeres_strengt_som_openai_kraever() {
        let s = serde_json::json!({
            "type": "object",
            "required": ["items"],
            "properties": {
                "items": {"type": "array", "items": {
                    "type": "object",
                    "required": ["quote"],
                    "properties": {
                        "quote": {"type": "string"},
                        "verdict": {"type": "string", "enum": ["korrekt", "forkert"]}
                    }
                }},
                "note": {"type": "string"}
            }
        });
        let out = strict(&s);
        assert_eq!(out["additionalProperties"], false);
        assert_eq!(out["required"], serde_json::json!(["items", "note"]));
        assert_eq!(
            out["properties"]["note"]["type"],
            serde_json::json!(["string", "null"])
        );
        let item = &out["properties"]["items"]["items"];
        assert_eq!(item["additionalProperties"], false);
        assert_eq!(item["required"], serde_json::json!(["quote", "verdict"]));
        assert_eq!(
            item["properties"]["verdict"]["enum"],
            serde_json::json!(["korrekt", "forkert", null])
        );
        assert_eq!(item["properties"]["quote"]["type"], "string");
        let answer = serde_json::json!({"items": [{"quote": "x", "verdict": null}], "note": null});
        assert_eq!(
            drop_nulls(answer),
            serde_json::json!({"items": [{"quote": "x"}]})
        );
    }
    #[test]
    fn parallelle_kald_har_hver_sin_mappe() {
        let root = tempfile::tempdir().unwrap();
        let first = WorkDir::new(root.path()).unwrap();
        let second = WorkDir::new(root.path()).unwrap();
        std::fs::write(first.0.join("svar.json"), b"first").unwrap();
        std::fs::write(second.0.join("svar.json"), b"second").unwrap();
        assert_ne!(first.0, second.0);
        drop(first);
        assert_eq!(
            std::fs::read(second.0.join("svar.json")).unwrap(),
            b"second"
        );
        let path = second.0.clone();
        drop(second);
        assert!(!path.exists());
    }
}
