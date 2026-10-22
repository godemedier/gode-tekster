//! Opdatering uden bokse (delbar udgave 3/10). Programmet spørger
//! `tekster.godemedier.dk` 15 sekunder efter start og derefter hver sjette time, henter en ny
//! version i baggrunden, efterprøver signaturen og lægger installeren klar. Den kører stille
//! (`/S /UPDATE`), når programmet afsluttes, eller med det samme ved »Genstart nu« (`/R` starter
//! programmet igen bagefter). Fladen viser én diskret linje, ingen dialog.
//!
//! Bygget på ureq og minisign-verify i stedet for tauri-plugin-updater, der ville trække et ekstra
//! netværkslag (reqwest, rustls, ring) ind i et program, der skal fylde så lidt som muligt.
//! Manifestet har samme form som Tauris, så der kan skiftes senere uden at røre serveren.
//!
//! Den flytbare udgave (5/10) har sin egen post i manifestet (`windows-x86_64-portable`): den
//! henter den nye exe, og ved afslutning flyttes den gamle til side og den nye lægges i stedet.
//!
//! Hvad serveren ser: programmets version og computerens IP-adresse (som ved ethvert opslag).
//! Ingen tekst, intet navn. Kan slås fra under Indstillinger.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

pub const MANIFEST_URL: &str = "https://tekster.godemedier.dk/opdatering/latest.json";
/// Kun installere herfra hentes (ingen omdirigering ud af huset).
const DOWNLOAD_PREFIX: &str = "https://tekster.godemedier.dk/";
/// Offentlig nøgle (minisign, base64 som i Tauri). Den private ligger i `.updater/`, aldrig i git.
const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQzMjAyMjQ0MzM3MTAzMEEKUldRS0EzRXpSQ0lnUTduL2VXcWtudWk0TGs1NTh5YVdyVFpkL0JVeGszeGVSa09lTWpIVUdmTSsK";

#[derive(Deserialize)]
struct Manifest {
    version: String,
    platforms: std::collections::HashMap<String, Platform>,
}

#[derive(Deserialize)]
struct Platform {
    url: String,
    signature: String,
}

struct Ready {
    version: String,
    installer: PathBuf,
}

static READY: Mutex<Option<Ready>> = Mutex::new(None);
/// »Genstart nu«: start programmet igen efter installationen.
static RESTART: Mutex<bool> = Mutex::new(false);

/// Er der en nyere version end vores i manifestet? Returnerer (version, url, signatur).
fn newer(manifest: &str, current: &str, platform: &str) -> Option<(String, String, String)> {
    let m: Manifest = serde_json::from_str(manifest).ok()?;
    let theirs = semver::Version::parse(m.version.trim_start_matches('v')).ok()?;
    let ours = semver::Version::parse(current).ok()?;
    if theirs <= ours {
        return None;
    }
    let p = m.platforms.get(platform)?;
    p.url
        .starts_with(DOWNLOAD_PREFIX)
        .then(|| (m.version.clone(), p.url.clone(), p.signature.clone()))
}

/// Signaturen er base64 af en minisign-signaturfil (sådan som `tauri signer sign` laver den).
/// Returnerer den betroede kommentar, som signaturen også dækker.
fn verify(bytes: &[u8], signature_b64: &str) -> Result<String, String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let key_text = String::from_utf8(b64.decode(PUBLIC_KEY).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let sig_text = String::from_utf8(
        b64.decode(signature_b64.trim())
            .map_err(|_| "signaturen kunne ikke læses")?,
    )
    .map_err(|e| e.to_string())?;
    let key = minisign_verify::PublicKey::decode(&key_text).map_err(|e| e.to_string())?;
    let sig = minisign_verify::Signature::decode(&sig_text).map_err(|e| e.to_string())?;
    key.verify(bytes, &sig, false)
        .map_err(|_| "signaturen passer ikke".to_owned())?;
    Ok(sig.trusted_comment().to_owned())
}

/// `tauri signer sign` skriver filens navn i den betroede kommentar (`file:Gode-Tekster_0.2.21_x64-
/// setup.exe`), og den er signeret med. Navnet skal passe til den version og udgave, manifestet
/// lover. Ellers kunne en overtaget server lægge en gammel, ægte signeret version frem som ny, eller
/// en installer i stedet for den flytbare exe (kodegennemgang 20/10).
fn signed_for(comment: &str, version: &str, kind: &str) -> Result<(), String> {
    let version = version.trim_start_matches('v');
    let expected = format!("file:Gode-Tekster_{version}_x64-{kind}.exe");
    if comment.split('\t').any(|field| field.trim() == expected) {
        Ok(())
    } else {
        Err("signaturen hører til en anden version eller udgave".to_owned())
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(300)))
        .user_agent(concat!("GodeTekster/", env!("CARGO_PKG_VERSION")))
        .tls_config(crate::net::tls_config())
        .build()
        .into()
}

/// Ét tjek: hent manifestet, og er der en nyere version, så hent, efterprøv og læg den klar.
fn check(app: &AppHandle) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    let agent = agent();
    let manifest = agent
        .get(MANIFEST_URL)
        .call()
        .map_err(|e| format!("manifest: {e}"))?
        .body_mut()
        .with_config()
        .limit(64 * 1024)
        .read_to_string()
        .map_err(|e| format!("manifest: {e}"))?;
    let portable = crate::autostart::is_portable();
    let platform = if portable {
        "windows-x86_64-portable"
    } else {
        "windows-x86_64"
    };
    let Some((version, url, signature)) = newer(&manifest, &current, platform) else {
        return Ok(());
    };
    if READY
        .lock()
        .map(|r| r.as_ref().is_some_and(|r| r.version == version))
        .unwrap_or(false)
    {
        return Ok(());
    }
    let bytes = agent
        .get(&url)
        .call()
        .map_err(|e| format!("hent: {e}"))?
        .body_mut()
        .with_config()
        .limit(100 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| format!("hent: {e}"))?;
    let kind = if portable { "portable" } else { "setup" };
    let comment = verify(&bytes, &signature)?;
    signed_for(&comment, &version, kind)?;
    let installer = std::env::temp_dir().join(format!("gode-tekster-{version}-{kind}.exe"));
    crate::files::write_atomic(&installer, &bytes).map_err(|e| e.to_string())?;
    crate::applog::write(app, &format!("opdatering {version} hentet og efterprøvet"));
    if let Ok(mut r) = READY.lock() {
        *r = Some(Ready {
            version: version.clone(),
            installer,
        });
    }
    let _ = app.emit("update-ready", version);
    Ok(())
}

/// Starter i baggrunden ved opstart. Ikke i testkørsler, udviklingsbyg eller når det er slået fra.
pub fn start(app: &AppHandle) {
    // Den gamle exe fra sidste opdatering af den flytbare udgave (replace_self).
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(exe.with_extension("exe.old"));
    }
    if cfg!(debug_assertions) || std::env::var("GT_TEST").is_ok() {
        return;
    }
    let app = app.clone();
    // Første tjek 15 s efter start (før: 2 minutter, 13/10), når vinduerne er oppe. Startes
    // programmet ved login, er nettet ikke altid klar endnu: et fejlet tjek prøves igen efter 10
    // minutter i stedet for at vente seks timer.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        loop {
            let mut wait = 6 * 60 * 60;
            if crate::settings::load(&app).check_updates {
                if let Err(e) = check(&app) {
                    crate::applog::write(&app, &format!("opdatering: {e}"));
                    wait = 10 * 60;
                }
            }
            std::thread::sleep(Duration::from_secs(wait));
        }
    });
}

/// Til fladen ved start (et nyt vindue skal også vise linjen): versionen, der ligger klar.
#[tauri::command]
pub fn update_ready() -> Option<String> {
    READY
        .lock()
        .ok()
        .and_then(|r| r.as_ref().map(|r| r.version.clone()))
}

/// »Genstart nu«: alle vinduer gemmer, programmet afslutter, og installeren starter det igen.
#[tauri::command]
pub fn install_update_now(app: AppHandle) {
    if let Ok(mut r) = RESTART.lock() {
        *r = true;
    }
    crate::windows::request_quit(app, None);
}

/// Afslutningen blev aflyst: næste Afslut installerer stille uden at genstarte.
pub fn cancel_restart() {
    if let Ok(mut r) = RESTART.lock() {
        *r = false;
    }
}

/// Kaldes, når programmet afslutter. Ligger en efterprøvet installer klar, kører den stille.
pub fn install_on_exit(app: &AppHandle) {
    let Some(ready) = READY.lock().ok().and_then(|mut r| r.take()) else {
        return;
    };
    let restart = RESTART.lock().map(|r| *r).unwrap_or(false);
    if crate::autostart::is_portable() {
        return replace_self(app, &ready, restart);
    }
    let mut cmd = std::process::Command::new(&ready.installer);
    cmd.args(["/S", "/UPDATE"]);
    if restart {
        cmd.arg("/R");
    }
    match cmd.spawn() {
        Ok(_) => crate::applog::write(app, &format!("opdatering {} installeres", ready.version)),
        Err(e) => crate::applog::write(app, &format!("FEJL opdatering kunne ikke starte: {e}")),
    }
}

/// Den flytbare udgave: en kørende exe kan omdøbes i Windows, men ikke overskrives. Den gamle
/// flyttes til side (`.exe.old`, ryddes ved næste start), og den nye kopieres ind på dens plads.
/// Går kopieringen galt, flyttes den gamle tilbage, så der altid ligger et program.
fn replace_self(app: &AppHandle, ready: &Ready, restart: bool) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let old = exe.with_extension("exe.old");
    let _ = std::fs::remove_file(&old);
    if let Err(e) = std::fs::rename(&exe, &old) {
        return crate::applog::write(
            app,
            &format!("FEJL opdatering: exe'en kunne ikke flyttes: {e}"),
        );
    }
    if let Err(e) = std::fs::copy(&ready.installer, &exe) {
        let _ = std::fs::rename(&old, &exe);
        return crate::applog::write(
            app,
            &format!("FEJL opdatering: den nye exe kunne ikke lægges ind: {e}"),
        );
    }
    let _ = std::fs::remove_file(&ready.installer);
    crate::applog::write(
        app,
        &format!("opdatering {} lagt ind (flytbar udgave)", ready.version),
    );
    if restart {
        // Venter et øjeblik ved start, så single-instance ikke sender den videre til os (lib.rs).
        let _ = std::process::Command::new(&exe).arg(AFTER_UPDATE).spawn();
    }
}

/// Argumentet, en genstartet flytbar udgave får: vent, til den gamle proces er væk.
pub const AFTER_UPDATE: &str = "--efter-opdatering";

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(version: &str, url: &str) -> String {
        format!(
            r#"{{"version":"{version}","notes":"","pub_date":"2026-10-03T12:00:00Z",
            "platforms":{{"windows-x86_64":{{"url":"{url}","signature":"x"}}}}}}"#
        )
    }

    #[test]
    fn kun_nyere_versioner_fra_huset() {
        let url = "https://tekster.godemedier.dk/hent/a.exe";
        let w = "windows-x86_64";
        assert!(newer(&manifest("0.1.1", url), "0.1.0", w).is_some());
        assert!(newer(&manifest("v0.2.0", url), "0.1.0", w).is_some());
        assert!(newer(&manifest("0.1.0", url), "0.1.0", w).is_none());
        assert!(newer(&manifest("0.0.9", url), "0.1.0", w).is_none());
        assert!(newer(&manifest("0.2.0", "https://andet.dk/a.exe"), "0.1.0", w).is_none());
        assert!(newer("ikke json", "0.1.0", w).is_none());
        // Et manifest uden den flytbare udgave giver ingen opdatering til den.
        assert!(newer(&manifest("0.1.1", url), "0.1.0", "windows-x86_64-portable").is_none());
    }

    #[test]
    fn signaturen_skal_passe_til_version_og_udgave() {
        let c = "timestamp:1792498848	file:Gode-Tekster_0.2.21_x64-setup.exe";
        assert!(signed_for(c, "0.2.21", "setup").is_ok());
        assert!(signed_for(c, "v0.2.21", "setup").is_ok());
        assert!(
            signed_for(c, "0.2.22", "setup").is_err(),
            "en gammel version som ny"
        );
        assert!(
            signed_for(c, "0.2.21", "portable").is_err(),
            "installeren som flytbar exe"
        );
    }

    #[test]
    fn falsk_signatur_afvises() {
        assert!(verify(b"installer", "ikke base64 !!").is_err());
        let fake = base64::engine::general_purpose::STANDARD.encode(
            "untrusted comment: x\nRUQKA3EzRCIgQ7n/eWqknui4Lk558yaWrTZd/BUx\ntrusted comment: y\nAAAA\n",
        );
        assert!(verify(b"installer", &fake).is_err());
    }

    /// Ægte signatur lavet med projektets nøgle: `tauri signer sign` på en fil med teksten
    /// »Gode Tekster«. Kører kun, når signaturfilen findes (den laves af udgivelsesscriptets test).
    #[test]
    fn aegte_signatur_godtages() {
        let sig =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.updater/proeve.txt.sig");
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.updater/proeve.txt");
        let (Ok(sig), Ok(bytes)) = (std::fs::read_to_string(sig), std::fs::read(&file)) else {
            return;
        };
        assert!(verify(&bytes, &sig).is_ok());
        assert!(verify(b"noget andet", &sig).is_err());
    }
}
