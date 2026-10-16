//! Synken i baggrunden (ADR-0054): én tråd kører runderne, én lytter efter »der er nyt« fra
//! serveren, og filovervågningen af synkmappen vækker tråden, når noget er gemt.
//!
//! Runderne kører, når appen starter, når en fil i synkmappen er ændret (efter 2 sekunders ro),
//! når serveren melder nyt, og ellers hvert minut. Fladen får status med hændelsen
//! »synk-status« og kan spørge med `synk_status`.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use synk_kerne::protokol::{Commit, CommitResult, PairingCode, Trashed};
use tauri::{AppHandle, Emitter, Manager, State as TauriState};

use super::engine::{Engine, Preview, Report, MARKER};
use super::state::State;
use super::transport::{Http, Transport};

/// Nøglens navn i Windows' legitimationsadministrator.
const CRED: &str = "Gode Tekster/Synk";
const POLL: Duration = Duration::from_secs(60);
const LOG_LINES: usize = 40;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub connected: bool,
    /// Prøvekørslen er godkendt, og synken kører.
    pub started: bool,
    pub server: Option<String>,
    pub device: Option<String>,
    pub root: Option<String>,
    pub running: bool,
    pub last_sync: Option<String>,
    pub last: Option<Report>,
    pub error: Option<String>,
    pub held_deletes: usize,
    pub log: Vec<String>,
}

enum Signal {
    Now,
    AllowDeletes,
    Stop,
}

#[derive(Default)]
pub struct SynkState {
    status: Mutex<Status>,
    log: Mutex<VecDeque<String>>,
    tx: Mutex<Option<Sender<Signal>>>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("Programmets datamappe blev ikke fundet: {e}"))
}

fn open_state(app: &AppHandle) -> Result<State, String> {
    State::open(&data_dir(app)?.join("synk.sqlite"))
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    crate::settings::documents_dir(app).map_err(|e| format!("Dokumenter blev ikke fundet: {e}"))
}

#[cfg(windows)]
fn read_token(_state: &State) -> Option<String> {
    crate::credentials::read(CRED)
}

#[cfg(windows)]
fn write_token(_state: &State, device: &str, token: &str) -> Result<(), String> {
    crate::credentials::write(CRED, device, token)
}

#[cfg(windows)]
fn delete_token(_state: &State) {
    crate::credentials::delete(CRED);
}

// Telefonen har ingen legitimationsadministrator endnu (fase 3: Android Keystore). Indtil da ligger
// nøglen i appens egen database, som kun appen kan læse.
#[cfg(not(windows))]
fn read_token(state: &State) -> Option<String> {
    state.meta("token").ok().flatten()
}

#[cfg(not(windows))]
fn write_token(state: &State, _device: &str, token: &str) -> Result<(), String> {
    state.set_meta("token", token)
}

#[cfg(not(windows))]
fn delete_token(_state: &State) {}

impl SynkState {
    fn log(&self, line: String) {
        let mut log = self.log.lock().unwrap_or_else(|e| e.into_inner());
        log.push_front(format!("{}  {line}", crate::notes::local_stamp()));
        log.truncate(LOG_LINES);
    }

    fn snapshot(&self) -> Status {
        let mut s = self
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        s.log = self
            .log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect();
        s
    }

    fn update(&self, app: &AppHandle, f: impl FnOnce(&mut Status)) {
        f(&mut self.status.lock().unwrap_or_else(|e| e.into_inner()));
        let _ = app.emit("synk-status", self.snapshot());
    }

    fn send(&self, s: Signal) -> bool {
        self.tx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|tx| tx.send(s).is_ok())
    }
}

/// Ved opstart: kør synken, hvis enheden er forbundet, og prøvekørslen er godkendt.
pub fn start(app: &AppHandle) {
    let synk = app.state::<SynkState>();
    let Ok(state) = open_state(app) else { return };
    let (Some(server), Some(device)) = (
        state.meta("server").ok().flatten(),
        state.meta("device").ok().flatten(),
    ) else {
        return;
    };
    let started = state.meta("started").ok().flatten().as_deref() == Some("1");
    let root = root(app).ok();
    synk.update(app, |s| {
        s.connected = true;
        s.started = started;
        s.server = Some(server);
        s.device = Some(device);
        s.root = root.map(|r| r.display().to_string());
    });
    if started {
        spawn(app);
    }
}

/// En linje til loggen om, hvad runden gjorde.
fn summary(r: &Report) -> Option<String> {
    let mut parts = Vec::new();
    let mut add = |n: usize, what: &str| {
        if n > 0 {
            parts.push(format!("{n} {what}"));
        }
    };
    add(r.uploaded.len(), "sendt");
    add(r.downloaded.len(), "hentet");
    add(r.merged.len(), "flettet");
    add(r.conflicts.len(), "konflikt");
    add(r.deleted_local.len() + r.deleted_remote.len(), "slettet");
    add(r.resurrected.len(), "gendannet");
    (!parts.is_empty()).then(|| parts.join(", "))
}

fn spawn(app: &AppHandle) {
    let synk = app.state::<SynkState>();
    let (tx, rx) = mpsc::channel::<Signal>();
    if let Some(old) = synk
        .tx
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .replace(tx.clone())
    {
        let _ = old.send(Signal::Stop);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(root) = root(&app) else { return };
        let watcher = watch(&root, tx.clone());
        listen(&app, tx.clone());
        let mut allow = false;
        let mut first = true;
        loop {
            if !first {
                match rx.recv_timeout(POLL) {
                    Ok(Signal::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                    Ok(Signal::AllowDeletes) => allow = true,
                    Ok(Signal::Now) | Err(RecvTimeoutError::Timeout) => {}
                }
                // Flere signaler på én gang giver én runde.
                while let Ok(s) = rx.try_recv() {
                    match s {
                        Signal::Stop => return,
                        Signal::AllowDeletes => allow = true,
                        Signal::Now => {}
                    }
                }
            }
            first = false;
            round(&app, &root, allow);
            allow = false;
        }
        drop(watcher);
    });
}

fn round(app: &AppHandle, root: &Path, allow: bool) {
    let synk = app.state::<SynkState>();
    let run = || -> Result<Report, String> {
        let state = open_state(app)?;
        let server = state.meta("server")?.ok_or("Ingen synkserver valgt.")?;
        let token = read_token(&state).ok_or("Enhedens nøgle mangler. Forbind igen.")?;
        let device = state.meta("device")?.unwrap_or_else(|| "Pc".into());
        let http = Http::new(&server, &token);
        let engine = Engine {
            root: root.to_path_buf(),
            state: &state,
            transport: &http,
            device,
            now: crate::notes::local_stamp,
            allow_mass_delete: allow,
        };
        let mut total = engine.sync_once()?;
        // Konfliktkopier sendes med det samme.
        for _ in 0..3 {
            if !total.again {
                break;
            }
            let more = engine.sync_once()?;
            total.uploaded.extend(more.uploaded);
            total.errors.extend(more.errors);
            total.again = more.again;
        }
        Ok(total)
    };
    synk.update(app, |s| s.running = true);
    let result = run();
    match &result {
        Ok(r) => {
            if let Some(line) = summary(r) {
                synk.log(line);
            }
            for c in &r.conflicts {
                synk.log(format!("To udgaver: din ligger nu i »{c}«"));
            }
            for p in &r.resurrected {
                synk.log(format!(
                    "»{p}« var slettet et andet sted, men rettet her. Den er beholdt."
                ));
            }
            for e in &r.errors {
                synk.log(e.clone());
            }
            if r.held_deletes > 0 {
                synk.log(format!(
                    "Bremsen holdt {} sletninger tilbage. Godkend dem i Indstillinger › Synk.",
                    r.held_deletes
                ));
            }
            if !r.conflicts.is_empty() {
                let _ = app.emit("synk-konflikt", r.conflicts.clone());
            }
        }
        Err(e) => synk.log(e.clone()),
    }
    synk.update(app, |s| {
        s.running = false;
        match result {
            Ok(r) => {
                s.error = None;
                s.held_deletes = r.held_deletes;
                s.last_sync = Some(crate::notes::local_stamp());
                s.last = Some(r);
            }
            Err(e) => s.error = Some(e),
        }
    });
}

/// Vækker synken 2 sekunder efter, at noget i synkmappen er ændret. Programmets egne midlertidige
/// filer og andre skjulte navne tæller ikke.
fn watch(
    root: &Path,
    tx: Sender<Signal>,
) -> Option<
    notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::RecommendedCache,
    >,
> {
    use notify::RecursiveMode;
    let mut debouncer = notify_debouncer_full::new_debouncer(
        Duration::from_secs(2),
        None,
        move |res: notify_debouncer_full::DebounceEventResult| {
            let Ok(events) = res else { return };
            let relevant = events.iter().any(|e| {
                e.paths.iter().any(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| !n.starts_with('.') && !n.starts_with("~$"))
                })
            });
            if relevant {
                let _ = tx.send(Signal::Now);
            }
        },
    )
    .ok()?;
    debouncer.watch(root, RecursiveMode::Recursive).ok()?;
    Some(debouncer)
}

/// Lytter efter »der er nyt« fra serveren og vækker synken. Falder forbindelsen ud, prøver tråden
/// igen efter en pause. Runden hvert minut dækker imens.
fn listen(app: &AppHandle, tx: Sender<Signal>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut wait = Duration::from_secs(5);
        loop {
            let creds = open_state(&app).ok().and_then(|state| {
                Some((state.meta("server").ok().flatten()?, read_token(&state)?))
            });
            let Some((server, token)) = creds else { return };
            let http = Http::new(&server, &token);
            let mut seen = None;
            let result = http.listen(|seq| {
                if seen.is_some_and(|s| s >= seq) {
                    return true;
                }
                let first = seen.is_none();
                seen = Some(seq);
                // Det første løbenummer er bare »sådan står det nu«.
                first || tx.send(Signal::Now).is_ok()
            });
            if result.is_ok() && tx.send(Signal::Now).is_err() {
                return;
            }
            std::thread::sleep(wait);
            wait = (wait * 2).min(Duration::from_secs(300));
        }
    });
}

// --- kommandoer --------------------------------------------------------------------------------

#[tauri::command]
pub fn synk_status(synk: TauriState<'_, SynkState>) -> Status {
    synk.snapshot()
}

fn valid_server(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    let local = url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost");
    if url.starts_with("https://") || local {
        Ok(url.to_owned())
    } else {
        Err("Serverens adresse skal begynde med https://".into())
    }
}

/// Forbind enheden: med en parringskode fra en anden enhed, eller med ejerens nøgle på den
/// første. Synken starter først, når prøvekørslen er godkendt (`synk_start`).
#[tauri::command]
pub async fn synk_connect(
    app: AppHandle,
    server: String,
    name: String,
    code: Option<String>,
    admin: Option<String>,
) -> Result<Status, String> {
    let server = valid_server(&server)?;
    let name = if name.trim().is_empty() {
        "Pc".to_owned()
    } else {
        name.trim().to_owned()
    };
    let (s2, n2) = (server.clone(), name.clone());
    let token = tauri::async_runtime::spawn_blocking(move || {
        Http::register(&s2, &n2, code.as_deref(), admin.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;
    let state = open_state(&app)?;
    state.forget_all()?;
    write_token(&state, &name, &token.token)?;
    state.set_meta("server", &server)?;
    state.set_meta("device", &name)?;
    state.set_meta("device_id", &token.id)?;
    state.set_meta("started", "0")?;
    let root = root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let marker = root.join(MARKER);
    if !marker.exists() {
        std::fs::write(&marker, "Gode Tekster synkroniserer denne mappe.\n")
            .map_err(|e| format!("Markørfilen kunne ikke laves: {e}"))?;
    }
    let synk = app.state::<SynkState>();
    synk.log(format!("Forbundet til {server} som »{name}«"));
    synk.update(&app, |s| {
        s.connected = true;
        s.started = false;
        s.server = Some(server);
        s.device = Some(name);
        s.root = Some(root.display().to_string());
        s.error = None;
    });
    Ok(synk.snapshot())
}

/// Hvad den første runde vil gøre. Intet ændres.
#[tauri::command]
pub async fn synk_preview(app: AppHandle) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = open_state(&app)?;
        let server = state.meta("server")?.ok_or("Ingen synkserver valgt.")?;
        let token = read_token(&state).ok_or("Enhedens nøgle mangler. Forbind igen.")?;
        let http = Http::new(&server, &token);
        Engine {
            root: root(&app)?,
            state: &state,
            transport: &http,
            device: String::new(),
            now: crate::notes::local_stamp,
            allow_mass_delete: false,
        }
        .preview()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Prøvekørslen er godkendt: synken kører fra nu af, også efter genstart.
#[tauri::command]
pub fn synk_start(app: AppHandle) -> Result<Status, String> {
    open_state(&app)?.set_meta("started", "1")?;
    let synk = app.state::<SynkState>();
    synk.update(&app, |s| s.started = true);
    spawn(&app);
    Ok(synk.snapshot())
}

#[tauri::command]
pub fn synk_now(synk: TauriState<'_, SynkState>) -> bool {
    synk.send(Signal::Now)
}

/// »Ja, slet dem«: næste runde må slette flere filer, end bremsen ellers tillader.
#[tauri::command]
pub fn synk_allow_deletes(synk: TauriState<'_, SynkState>) -> bool {
    synk.send(Signal::AllowDeletes) && synk.send(Signal::Now)
}

#[tauri::command]
pub async fn synk_pairing_code(app: AppHandle) -> Result<PairingCode, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = open_state(&app)?;
        let server = state.meta("server")?.ok_or("Ingen synkserver valgt.")?;
        let token = read_token(&state).ok_or("Enhedens nøgle mangler. Forbind igen.")?;
        Http::new(&server, &token).pairing_code()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Enhedens forbindelse til serveren, til de kald, der ikke er en synkroniseringsrunde.
fn http(app: &AppHandle) -> Result<Http, String> {
    let state = open_state(app)?;
    let server = state.meta("server")?.ok_or("Ingen server valgt.")?;
    let token = read_token(&state).ok_or("Enhedens nøgle mangler. Forbind igen.")?;
    Ok(Http::new(&server, &token))
}

/// Serverens papirkurv: filer slettet inden for 30 dage, på alle enheder.
#[tauri::command]
pub async fn synk_trash(app: AppHandle) -> Result<Vec<Trashed>, String> {
    tauri::async_runtime::spawn_blocking(move || http(&app)?.trash())
        .await
        .map_err(|e| e.to_string())?
}

/// Hent en slettet fil tilbage: den sidste udgave lægges oven på sletningen, og næste runde
/// henter den ned på alle enheder.
#[tauri::command]
pub async fn synk_restore(app: AppHandle, item: Trashed) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let c = Commit {
            path: item.path,
            base_rev: item.rev,
            hash: Some(item.hash),
            size: item.size,
        };
        match http(&handle)?.commit(&c)? {
            CommitResult::Ok { .. } => Ok(()),
            CommitResult::Conflict { .. } => {
                Err("Filen er ændret, siden listen blev hentet. Se papirkurven igen.".to_owned())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    app.state::<SynkState>().send(Signal::Now);
    Ok(())
}

/// Kobl enheden fra. Filerne på disken røres ikke, og serveren beholder sin kopi.
#[tauri::command]
pub fn synk_disconnect(app: AppHandle) -> Result<Status, String> {
    let synk = app.state::<SynkState>();
    synk.send(Signal::Stop);
    synk.tx.lock().unwrap_or_else(|e| e.into_inner()).take();
    let state = open_state(&app)?;
    delete_token(&state);
    state.forget_all()?;
    if let Ok(root) = root(&app) {
        let _ = std::fs::remove_file(root.join(MARKER));
    }
    synk.log("Koblet fra. Filerne er ikke rørt.".into());
    synk.update(&app, |s| *s = Status::default());
    Ok(synk.snapshot())
}
