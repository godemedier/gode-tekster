//! Start med Windows (ADR-0014): en værdi under `HKCU\...\Run`, der starter programmet skjult,
//! så den første åbning efter en genstart også er varm. Ingen plugin: det er én registreringsnøgle.

#[cfg(windows)]
pub fn apply(enabled: bool) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_SET_VALUE, REG_SZ,
    };

    let wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(Some(0))
            .collect()
    };
    // Den flytbare udgave skriver aldrig i Run-nøglen: den kan ligge i Overførsler eller på en
    // USB-nøgle, og deler indstillinger med en installeret kopi, hvis nøgle den ellers ville tage.
    if is_portable() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let key_path = wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let name = wide("Gode Tekster");
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
    if enabled {
        let value = wide(&format!("\"{}\" --skjult", exe.display()));
        let bytes = (value.len() * 2) as u32;
        // SAFETY: som ovenfor; data er en REG_SZ-buffer med nul-terminering.
        unsafe { RegSetValueExW(key, name.as_ptr(), 0, REG_SZ, value.as_ptr().cast(), bytes) };
    } else {
        // SAFETY: som ovenfor.
        unsafe { RegDeleteValueW(key, name.as_ptr()) };
    }
    // SAFETY: nøglen blev åbnet ovenfor.
    unsafe { RegCloseKey(key) };
}

#[cfg(not(windows))]
pub fn apply(_enabled: bool) {}

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
/// nøglen pege på os. Nøglen pegede 4/10 på byggetræets exe (slået til dér før installeren
/// fandtes), og så fik den installerede kopi aldrig sine opdateringer. Byggekopier rører den ikke,
/// så en testkørsel ikke kan tage den tilbage.
pub fn repair(enabled: bool) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    if enabled && !is_build_copy(&exe) {
        apply(true);
    }
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
}
