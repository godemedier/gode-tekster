//! Højreklik på ikonet på proceslinjen (5/10): stjernemarkerede tekster og de seneste.
//! Windows' egen springliste (`ICustomDestinationList`). Hvert punkt starter programmet med
//! filens sti, og single-instance sender den videre til det kørende program, der åbner teksten.
//! Kun filer, ikke mapper: et klik skal åbne en tekst. Fejl ignoreres og logges; en springliste,
//! der ikke kom op, er ikke en katastrofe.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

/// Højst så mange i hver gruppe. Windows viser alligevel kun en håndfuld.
const MAX: usize = 8;

/// Byg listen igen i baggrunden: stjernemarkerede fra indstillingerne, seneste fra session.rs.
pub fn refresh(app: &AppHandle) {
    // Testkørsler laver ingen springliste, medmindre testen giver en fil med (GT_SPRINGLISTE),
    // der så står som seneste. Brugerens egne seneste og stjerner bruges ikke i en test.
    let test = std::env::var("GT_TEST").is_ok();
    let given = std::env::var("GT_SPRINGLISTE").ok().map(PathBuf::from);
    if test && given.is_none() {
        return;
    }
    let starred: Vec<PathBuf> = if test {
        Vec::new()
    } else {
        crate::settings::load(app)
            .starred
            .into_iter()
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .take(MAX)
            .collect()
    };
    let recent: Vec<PathBuf> = given
        .map(|p| vec![p])
        .unwrap_or_else(|| crate::session::recent(app))
        .into_iter()
        .filter(|p| p.is_file() && !starred.iter().any(|s| same(s, p)))
        .take(MAX)
        .collect();
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        if let Err(e) = build(&exe, &starred, &recent) {
            crate::applog::write(&app, &format!("springliste: {e}"));
        }
    });
}

fn same(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
}

#[cfg(windows)]
fn build(exe: &Path, starred: &[PathBuf], recent: &[PathBuf]) -> windows::core::Result<()> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
    };

    let exe = HSTRING::from(exe.as_os_str());
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| {
            let list: ICustomDestinationList =
                CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            let mut slots = 0u32;
            // Punkter, brugeren selv har fjernet fra listen, må ikke komme igen (ellers afviser
            // Windows hele gruppen).
            let removed: IObjectArray = list.BeginList(&mut slots)?;
            let mut gone: Vec<String> = Vec::new();
            for i in 0..removed.GetCount()? {
                if let Ok(link) = removed.GetAt::<IShellLinkW>(i) {
                    let mut buf = [0u16; 1024];
                    if link.GetArguments(&mut buf).is_ok() {
                        let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                        gone.push(String::from_utf16_lossy(&buf[..n]).to_lowercase());
                    }
                }
            }
            let group = |name: &str, files: &[PathBuf]| -> windows::core::Result<()> {
                let coll: IObjectCollection =
                    CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
                let mut any = false;
                for f in files {
                    let args = format!("\"{}\"", f.display());
                    if gone.contains(&args.to_lowercase()) {
                        continue;
                    }
                    let link: IShellLinkW =
                        CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                    link.SetPath(&exe)?;
                    link.SetArguments(&HSTRING::from(args))?;
                    link.SetIconLocation(&exe, 0)?;
                    link.SetDescription(&HSTRING::from(f.display().to_string()))?;
                    let title = f
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let store: IPropertyStore = link.cast()?;
                    store.SetValue(&PKEY_Title, &PROPVARIANT::from(title.as_str()))?;
                    store.Commit()?;
                    coll.AddObject(&link)?;
                    any = true;
                }
                if any {
                    let arr: IObjectArray = coll.cast()?;
                    list.AppendCategory(&HSTRING::from(name), &arr)?;
                }
                Ok(())
            };
            group(crate::t!("Stjernemarkerede", "Starred"), starred)?;
            group(crate::t!("Seneste", "Recent"), recent)?;
            list.CommitList()
        })();
        CoUninitialize();
        result
    }
}

#[cfg(not(windows))]
fn build(_exe: &Path, _starred: &[PathBuf], _recent: &[PathBuf]) -> Result<(), String> {
    Ok(())
}
