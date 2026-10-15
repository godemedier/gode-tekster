//! Start med Windows (ADR-0014, tilbage til Run-nøglen 15/10): en værdi under
//! `HKCU\...\Run`, der starter programmet skjult, så den første åbning efter en genstart er varm.
//!
//! 11/10 blev det en logon-opgave i Opgavestyring, fordi Windows kan udskyde Run-nøglen op til et
//! minut. 15/10 fjernede Microsoft Defender programmet lige efter en opdatering
//! (`Behavior:Win32/Persistence.A!ml`): en usigneret exe, der opretter en planlagt opgave med
//! schtasks, ligner skadelig software. Run-nøglen har Defender accepteret siden 3/10. Nøglen
//! skrives kun, når den mangler eller peger forkert, og en gammel opgave fjernes samme gang.
//! Den flytbare udgave og byggekopier rører aldrig registreringen.

#[cfg(windows)]
const NAME: &str = "Gode Tekster";

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

/// Værdien i Run-nøglen: programmet i anførselstegn og `--skjult`.
fn run_value(exe: &std::path::Path) -> String {
    format!("\"{}\" --skjult", exe.display())
}

/// Run-nøglens nuværende værdi for programmet, hvis der er en.
#[cfg(windows)]
fn read_run_value() -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let key_path = wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let name = wide(NAME);
    let mut buf = vec![0u16; 1024];
    let mut bytes = (buf.len() * 2) as u32;
    // SAFETY: nul-terminerede UTF-16-strenge og en buffer, hvis størrelse står i `bytes`.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key_path.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if status != 0 {
        return None;
    }
    let len = (bytes as usize / 2).saturating_sub(1).min(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

/// Skriv eller slet programmets værdi i Run-nøglen.
#[cfg(windows)]
fn write_run_value(value: Option<&str>) {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_SET_VALUE, REG_SZ,
    };
    let key_path = wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let name = wide(NAME);
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: nul-terminerede UTF-16-strenge, der lever hele kaldet; nøglen lukkes nedenfor.
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path.as_ptr(),
            0,
            KEY_SET_VALUE,
            &mut key,
        )
    };
    if opened != 0 {
        return;
    }
    match value {
        Some(v) => {
            let data = wide(v);
            let bytes = (data.len() * 2) as u32;
            // SAFETY: som ovenfor; data er en nul-termineret REG_SZ-buffer.
            unsafe { RegSetValueExW(key, name.as_ptr(), 0, REG_SZ, data.as_ptr().cast(), bytes) };
        }
        // SAFETY: som ovenfor.
        None => unsafe {
            RegDeleteValueW(key, name.as_ptr());
        },
    }
    // SAFETY: nøglen blev åbnet ovenfor.
    unsafe { RegCloseKey(key) };
}

/// Logon-opgaven fra 11/10-15/10 fjernes. Fejl betyder som regel bare, at den ikke findes.
#[cfg(windows)]
fn remove_old_task() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let _ = std::process::Command::new("schtasks")
        .args(["/Delete", "/TN", NAME, "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

/// Den installerede kopi af programmet. Den flytbare udgave og byggekopier rører aldrig nøglen.
#[cfg(windows)]
fn installed_exe() -> Option<std::path::PathBuf> {
    if is_portable() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    (!is_build_copy(&exe)).then_some(exe)
}

/// Indstillingen er ændret: skriv eller fjern nøglen.
#[cfg(windows)]
pub fn apply(_app: &tauri::AppHandle, enabled: bool) {
    let Some(exe) = installed_exe() else {
        return;
    };
    if enabled {
        write_run_value(Some(&run_value(&exe)));
    } else {
        write_run_value(None);
    }
    remove_old_task();
}

#[cfg(not(windows))]
pub fn apply(_app: &tauri::AppHandle, _enabled: bool) {}

/// Startet ved login: vis ikke vinduet, vent på en fil eller et klik på ikonet.
pub fn started_hidden() -> bool {
    std::env::args().any(|a| a == "--skjult")
}

/// Kørt fra et byggetræ (`target\debug` eller `target\release`)? Så er det en udviklings- eller
/// testkopi, ikke den installerede.
fn is_build_copy(exe: &std::path::Path) -> bool {
    exe.components()
        .any(|c| c.as_os_str().eq_ignore_ascii_case("target"))
}

/// Den flytbare udgave (5/10): exe'en kører fra en mappe uden installer, så der ligger
/// ingen `uninstall.exe` ved siden af. Byggekopier tæller ikke med.
pub fn is_portable() -> bool {
    std::env::current_exe().is_ok_and(|exe| {
        !is_build_copy(&exe)
            && exe
                .parent()
                .is_some_and(|d| !d.join("uninstall.exe").exists())
    })
}

/// Til fladen: indstillingen »Start med Windows« vises ikke i den flytbare udgave.
#[tauri::command]
pub fn portable() -> bool {
    is_portable()
}

/// Ved start: er »Start med Windows« slået til, og kører vi som den installerede kopi, så skal
/// nøglen pege på os. Den skrives kun, når den mangler eller peger forkert (første start efter en
/// opdatering), og den gamle logon-opgave fjernes samme gang. Ellers rører programmet intet.
pub fn repair(app: &tauri::AppHandle, enabled: bool) {
    if !enabled {
        return;
    }
    #[cfg(windows)]
    {
        let Some(exe) = installed_exe() else {
            return;
        };
        let wanted = run_value(&exe);
        if read_run_value().as_deref() == Some(wanted.as_str()) {
            return;
        }
        write_run_value(Some(&wanted));
        crate::applog::write(app, "autostart: Run-nøglen skrevet");
        std::thread::spawn(remove_old_task);
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byggekopier_genkendes() {
        assert!(is_build_copy(std::path::Path::new(
            r"C:\dev\gode-tekster\src-tauri\target\release\gode-tekster.exe"
        )));
        assert!(!is_build_copy(std::path::Path::new(
            r"C:\Users\x\AppData\Local\Gode Tekster\gode-tekster.exe"
        )));
    }

    #[test]
    fn run_vaerdien_citerer_stien_og_starter_skjult() {
        let exe = std::path::Path::new(r"C:\Users\kim\AppData\Local\Gode Tekster\gode-tekster.exe");
        assert_eq!(
            run_value(exe),
            r#""C:\Users\kim\AppData\Local\Gode Tekster\gode-tekster.exe" --skjult"#
        );
    }
}
