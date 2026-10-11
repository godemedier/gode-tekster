//! Start med Windows (ADR-0014, opdateret 11/10): brugerens logon-opgave i Windows Opgavestyring
//! uden delay (afløser HKCU\...\Run, som Windows udskød i op til 59 sekunder).
//! Opgaven kører som den aktuelle bruger med normale rettigheder i den interaktive session.
//! Den flytbare udgave og byggekopier rører aldrig registreringen.

#[cfg(windows)]
const TASK_NAME: &str = "Gode Tekster";

#[cfg(windows)]
fn remove_legacy_run_key() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
    };

    let wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(Some(0))
            .collect()
    };
    let key_path = wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
    let name = wide(TASK_NAME);
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
    if opened == 0 {
        // SAFETY: som ovenfor.
        unsafe { RegDeleteValueW(key, name.as_ptr()) };
        // SAFETY: nøglen blev åbnet ovenfor.
        unsafe { RegCloseKey(key) };
    }
}

#[cfg(windows)]
pub fn task_xml(exe: &std::path::Path, username: &str) -> Vec<u8> {
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
        <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n  \
          <RegistrationInfo>\n    \
            <Description>Start Gode Tekster ved login</Description>\n  \
          </RegistrationInfo>\n  \
          <Triggers>\n    \
            <LogonTrigger>\n      \
              <Enabled>true</Enabled>\n      \
              <UserId>{}</UserId>\n    \
            </LogonTrigger>\n  \
          </Triggers>\n  \
          <Settings>\n    \
            <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n    \
            <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n    \
            <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n    \
            <AllowHardTerminate>true</AllowHardTerminate>\n    \
            <StartWhenAvailable>false</StartWhenAvailable>\n    \
            <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n    \
            <IdleSettings>\n      \
              <Duration>PT10M</Duration>\n      \
              <WaitTimeout>PT1H</WaitTimeout>\n      \
              <StopOnIdleEnd>true</StopOnIdleEnd>\n      \
              <RestartOnIdle>false</RestartOnIdle>\n    \
            </IdleSettings>\n    \
            <AllowStartOnDemand>true</AllowStartOnDemand>\n    \
            <Enabled>true</Enabled>\n    \
            <Hidden>false</Hidden>\n    \
            <RunOnlyIfIdle>false</RunOnlyIfIdle>\n    \
            <WakeToRun>false</WakeToRun>\n    \
            <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n    \
            <Priority>7</Priority>\n  \
          </Settings>\n  \
          <Actions>\n    \
            <Exec>\n      \
              <Command>{}</Command>\n      \
              <Arguments>--skjult</Arguments>\n    \
            </Exec>\n  \
          </Actions>\n\
        </Task>",
        username,
        exe.display()
    );
    let mut bytes = Vec::new();
    for u in xml.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    bytes
}

#[cfg(windows)]
pub fn apply(enabled: bool) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    if is_portable() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    if is_build_copy(&exe) {
        return;
    }

    // Fjern altid den gamle Run-nøgle som migration
    remove_legacy_run_key();

    if enabled {
        let username = std::env::var("USERNAME").unwrap_or_else(|_| "Users".to_owned());
        let xml_data = task_xml(&exe, &username);
        let temp_path = std::env::temp_dir().join(format!("gt-task-{}.xml", std::process::id()));
        if std::fs::write(&temp_path, xml_data).is_ok() {
            let _ = Command::new("schtasks")
                .args([
                    "/Create",
                    "/XML",
                    &temp_path.to_string_lossy(),
                    "/TN",
                    TASK_NAME,
                    "/F",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
            let _ = std::fs::remove_file(&temp_path);
        }
    } else {
        let _ = Command::new("schtasks")
            .args(["/Delete", "/TN", TASK_NAME, "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
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
/// opgaven pege på os.
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

    #[test]
    fn task_xml_opbygning_uden_delay() {
        let exe =
            std::path::Path::new(r"C:\Users\Troels\AppData\Local\Gode Tekster\gode-tekster.exe");
        let bytes = task_xml(exe, "Troels");
        let u16s: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let decoded = String::from_utf16_lossy(&u16s);

        assert!(decoded.contains("<UserId>Troels</UserId>"));
        assert!(decoded.contains(
            r"<Command>C:\Users\Troels\AppData\Local\Gode Tekster\gode-tekster.exe</Command>"
        ));
        assert!(decoded.contains("<Arguments>--skjult</Arguments>"));
        assert!(decoded.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(decoded.contains("<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>"));
        assert!(!decoded.contains("<Delay>"));
    }
}
