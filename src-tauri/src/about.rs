//! Om programmet og vejen til Gode Medier (delbar udgave 3/10): version og Windows-version til
//! feedback, og en mail til Gode Medier med emnet udfyldt. Modtageren ligger fast her, så fladen
//! ikke kan bruges til at åbne vilkårlige mailadresser eller programmer.

use serde::Serialize;
use tauri::AppHandle;

pub const FEEDBACK_MAIL: &str = "troels@godemedier.dk";

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub windows: String,
}

/// En tekstværdi fra HKLM, eller tom.
#[cfg(windows)]
fn hklm_string(subkey: &str, value: &str) -> String {
    reg_string(
        windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE,
        subkey,
        value,
    )
}

/// En tekstværdi fra registreringsdatabasen, eller tom.
#[cfg(windows)]
fn reg_string(
    root: windows_sys::Win32::System::Registry::HKEY,
    subkey: &str,
    value: &str,
) -> String {
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (k, v) = (wide(subkey), wide(value));
    let mut buf = [0u16; 128];
    let mut len = (buf.len() * 2) as u32;
    // SAFETY: bufferen og længden passer sammen; Windows skriver højst `len` bytes.
    let ok = unsafe {
        RegGetValueW(
            root,
            k.as_ptr(),
            v.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut len,
        )
    };
    if ok != 0 {
        return String::new();
    }
    let n = (len as usize / 2).saturating_sub(1).min(buf.len());
    String::from_utf16_lossy(&buf[..n])
}

/// Navnet, Office (og dermed Word) skriver som forfatter. Tomt uden Office.
pub fn office_user_name() -> String {
    #[cfg(windows)]
    {
        reg_string(
            windows_sys::Win32::System::Registry::HKEY_CURRENT_USER,
            r"Software\Microsoft\Office\Common\UserInfo",
            "UserName",
        )
        .trim()
        .to_owned()
    }
    #[cfg(not(windows))]
    {
        String::new()
    }
}

/// »Windows 11 24H2 (build 26100)«. Build 22000 og opefter er Windows 11.
pub fn windows_version() -> String {
    #[cfg(windows)]
    {
        let key = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        let build = hklm_string(key, "CurrentBuild");
        let display = hklm_string(key, "DisplayVersion");
        let major = if build.parse::<u32>().unwrap_or(0) >= 22000 {
            "Windows 11"
        } else {
            "Windows 10"
        };
        format!("{major} {display} (build {build})").replace("  ", " ")
    }
    #[cfg(not(windows))]
    {
        t!("ikke Windows", "not Windows").to_owned()
    }
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        windows: windows_version(),
    }
}

/// Procentkodning til en mailto-adresse (RFC 6068): alt uden for de sikre tegn kodes.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn mailto(subject: &str, body: &str) -> String {
    format!(
        "mailto:{FEEDBACK_MAIL}?subject={}&body={}",
        encode(subject),
        encode(body)
    )
}

/// Feedback-knappen og beskeden efter to uger: en mail til Gode Medier med version og Windows
/// udfyldt.
#[tauri::command]
pub fn write_feedback_mail(app: AppHandle, subject: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let info = app_info(app.clone());
    let subject: String = subject.chars().take(120).collect();
    let body = format!(
        "\n\n\n---\nGode Tekster {} · {}\n",
        info.version, info.windows
    );
    app.opener()
        .open_url(mailto(&subject, &body), None::<&str>)
        .map_err(|e| {
            t!(
                format!("Mailprogrammet kunne ikke åbnes. Skriv til {FEEDBACK_MAIL}. ({e})"),
                format!("Your mail program could not be opened. Write to {FEEDBACK_MAIL}. ({e})")
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mailto_er_kodet() {
        let m = mailto("Feedback på Gode Tekster", "Linje\n& mere");
        assert!(m.starts_with(
            "mailto:troels@godemedier.dk?subject=Feedback%20p%C3%A5%20Gode%20Tekster&body="
        ));
        assert!(m.ends_with("Linje%0A%26%20mere"));
    }

    #[test]
    fn windows_version_har_form() {
        let v = windows_version();
        assert!(v.starts_with("Windows 1"), "{v}");
    }
}

/// Licenserne for alt, der følger med (resources/LICENSES.txt, lavet af scripts/licenser.mjs).
/// De ligger også inde i exe'en (190 KB), fordi den flytbare udgave er én fil uden mappe ved siden af.
const LICENSES: &str = include_str!("../resources/LICENSES.txt");

/// Filen ved programmet, eller en kopi i programmets datamappe, når den mangler (flytbar udgave).
fn license_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    if let Ok(dir) = app.path().resource_dir() {
        let file = dir.join("resources").join("LICENSES.txt");
        if file.is_file() {
            return Ok(file);
        }
    }
    let dir = app.path().app_local_data_dir().map_err(|e| {
        t!(
            format!("Programmets datamappe blev ikke fundet: {e}"),
            format!("The app's data folder was not found: {e}")
        )
    })?;
    let file = dir.join("LICENSES.txt");
    std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(&file, LICENSES))
        .map_err(|e| {
            t!(
                format!("Licensfilen kunne ikke lægges frem: {e}"),
                format!("The license file could not be created: {e}")
            )
        })?;
    Ok(file)
}

/// »Licenser« i indstillingerne: filen åbner i Windows' program til tekstfiler (4/10).
#[tauri::command]
pub fn open_licenses(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let file = license_file(&app)?;
    app.opener()
        .open_path(file.to_string_lossy(), None::<&str>)
        .map_err(|e| {
            t!(
                format!("Licensfilen kunne ikke åbnes: {e}"),
                format!("The license file could not be opened: {e}")
            )
        })
}
