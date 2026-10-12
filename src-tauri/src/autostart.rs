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

/// Escaper tekst til et XML-element: et brugernavn eller en sti med `&` eller `<` må ikke kunne
/// ødelægge opgavens XML (eller lægge noget ind i den).
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Teksten i det første `<tag>…</tag>` i et XML-dokument (uden attributter på tagget).
fn element_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let len = xml[start..].find(&close)?;
    Some(&xml[start..start + len])
}

/// Brugeren til logon-udløseren. Task Scheduler tager `DOMÆNE\bruger` eller bare `bruger`
/// (LogonTrigger.UserId). Et domænekontos navn alene kan ramme en lokal konto med samme navn,
/// så domænet sættes på, når det ikke bare er maskinens eget navn.
fn user_id(username: &str, domain: Option<&str>, computer: Option<&str>) -> String {
    match domain {
        Some(d) if !d.is_empty() && !computer.is_some_and(|c| c.eq_ignore_ascii_case(d)) => {
            format!("{d}\\{username}")
        }
        _ => username.to_owned(),
    }
}

/// Normal prioritet. 7 (»under normal«) arves af hele bakke-instansen og dens børn (claude.exe,
/// ffmpeg), så alt arbejde i et program startet ved login blev sat bagest i køen.
const TASK_PRIORITY: u8 = 4;

/// Opgavens XML som UTF-16 LE med BOM (FF FE), som `schtasks /XML` forventer.
pub fn task_xml(exe: &std::path::Path, user_id: &str) -> Vec<u8> {
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
            <Priority>{TASK_PRIORITY}</Priority>\n  \
          </Settings>\n  \
          <Actions>\n    \
            <Exec>\n      \
              <Command>{}</Command>\n      \
              <Arguments>--skjult</Arguments>\n    \
            </Exec>\n  \
          </Actions>\n\
        </Task>",
        xml_escape(user_id),
        xml_escape(&exe.to_string_lossy())
    );
    let mut bytes = vec![0xFF, 0xFE];
    for u in xml.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    bytes
}

/// `schtasks /Query /XML` skriver UTF-16 til en fil, men ofte 8-bit tekst til et rør.
fn decode_output(bytes: &[u8]) -> String {
    let utf16 = bytes.starts_with(&[0xFF, 0xFE]) || (bytes.len() > 1 && bytes[1] == 0);
    if utf16 {
        let body = bytes.strip_prefix(&[0xFF, 0xFE]).unwrap_or(bytes);
        let u16s: Vec<u16> = body
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Peger den registrerede opgave allerede på os, med den rigtige prioritet? Så skal den ikke
/// skrives igen ved hver start.
fn task_is_current(query_xml: &str, exe: &std::path::Path) -> bool {
    let command = element_text(query_xml, "Command").map(xml_unescape);
    let priority = element_text(query_xml, "Priority").map(str::trim);
    let ours = exe.to_string_lossy();
    command.is_some_and(|c| c.trim().trim_matches('"').eq_ignore_ascii_case(&ours))
        && priority == Some(TASK_PRIORITY.to_string().as_str())
}

#[cfg(windows)]
fn schtasks(args: &[&str]) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    std::process::Command::new("schtasks")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

/// Første linje af schtasks' fejltekst til loggen.
#[cfg(windows)]
fn first_line(out: &std::process::Output) -> String {
    let text = decode_output(if out.stderr.is_empty() {
        &out.stdout
    } else {
        &out.stderr
    });
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .chars()
        .take(200)
        .collect()
}

/// Den installerede kopi af programmet. Den flytbare udgave og byggekopier rører aldrig opgaven.
#[cfg(windows)]
fn installed_exe() -> Option<std::path::PathBuf> {
    if is_portable() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    (!is_build_copy(&exe)).then_some(exe)
}

#[cfg(windows)]
fn create_task(app: &tauri::AppHandle, exe: &std::path::Path) {
    let Ok(username) = std::env::var("USERNAME") else {
        crate::applog::write(
            app,
            "autostart: USERNAME mangler, opgaven blev ikke oprettet",
        );
        return;
    };
    let domain = std::env::var("USERDOMAIN").ok();
    let computer = std::env::var("COMPUTERNAME").ok();
    let user = user_id(&username, domain.as_deref(), computer.as_deref());
    let temp_path = std::env::temp_dir().join(format!("gt-task-{}.xml", std::process::id()));
    if let Err(e) = std::fs::write(&temp_path, task_xml(exe, &user)) {
        crate::applog::write(
            app,
            &format!("autostart: opgavefilen kunne ikke skrives: {e}"),
        );
        return;
    }
    let result = schtasks(&[
        "/Create",
        "/XML",
        &temp_path.to_string_lossy(),
        "/TN",
        TASK_NAME,
        "/F",
    ]);
    let _ = std::fs::remove_file(&temp_path);
    match result {
        // Først når opgaven findes, må den gamle Run-nøgle væk (migration fra før 11/10).
        Ok(out) if out.status.success() => remove_legacy_run_key(),
        Ok(out) => crate::applog::write(
            app,
            &format!(
                "autostart: schtasks /Create fejlede ({}): {}",
                out.status,
                first_line(&out)
            ),
        ),
        Err(e) => crate::applog::write(app, &format!("autostart: schtasks kunne ikke starte: {e}")),
    }
}

#[cfg(windows)]
pub fn apply(app: &tauri::AppHandle, enabled: bool) {
    let Some(exe) = installed_exe() else {
        return;
    };
    if enabled {
        create_task(app, &exe);
        return;
    }
    remove_legacy_run_key();
    match schtasks(&["/Delete", "/TN", TASK_NAME, "/F"]) {
        Ok(out) if out.status.success() => {}
        Ok(out) => crate::applog::write(
            app,
            &format!("autostart: schtasks /Delete fejlede: {}", first_line(&out)),
        ),
        Err(e) => crate::applog::write(app, &format!("autostart: schtasks kunne ikke starte: {e}")),
    }
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
/// opgaven pege på os. Kører i en baggrundstråd (schtasks tager tid), og opgaven skrives kun
/// igen, når den ikke allerede peger på os med den rigtige prioritet.
pub fn repair(app: &tauri::AppHandle, enabled: bool) {
    if !enabled {
        return;
    }
    #[cfg(windows)]
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let Some(exe) = installed_exe() else {
                return;
            };
            let current = schtasks(&["/Query", "/TN", TASK_NAME, "/XML"]).is_ok_and(|out| {
                out.status.success() && task_is_current(&decode_output(&out.stdout), &exe)
            });
            if current {
                remove_legacy_run_key();
            } else {
                create_task(&app, &exe);
            }
        });
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
    fn task_xml_opbygning_uden_delay() {
        let exe =
            std::path::Path::new(r"C:\Users\Troels\AppData\Local\Gode Tekster\gode-tekster.exe");
        let bytes = task_xml(exe, "Troels");
        assert_eq!(&bytes[..2], &[0xFF, 0xFE], "UTF-16 LE med BOM");
        let decoded = decode_output(&bytes);
        assert!(decoded.starts_with("<?xml"));

        assert!(decoded.contains("<UserId>Troels</UserId>"));
        assert!(decoded.contains("<Priority>4</Priority>"));
        assert!(decoded.contains(
            r"<Command>C:\Users\Troels\AppData\Local\Gode Tekster\gode-tekster.exe</Command>"
        ));
        assert!(decoded.contains("<Arguments>--skjult</Arguments>"));
        assert!(decoded.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(decoded.contains("<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>"));
        assert!(!decoded.contains("<Delay>"));
    }

    #[test]
    fn xml_escapes_navn_og_sti() {
        assert_eq!(
            xml_escape(r#"a&b<c>d"e'f"#),
            "a&amp;b&lt;c&gt;d&quot;e&apos;f"
        );
        let exe = std::path::Path::new(r"C:\Tom & Jerry's <x>\gode-tekster.exe");
        let decoded = decode_output(&task_xml(exe, "Tom&Jerry"));
        assert!(decoded.contains("<UserId>Tom&amp;Jerry</UserId>"));
        assert!(decoded
            .contains(r"<Command>C:\Tom &amp; Jerry&apos;s &lt;x&gt;\gode-tekster.exe</Command>"));
        assert_eq!(
            xml_unescape(&xml_escape(r#"a&b<c>d"e'f&amp;"#)),
            r#"a&b<c>d"e'f&amp;"#
        );
    }

    #[test]
    fn domaene_kun_naar_det_ikke_er_maskinen() {
        assert_eq!(
            user_id("troels", Some("FIRMA"), Some("PC-1")),
            r"FIRMA\troels"
        );
        assert_eq!(user_id("troels", Some("PC-1"), Some("pc-1")), "troels");
        assert_eq!(user_id("troels", None, Some("PC-1")), "troels");
        assert_eq!(user_id("troels", Some(""), None), "troels");
        assert_eq!(user_id("troels", Some("FIRMA"), None), r"FIRMA\troels");
    }

    #[test]
    fn opgaven_skrives_kun_igen_naar_den_er_anderledes() {
        let exe = std::path::Path::new(r"C:\Tom & Co\Gode Tekster\gode-tekster.exe");
        let ours = decode_output(&task_xml(exe, "x"));
        assert!(task_is_current(&ours, exe));
        // Samme sti med andre store bogstaver er samme fil på Windows.
        assert!(task_is_current(
            &ours,
            std::path::Path::new(r"c:\tom & co\gode tekster\GODE-TEKSTER.exe")
        ));
        assert!(!task_is_current(
            &ours,
            std::path::Path::new(r"C:\Andet\gode-tekster.exe")
        ));
        // En gammel opgave med prioritet 7 skal skrives om.
        let old = ours.replace("<Priority>4</Priority>", "<Priority>7</Priority>");
        assert!(!task_is_current(&old, exe));
        assert!(!task_is_current("", exe));
        // 8-bit output fra et rør læses også.
        assert!(task_is_current(&decode_output(ours.as_bytes()), exe));
    }
}
