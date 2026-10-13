//! Filvalg og afkodning i Rust. En job-id kommer før tung behandling, så Stop altid virker.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
pub const EXTENSIONS: &[&str] = &[
    "wav", "mp3", "m4a", "m4b", "aac", "flac", "ogg", "oga", "opus", "webm", "wma", "aif", "aiff",
    "caf", "amr", "3gp", "3gpp", "3ga", "mp4", "dss", "ds2",
];
const FFMPEG_SHA: &str = "ad8f211bc894755e0061c55ab280ae00e8d3d4f15a8cc4372b24cfa247b5942e";
const FFPROBE_SHA: &str = "9df3b0b5275e830961df6d94e1f7a71121a7abd5ff708e9fec8a0b6084a55015";
static NEXT: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct AudioState {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    tools: Mutex<Option<PathBuf>>,
}
pub fn release_owner(app: &AppHandle, owner: &str) {
    if let Ok(mut jobs) = app.state::<AudioState>().jobs.lock() {
        jobs.retain(|_, job| {
            if job.owner != owner {
                return true;
            }
            job.cancelled.store(true, Ordering::SeqCst);
            if let Ok(mut child) = job.child.lock() {
                if let Some(child) = child.as_mut() {
                    let _ = child.kill();
                }
            }
            let _ = app
                .asset_protocol_scope()
                .forbid_file(job.folder.join("audio.wav"));
            false
        });
    }
}
fn job_folder(name: &str) -> bool {
    !name.is_empty()
        && name.split('-').count() == 3
        && name
            .split('-')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}
pub fn cleanup(app: &AppHandle) {
    let Ok(root) = app
        .path()
        .app_local_data_dir()
        .map(|p| p.join("audio-jobs"))
    else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if !job_folder(&entry.file_name().to_string_lossy())
            || !entry
                .file_type()
                .is_ok_and(|t| t.is_dir() && !t.is_symlink())
        {
            continue;
        }
        if entry.path().join("recovery.md").exists() {
            let _ = std::fs::remove_file(entry.path().join("audio.wav"));
        } else {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
#[tauri::command]
pub fn audio_recoveries(app: AppHandle) -> Vec<String> {
    let Ok(root) = app
        .path()
        .app_local_data_dir()
        .map(|p| p.join("audio-jobs"))
    else {
        return vec![];
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![];
    };
    let active: Vec<_> = app
        .state::<AudioState>()
        .jobs
        .lock()
        .map(|j| j.keys().cloned().collect())
        .unwrap_or_default();
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (job_folder(&name)
                && !active.contains(&name)
                && entry.path().join("recovery.md").is_file())
            .then_some(name)
        })
        .collect()
}
/// Mappen med en nødkopi fra en tidligere session. Kun en rigtig mappe under `audio-jobs`, som
/// intet aktivt job ejer.
fn recovery_folder(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !job_folder(id) || !audio_recoveries(app.clone()).iter().any(|r| r == id) {
        return Err(error());
    }
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| error())?
        .join("audio-jobs")
        .canonicalize()
        .map_err(|_| error())?;
    let folder = root.join(id);
    if !std::fs::symlink_metadata(&folder).is_ok_and(|m| m.is_dir() && !m.is_symlink())
        || folder.canonicalize().map_err(|_| error())? != folder
    {
        return Err(error());
    }
    Ok(folder)
}
/// Filnavnet, Gem-dialogen foreslår: optagelsens navn fra metadataen, ellers »Transskription.md«.
fn recovery_name(text: &str) -> String {
    text.lines()
        .next()
        .and_then(|l| l.strip_prefix("<!-- gt:lyd "))
        .and_then(|l| l.strip_suffix(" -->"))
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|v| v.get("audio")?.as_str().map(str::to_owned))
        .filter(|a| !a.contains(['/', '\\', ':']))
        .and_then(|a| {
            Path::new(&a)
                .file_stem()
                .map(|s| format!("{}.transskription.md", s.to_string_lossy()))
        })
        .unwrap_or_else(|| "Transskription.md".to_owned())
}
/// En nødkopi gemmes, hvor brugeren vælger, og ryddes så væk. Den åbnes aldrig i den skjulte
/// jobmappe, for dér ville rettelserne forsvinde med næste oprydning.
#[tauri::command]
pub async fn audio_recover(app: AppHandle, id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = recovery_folder(&app, &id)?;
        let text = std::fs::read_to_string(folder.join("recovery.md")).map_err(|_| error())?;
        use tauri_plugin_dialog::DialogExt;
        let picked = app
            .dialog()
            .file()
            .set_title(t!("Gem gendannet transskription", "Save recovered transcript"))
            .set_file_name(recovery_name(&text))
            .add_filter("Markdown", &["md"])
            .blocking_save_file()
            .and_then(|p| p.into_path().ok());
        let Some(target) = picked else {
            return Ok(None);
        };
        crate::files::write_atomic_new(&target, text.as_bytes()).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                t!("Filen findes allerede. Vælg et nyt navn, så den eksisterende tekst bliver bevaret.", "The file already exists. Choose a new name to keep the existing text.").to_owned()
            } else {
                t!("Transskriptionen kunne ikke gemmes. Vælg en mappe med plads og skriverettigheder.", "Could not save the transcript. Choose a writable folder with enough space.").to_owned()
            }
        })?;
        let _ = std::fs::remove_dir_all(&folder);
        crate::document::choose(&app, &target);
        Ok(Some(target.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| error())?
}
/// Sletter en nødkopi fra en tidligere session. `audio_discard` kan kun kassere det åbne jobs.
#[tauri::command]
pub fn audio_forget_recovery(app: AppHandle, id: String) -> Result<(), String> {
    let folder = recovery_folder(&app, &id)?;
    std::fs::remove_dir_all(folder).map_err(|_| {
        t!(
            "Den ugemte transskription kunne ikke slettes. Prøv igen.",
            "The unsaved transcript could not be deleted. Try again."
        )
        .to_owned()
    })
}
#[tauri::command]
pub fn audio_discard(app: AppHandle, window: tauri::Window, id: String) -> Result<(), String> {
    let selected = job(&app, window.label(), &id)?;
    if selected.running.load(Ordering::SeqCst) {
        return Err(error());
    }
    match std::fs::remove_file(selected.folder.join("recovery.md")) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err(error()),
    }
    *selected.transcript.lock().map_err(|_| error())? = None;
    Ok(())
}
struct Job {
    owner: String,
    source: PathBuf,
    folder: PathBuf,
    cancelled: AtomicBool,
    running: AtomicBool,
    child: Mutex<Option<Child>>,
    info: Mutex<Option<AudioInfo>>,
    transcript: Mutex<Option<String>>,
    completed: AtomicU64,
    text: Mutex<String>,
    provider: Mutex<Option<crate::ai::Provider>>,
    language: Mutex<Option<String>>,
}
impl Drop for Job {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(c) = child.as_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        if self.folder.join("recovery.md").exists() {
            let _ = std::fs::remove_file(self.folder.join("audio.wav"));
        } else {
            let _ = std::fs::remove_dir_all(&self.folder);
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    id: String,
    name: String,
    duration: f64,
    playback_path: String,
    stamp: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    done: u64,
    total: u64,
    retry: u64,
    wait_seconds: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Support {
    provider: Option<crate::ai::Provider>,
    ready: bool,
    detail: String,
}
struct Running(Arc<Job>);
impl Drop for Running {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::SeqCst);
    }
}
fn running(job: &Arc<Job>) -> Result<Running, String> {
    job.running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| error())?;
    job.cancelled.store(false, Ordering::SeqCst);
    Ok(Running(Arc::clone(job)))
}
fn error() -> String {
    t!(
        "Lydfilen kunne ikke behandles.",
        "The audio file could not be processed."
    )
    .to_owned()
}
pub fn hash_file(path: &Path) -> Result<String, String> {
    hash_checked(path, None)
}
fn hash_checked(path: &Path, cancelled: Option<&AtomicBool>) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|_| error())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancelled.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(error());
        }
        let n = f.read(&mut buffer).map_err(|_| error())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn verified(dir: &Path) -> bool {
    hash_file(&dir.join("ffmpeg.exe")).is_ok_and(|h| h == FFMPEG_SHA)
        && hash_file(&dir.join("ffprobe.exe")).is_ok_and(|h| h == FFPROBE_SHA)
}
fn tools(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<AudioState>();
    let mut cache = state.tools.lock().map_err(|_| error())?;
    if let Some(dir) = cache.as_ref() {
        return Ok(dir.clone());
    }
    let mut candidates = Vec::new();
    if let Some(dir) = crate::settings::load(app).audio_tools_dir {
        candidates.push(dir);
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("audio-tools"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join(r"Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.2-full_build\bin"));
    }
    if let Some(dir) = candidates.into_iter().find(|p| verified(p)) {
        *cache = Some(dir.clone());
        return Ok(dir);
    }
    Err(t!(
        "Lydimport kræver FFmpeg 8.1.2 fra Gyan. Vælg ffmpeg.exe i Lyd-panelet.",
        "Audio import needs FFmpeg 8.1.2 from Gyan. Select ffmpeg.exe in the Audio panel."
    )
    .to_owned())
}
#[tauri::command]
pub async fn pick_audio_tools(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .add_filter("FFmpeg", &["exe"])
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok());
    let Some(picked) = picked else {
        return Ok(false);
    };
    let dir = picked.parent().ok_or_else(error)?.to_path_buf();
    let check = dir.clone();
    if !tauri::async_runtime::spawn_blocking(move || verified(&check))
        .await
        .map_err(|_| error())?
    {
        return Err(t!("Filerne matcher ikke den kontrollerede FFmpeg 8.1.2-build. Vælg bin-mappen fra Gyan full-build.", "The files do not match the verified FFmpeg 8.1.2 build. Select the bin folder from Gyan's full build.").to_owned());
    }
    crate::settings::set_audio_tools(&app, &dir)?;
    *app.state::<AudioState>()
        .tools
        .lock()
        .map_err(|_| error())? = Some(dir);
    Ok(true)
}
/// Er jobbet stadig åbent (stoppet, men ikke lukket eller sluppet med vinduet)?
fn still_open(app: &AppHandle, job: &Arc<Job>) -> bool {
    app.state::<AudioState>()
        .jobs
        .lock()
        .is_ok_and(|jobs| jobs.values().any(|j| Arc::ptr_eq(j, job)))
}
fn job(app: &AppHandle, owner: &str, id: &str) -> Result<Arc<Job>, String> {
    app.state::<AudioState>()
        .jobs
        .lock()
        .map_err(|_| error())?
        .get(id)
        .filter(|j| j.owner == owner)
        .cloned()
        .ok_or_else(|| {
            t!(
                "Lydfilen er ikke åben i dette vindue.",
                "The audio file is not open in this window."
            )
            .to_owned()
        })
}
fn run(job: &Job, exe: &Path, args: &[String], limit: Duration) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|_| error())?;
    let stdout = child.stdout.take().ok_or_else(error)?;
    // Kun metadata læses her. Lyd skrives direkte af decoderens proces til jobmappen.
    let reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        let result = stdout.take(1024 * 1024).read_to_end(&mut b);
        (result, b)
    });
    *job.child.lock().map_err(|_| error())? = Some(child);
    let start = Instant::now();
    let result = loop {
        if job.cancelled.load(Ordering::Relaxed) || start.elapsed() > limit {
            break Err(t!(
                "Lydbehandlingen blev afbrudt eller tog for lang tid.",
                "Audio processing was cancelled or took too long."
            )
            .to_owned());
        }
        let status = job
            .child
            .lock()
            .map_err(|_| error())?
            .as_mut()
            .ok_or_else(error)?
            .try_wait()
            .map_err(|_| error())?;
        if let Some(status) = status {
            break if status.success() {
                Ok(())
            } else {
                Err(t!("Lydfilen kan ikke læses. Den kan være beskadiget, krypteret eller bruge et lydformat, der ikke er understøttet.", "The audio file cannot be read. It may be damaged, encrypted, or use an unsupported audio format.").to_owned())
            };
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    if let Some(mut child) = job.child.lock().map_err(|_| error())?.take() {
        if result.is_err() {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
    let (read, bytes) = reader.join().map_err(|_| error())?;
    read.map_err(|_| error())?;
    result.map(|()| bytes)
}
fn s(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| (*a).to_owned()).collect()
}

fn register(app: &AppHandle, owner: String, source: PathBuf) -> Result<String, String> {
    let source = source.canonicalize().map_err(|_| error())?;
    let metadata = source.metadata().map_err(|_| error())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 8 * 1024 * 1024 * 1024 {
        return Err(error());
    }
    let id = format!(
        "{}-{}-{}",
        std::process::id(),
        crate::history::now_ms(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let folder = app
        .path()
        .app_local_data_dir()
        .map_err(|_| error())?
        .join("audio-jobs")
        .join(&id);
    std::fs::create_dir_all(&folder).map_err(|_| error())?;
    let selected = Arc::new(Job {
        owner,
        source,
        folder,
        cancelled: AtomicBool::new(false),
        running: AtomicBool::new(false),
        child: Mutex::new(None),
        info: Mutex::new(None),
        transcript: Mutex::new(None),
        completed: AtomicU64::new(0),
        text: Mutex::new(String::new()),
        provider: Mutex::new(None),
        language: Mutex::new(None),
    });
    let mut jobs = app
        .state::<AudioState>()
        .inner()
        .jobs
        .lock()
        .map_err(|_| error())?;
    if jobs.len() >= 8 {
        return Err(error());
    }
    jobs.insert(id.clone(), selected);
    Ok(id)
}
#[tauri::command]
pub async fn pick_audio(app: AppHandle, window: tauri::Window) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title(t!("Vælg en lydfil", "Choose an audio file"))
        .add_filter(t!("Lydfiler", "Audio files"), EXTENSIONS)
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok());
    picked
        .map(|p| register(&app, window.label().to_owned(), p))
        .transpose()
}
#[tauri::command]
pub async fn audio_prepare(
    app: AppHandle,
    window: tauri::Window,
    id: String,
) -> Result<AudioInfo, String> {
    let selected = job(&app, window.label(), &id)?;
    let guard = running(&selected)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let tools = tools(&app)?;
        let stamp = hash_checked(&selected.source, Some(&selected.cancelled))?;
        let mut args = s(&[
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-show_entries",
            "stream=codec_type:format=duration",
            "-of",
            "json",
        ]);
        args.push(selected.source.to_string_lossy().into_owned());
        let probe: serde_json::Value = serde_json::from_slice(&run(
            &selected,
            &tools.join("ffprobe.exe"),
            &args,
            Duration::from_secs(30),
        )?)
        .map_err(|_| error())?;
        let tracks = probe["streams"]
            .as_array()
            .ok_or_else(error)?
            .iter()
            .filter(|s| s["codec_type"] == "audio")
            .count();
        if tracks != 1 {
            return Err(t!(
                "Vælg en fil med ét lydspor.",
                "Choose a file with one audio track."
            )
            .to_owned());
        }
        let duration = probe["format"]["duration"]
            .as_str()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|d| d.is_finite() && *d > 0.0 && *d <= 21600.0)
            .ok_or_else(|| {
                t!(
                    "Optagelsen skal være højst seks timer og have en læsbar varighed.",
                    "The recording must be at most six hours with a readable duration."
                )
                .to_owned()
            })?;
        let playback = selected.folder.join("audio.wav");
        let mut args = s(&[
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-xerror",
            "-y",
            "-protocol_whitelist",
            "file",
            "-i",
        ]);
        args.push(selected.source.to_string_lossy().into_owned());
        args.extend(s(&[
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-t",
            "21601",
        ]));
        args.push(playback.to_string_lossy().into_owned());
        run(
            &selected,
            &tools.join("ffmpeg.exe"),
            &args,
            Duration::from_secs(300),
        )?;
        let (_, samples) = wav_data(&playback)?;
        let actual = samples as f64 / 32000.0;
        if actual <= 0.0
            || actual > 21600.0
            || !duration_matches(actual, duration)
            || hash_checked(&selected.source, Some(&selected.cancelled))? != stamp
            || selected.cancelled.load(Ordering::SeqCst)
        {
            return Err(error());
        }
        let info = AudioInfo {
            id,
            name: selected
                .source
                .file_name()
                .ok_or_else(error)?
                .to_string_lossy()
                .into_owned(),
            duration: actual,
            playback_path: playback.to_string_lossy().into_owned(),
            stamp,
        };
        app.asset_protocol_scope()
            .allow_file(&playback)
            .map_err(|_| error())?;
        *selected.info.lock().map_err(|_| error())? = Some(info.clone());
        Ok(info)
    })
    .await
    .map_err(|_| error())?
}

/// Passer den afkodede længde med ffprobes? ffprobe gætter længden ud fra bitraten for VBR-mp3
/// og nogle m4a-filer, så en lang optagelse kan afvige mere end et sekund uden at være
/// beskadiget. Tolerancen er derfor 3 sekunder eller 2 procent, det største af dem.
fn duration_matches(decoded: f64, probed: f64) -> bool {
    (decoded - probed).abs() <= (0.02 * probed.abs()).max(3.0)
}
/// Søg RIFF-chunks, da FFmpeg kan lægge LIST før PCM-data.
fn wav_data(path: &Path) -> Result<(u64, u64), String> {
    let mut f = std::fs::File::open(path).map_err(|_| error())?;
    let length = f.metadata().map_err(|_| error())?.len();
    let mut header = [0; 12];
    f.read_exact(&mut header).map_err(|_| error())?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Err(error());
    }
    let mut valid_format = false;
    loop {
        let mut chunk = [0; 8];
        f.read_exact(&mut chunk).map_err(|_| error())?;
        let size = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as u64;
        let at = f.stream_position().map_err(|_| error())?;
        if at + size > length {
            return Err(error());
        }
        if &chunk[..4] == b"fmt " {
            if size < 16 {
                return Err(error());
            }
            let mut format = [0; 16];
            f.read_exact(&mut format).map_err(|_| error())?;
            valid_format = format[..2] == [1, 0]
                && format[2..4] == [1, 0]
                && format[4..8] == 16000u32.to_le_bytes()
                && format[14..16] == [16, 0];
        }
        if &chunk[..4] == b"data" {
            return if valid_format && size.is_multiple_of(2) {
                Ok((at, size))
            } else {
                Err(error())
            };
        }
        f.seek(SeekFrom::Start(at + size + (size % 2)))
            .map_err(|_| error())?;
    }
}
fn wav_block(pcm: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend(b"RIFF");
    out.extend((36 + pcm.len() as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(16000u32.to_le_bytes());
    out.extend(32000u32.to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend((pcm.len() as u32).to_le_bytes());
    out.extend(pcm);
    out
}
// Lyd kræver et udtrykkeligt valg. Den første tilgængelige konto er aldrig en fallback.
fn audio_provider(app: &AppHandle) -> Option<crate::ai::Provider> {
    if std::env::var("GT_TEST").is_ok() && std::env::var("GT_AI").is_ok() {
        return crate::ai::chosen(app);
    }
    match crate::settings::load(app).ai_provider.as_deref() {
        Some("claude") => Some(crate::ai::Provider::Claude),
        Some("codex") => Some(crate::ai::Provider::Codex),
        Some("gemini") => Some(crate::ai::Provider::Gemini),
        Some("mistral") => Some(crate::ai::Provider::Mistral),
        _ => None,
    }
}
#[tauri::command]
pub async fn audio_support(app: AppHandle) -> Result<Support, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let provider = audio_provider(&app);
        let (ready, detail) = match provider {
            Some(crate::ai::Provider::Gemini) => {
                if crate::gemini::has_key() {
                    (true, t!("Lyden sendes til Gemini med din nøgle fra Google AI Studio. Din kvote og eventuelle betaling gælder.", "Audio is sent to Gemini using your Google AI Studio key. Your quota and any billing apply."))
                } else {
                    (false, t!("Gemini mangler din nøgle. Indsæt den under AI-hjælp i indstillingerne.", "Gemini needs your key. Add it under AI help in Settings."))
                }
            }
            Some(crate::ai::Provider::Codex) => {
                if crate::codex::logged_in() {
                    (true, t!("Lyden transskriberes gennem dit ChatGPT-abonnement via OpenAIs Codex-program. Ingen API-nøgle kræves.", "Audio is transcribed through your ChatGPT subscription via OpenAI's Codex app. No API key needed."))
                } else {
                    (false, t!("ChatGPT kræver login i Codex-programmet. Kør 'codex login' i terminalen.", "ChatGPT requires login in the Codex app. Run 'codex login' in the terminal."))
                }
            }
            _ => (false, t!("Den valgte AI-forbindelse har endnu ingen afprøvet filtransskription i appen. Vælg selv en anden under AI-hjælp, hvis du vil bruge den.", "The selected AI connection has no verified file transcription in this app yet. Choose another in AI help if you want to use it.")),
        };
        Ok(Support { provider, ready, detail: detail.to_owned() })
    }).await.map_err(|_| error())?
}
#[tauri::command]
pub fn audio_cancel(app: AppHandle, window: tauri::Window, id: String) -> Result<(), String> {
    let selected = job(&app, window.label(), &id)?;
    selected.cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut child) = selected.child.lock() {
        if let Some(c) = child.as_mut() {
            let _ = c.kill();
        }
    }
    Ok(())
}
#[tauri::command]
pub fn close_audio(app: AppHandle, window: tauri::Window, id: String) -> Result<(), String> {
    let selected = job(&app, window.label(), &id)?;
    selected.cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut child) = selected.child.lock() {
        if let Some(c) = child.as_mut() {
            let _ = c.kill();
        }
    }
    let _ = app
        .asset_protocol_scope()
        .forbid_file(selected.folder.join("audio.wav"));
    app.state::<AudioState>()
        .jobs
        .lock()
        .map_err(|_| error())?
        .remove(&id);
    Ok(())
}
pub(crate) fn link(name: &str) -> String {
    name.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
pub(crate) fn time(ms: u64) -> String {
    let sec = ms / 1000;
    format!("{:02}:{:02}:{:02}", sec / 3600, sec / 60 % 60, sec % 60)
}
pub(crate) fn escape_text(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if "\\`*_{}[]<>#!|".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}
fn metadata(info: &AudioInfo, complete: bool, provider: Option<crate::ai::Provider>) -> String {
    let (p_name, model_name) = match provider {
        Some(crate::ai::Provider::Codex) => ("codex", crate::codex_audio::DEFAULT_MODEL),
        _ => ("gemini", crate::gemini_audio::DEFAULT_MODEL),
    };
    let json = serde_json::json!({
        "version": 1,
        "audio": info.name,
        "duration": info.duration,
        "provider": p_name,
        "model": model_name,
        "complete": complete,
        "timing": "segments"
    })
    .to_string()
    .replace('<', "\\u003c")
    .replace('>', "\\u003e");
    format!("<!-- gt:lyd {json} -->\n")
}
fn resume_language(
    current: &mut Option<String>,
    completed: u64,
    language: &str,
) -> Result<(), String> {
    if completed > 0 && current.as_deref() != Some(language) {
        return Err(t!("Fortsæt med samme sprog som de færdige lyddele. Åbn optagelsen igen for at begynde forfra med et andet sprog.", "Continue with the language used for completed segments. Reopen the recording to start over with another language.").to_owned());
    }
    *current = Some(language.to_owned());
    Ok(())
}
#[tauri::command]
pub async fn audio_transcribe(
    app: AppHandle,
    window: tauri::Window,
    id: String,
    language: String,
    progress: tauri::ipc::Channel<Progress>,
) -> Result<String, String> {
    let selected = job(&app, window.label(), &id)?;
    let guard = running(&selected)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let provider = audio_provider(&app);
        if provider != Some(crate::ai::Provider::Gemini) {
            return Err(t!(
                "Den valgte AI-forbindelse kan ikke transskribere lydfiler her endnu.",
                "The selected AI connection cannot transcribe audio files here yet."
            )
            .to_owned());
        }
        *selected.provider.lock().map_err(|_| error())? = provider;
        let info = selected
            .info
            .lock()
            .map_err(|_| error())?
            .clone()
            .ok_or_else(error)?;
        let path = selected.folder.join("audio.wav");
        let (start, bytes) = wav_data(&path)?;
        let mut f = std::fs::File::open(path).map_err(|_| error())?;
        f.seek(SeekFrom::Start(start)).map_err(|_| error())?;
        let total = bytes.div_ceil(32000 * 54);
        let completed = selected.completed.load(Ordering::SeqCst);
        resume_language(
            &mut *selected.language.lock().map_err(|_| error())?,
            completed,
            &language,
        )?;
        let _ = progress.send(Progress {
            done: completed,
            total,
            retry: 0,
            wait_seconds: 0,
        });
        let mut text = if completed == 0 {
            format!("# {}\n\n", t!("Transskription", "Transcript"))
        } else {
            selected.text.lock().map_err(|_| error())?.clone()
        };
        for index in completed..total {
            if selected.cancelled.load(Ordering::SeqCst) {
                break;
            }
            if audio_provider(&app) != provider {
                return Err(t!(
                    "AI-valget er ændret. Transskriptionen er stoppet.",
                    "The AI selection changed. Transcription stopped."
                )
                .to_owned());
            }
            let core = index * 32000 * 54;
            let core_end = (core + 32000 * 54).min(bytes);
            let consumed = core.saturating_sub(32000);
            let size = ((core_end + 32000).min(bytes) - consumed) as usize;
            f.seek(SeekFrom::Start(start + consumed))
                .map_err(|_| error())?;
            let mut pcm = vec![0; size];
            f.read_exact(&mut pcm).map_err(|_| error())?;
            let result = crate::gemini_audio::transcribe_cancellable(
                &wav_block(&pcm),
                (size as u64).div_ceil(32),
                &language,
                &selected.cancelled,
                &|retry, wait_seconds| {
                    let _ = progress.send(Progress {
                        done: index,
                        total,
                        retry,
                        wait_seconds,
                    });
                },
            )?;
            // Stop under et kald: et svar, der allerede er kommet, beholdes (det er færdigt og
            // betalt), og løkken stopper øverst. Er lyden lukket, kasseres det.
            if selected.cancelled.load(Ordering::SeqCst) && !still_open(&app, &selected) {
                break;
            }
            // Segmenter ved pause, talerskift og senest efter 20 sekunder. Tidskoden er første ord.
            let mut words: Vec<&crate::gemini_audio::Word> = Vec::new();
            let flush = |words: &mut Vec<&crate::gemini_audio::Word>, text: &mut String| {
                if let Some(first) = words.first() {
                    let ms = consumed / 32 + first.start_ms;
                    text.push_str(&format!(
                        "[{}]({}#t={:.3})",
                        time(ms),
                        link(&info.name),
                        ms as f64 / 1000.0
                    ));
                    // Taler-id fra separate kald er ikke en identitet på tværs af optagelsen.
                    if let Some(speaker) = &first.speaker {
                        text.push_str(&format!(
                            " **{} {}.{}**",
                            t!("Taler", "Speaker"),
                            index + 1,
                            speaker
                        ));
                    }
                    text.push_str("\n\n");
                    text.push_str(
                        &words
                            .iter()
                            .map(|w| escape_text(&w.text))
                            .collect::<Vec<_>>()
                            .join(" "),
                    );
                    text.push_str("\n\n");
                    words.clear();
                }
            };
            for word in &result.words {
                let absolute = consumed / 32 + word.start_ms;
                if absolute < core / 32 || absolute >= core_end.div_ceil(32) {
                    continue;
                }
                if words.first().is_some_and(|w| {
                    word.start_ms.saturating_sub(w.start_ms) >= 20_000 || word.speaker != w.speaker
                }) || words
                    .last()
                    .is_some_and(|w| word.start_ms.saturating_sub(w.end_ms) > 1500)
                {
                    flush(&mut words, &mut text);
                }
                words.push(word);
            }
            flush(&mut words, &mut text);
            *selected.text.lock().map_err(|_| error())? = text.clone();
            selected.completed.store(index + 1, Ordering::SeqCst);
            let complete = core_end == bytes;
            *selected.transcript.lock().map_err(|_| error())? = Some(format!(
                "{}{}{}",
                metadata(&info, complete, provider),
                if complete {
                    String::new()
                } else {
                    format!(
                        "**{}**\n\n",
                        t!("Ufuldstændig transskription", "Incomplete transcript")
                    )
                },
                text
            ));
            let _ = progress.send(Progress {
                done: index + 1,
                total,
                retry: 0,
                wait_seconds: 0,
            });
            if let Some(snapshot) = selected.transcript.lock().map_err(|_| error())?.as_ref() {
                crate::files::write_atomic(
                    &selected.folder.join("recovery.md"),
                    snapshot.as_bytes(),
                )
                .map_err(|_| error())?;
            }
        }
        selected
            .transcript
            .lock()
            .map_err(|_| error())?
            .clone()
            .ok_or_else(|| {
                t!(
                    "Ingen færdige lyddele endnu.",
                    "No completed audio segments yet."
                )
                .to_owned()
            })
    })
    .await
    .map_err(|_| error())?
}
#[tauri::command]
pub async fn save_transcript(
    app: AppHandle,
    window: tauri::Window,
    id: String,
    elsewhere: Option<bool>,
) -> Result<Option<String>, String> {
    let selected = job(&app, window.label(), &id)?;
    let guard = running(&selected)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let text=selected.transcript.lock().map_err(|_| error())?.clone().ok_or_else(error)?;
        // En færdig tekst kan reddes, selv om kilden er flyttet eller mappen er skrivebeskyttet.
        if elsewhere == Some(true) {
            use tauri_plugin_dialog::DialogExt;
            let picked = app.dialog().file()
                .set_title(t!("Gem transskription", "Save transcript"))
                .set_file_name("Transskription.md")
                .add_filter("Markdown", &["md"])
                .blocking_save_file().and_then(|p| p.into_path().ok());
            let Some(target) = picked else { return Ok(None); };
            crate::files::write_atomic_new(&target, text.as_bytes()).map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    t!("Filen findes allerede. Vælg et nyt navn, så den eksisterende tekst bliver bevaret.", "The file already exists. Choose a new name to keep the existing text.").to_owned()
                } else {
                    t!("Transskriptionen kunne ikke gemmes. Vælg en mappe med plads og skriverettigheder.", "Could not save the transcript. Choose a writable folder with enough space.").to_owned()
                }
            })?;
            let _ = std::fs::remove_file(selected.folder.join("recovery.md"));
            crate::document::choose(&app, &target);
            return Ok(Some(target.to_string_lossy().into_owned()));
        }
        let info=selected.info.lock().map_err(|_| error())?.clone().ok_or_else(error)?;
        if selected.source.canonicalize().map_err(|_| t!("Optagelsen blev ikke fundet. Gem transskriptionen et andet sted.","The recording was not found. Save the transcript elsewhere.").to_owned())?!=selected.source || hash_checked(&selected.source, Some(&selected.cancelled))?!=info.stamp { return Err(t!("Optagelsen er ændret eller flyttet. Vælg den igen.","The recording changed or moved. Select it again.").to_owned()); }
        let parent=selected.source.parent().ok_or_else(error)?;
        let stem=selected.source.file_stem().ok_or_else(error)?.to_string_lossy();
        for n in 1..1000 {
            let name=if n==1 {format!("{stem}.transskription.md")} else {format!("{stem}.transskription-{n}.md")};
            let target=parent.join(name);
            match crate::files::write_atomic_new(&target,text.as_bytes()) {
                Ok(())=>{
                    let _ = std::fs::remove_file(selected.folder.join("recovery.md"));
                    crate::document::choose(&app,&target);
                    return Ok(Some(target.to_string_lossy().into_owned()));
                },
                Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>continue,
                Err(_)=>return Err(t!("Transskriptionen kunne ikke gemmes ved lydfilen. Kontrollér plads og skriverettigheder.","Could not save the transcript beside the audio. Check disk space and write permissions.").to_owned()),
            }
        }
        Err(error())
    }).await.map_err(|_| error())?
}
#[tauri::command]
pub fn transcript_audio(
    app: AppHandle,
    window: tauri::Window,
    doc: String,
    name: String,
) -> Result<String, String> {
    let doc = PathBuf::from(doc);
    if !crate::document::open_paths(&app).contains(&doc)
        || name.is_empty()
        || name.contains(['/', '\\', ':'])
        || name == "."
        || name == ".."
    {
        return Err(error());
    }
    let parent = doc
        .parent()
        .ok_or_else(error)?
        .canonicalize()
        .map_err(|_| error())?;
    let source = parent.join(&name).canonicalize().map_err(|_| {
        t!(
            "Optagelsen blev ikke fundet ved siden af transskriptionen.",
            "The recording was not found beside the transcript."
        )
        .to_owned()
    })?;
    if source.parent() != Some(parent.as_path())
        || !source.extension().is_some_and(|e| {
            EXTENSIONS.contains(&e.to_string_lossy().to_ascii_lowercase().as_str())
        })
    {
        return Err(error());
    }
    register(&app, window.label().to_owned(), source)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn laengden_maa_afvige_3_sekunder_eller_2_procent() {
        assert!(duration_matches(60.0, 62.9));
        assert!(!duration_matches(60.0, 63.5));
        // En time: 2 % er 72 sekunder.
        assert!(duration_matches(3600.0, 3660.0));
        assert!(!duration_matches(3600.0, 3680.0));
        assert!(duration_matches(10.0, 10.0));
    }
    #[test]
    fn genoptagelse_bevarer_sprog_ogsaa_efter_gemning() {
        let mut language = None;
        assert!(resume_language(&mut language, 0, "da").is_ok());
        assert!(resume_language(&mut language, 3, "en").is_err());
        assert_eq!(language.as_deref(), Some("da"));
        assert!(resume_language(&mut language, 3, "da").is_ok());
        assert!(resume_language(&mut language, 0, "en").is_ok());
    }
    #[test]
    fn pcm_rundtur_og_afvisning_af_beskadiget_wav() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let pcm = vec![0; 32000 * 55];
        std::fs::write(&path, wav_block(&pcm)).unwrap();
        assert_eq!(wav_data(&path).unwrap(), (44, pcm.len() as u64));
        std::fs::write(&path, b"broken").unwrap();
        assert!(wav_data(&path).is_err());
    }
    #[test]
    fn noedkopien_foreslaar_optagelsens_navn() {
        let head = r#"<!-- gt:lyd {"version":1,"audio":"møde 3.m4a","duration":12.5} -->"#;
        assert_eq!(
            recovery_name(&format!("{head}\n# Transskription\n")),
            "møde 3.transskription.md"
        );
        let sti = r#"<!-- gt:lyd {"audio":"..\\x.wav"} -->"#;
        assert_eq!(recovery_name(sti), "Transskription.md");
        assert_eq!(recovery_name("# Bare tekst"), "Transskription.md");
    }
    #[test]
    fn links_og_tidskoder_er_sikre_ogsaa_efter_en_time() {
        assert_eq!(time(3_661_500), "01:01:01");
        assert_eq!(link("a [x] æ.wav"), "a%20%5Bx%5D%20%C3%A6.wav");
    }
}
