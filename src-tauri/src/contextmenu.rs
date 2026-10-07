//! Højreklik i programmet (2/10): WebView2's egen menu havde browserens punkter som
//! »Skriveretning«, »Flere værktøjer« og »Inspicer«. Kun det, et skriveprogram skal bruge, bliver.

/// Punkterne, der beholdes (WebView2's uoversatte navne: det engelske punkt i camelCase). Alt andet
/// fjernes, også punkter som en senere WebView2 måtte tilføje.
const KEEP: &[&str] = &[
    "cut",
    "copy",
    "paste",
    "pasteAndMatchStyle",
    "selectAll",
    "undo",
    "redo",
    "emoji",
    "spellCheck",
    "copyLinkLocation",
];

pub fn keep(name: &str) -> bool {
    KEEP.contains(&name)
}

/// Hvilke skillestreger skal væk: først, sidst og to i træk. `separators[i]` er sand for en streg.
pub fn stray_separators(separators: &[bool]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut prev_sep = true; // en streg først i menuen er overflødig
    for (i, &sep) in separators.iter().enumerate() {
        if sep && prev_sep {
            out.push(i);
            continue;
        }
        prev_sep = sep;
    }
    // En streg sidst (efter de fjernede) er også overflødig.
    if let Some(last) = (0..separators.len()).rev().find(|i| !out.contains(i)) {
        if separators[last] {
            out.push(last);
        }
    }
    out.sort_unstable();
    out
}

#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    // I testkørsler skrives menuens punkter i loggen (navn og tekst), så filteret kan rettes (5/10).
    {
        use tauri::Manager;
        let _ = LOG_APP.set(window.app_handle().clone());
    }
    let _ = window.with_webview(|wv| {
        use webview2_com::ContextMenuRequestedEventHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11;
        use windows::core::Interface;
        // SAFETY: COM-kald på WebView2's egne objekter på UI-tråden (with_webview kører der).
        unsafe {
            let Ok(core) = wv.controller().CoreWebView2() else {
                return;
            };
            let Ok(core) = core.cast::<ICoreWebView2_11>() else {
                return;
            };
            let handler = ContextMenuRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    prune(&args.MenuItems()?)?;
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_ContextMenuRequested(&handler, &mut token);
        }
    });
}

#[cfg(windows)]
static LOG_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

#[cfg(windows)]
unsafe fn prune(
    items: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuItemCollection,
) -> windows::core::Result<()> {
    use webview2_com::CoTaskMemPWSTR;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
    };
    use windows::core::PWSTR;

    let is_separator = |i: u32| -> windows::core::Result<bool> {
        let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
        unsafe { items.GetValueAtIndex(i)?.Kind(&mut kind)? };
        Ok(kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR)
    };
    let count = |c: &mut u32| unsafe { items.Count(c) };

    let mut n = 0u32;
    count(&mut n)?;
    // Bagfra, så indeksene foran ikke flytter sig.
    for i in (0..n).rev() {
        if is_separator(i)? {
            continue;
        }
        let mut name = PWSTR::null();
        unsafe { items.GetValueAtIndex(i)?.Name(&mut name)? };
        let name = CoTaskMemPWSTR::from(name).to_string();
        if std::env::var("GT_TEST").is_ok() {
            if let Some(app) = LOG_APP.get() {
                let mut label = PWSTR::null();
                let _ = unsafe { items.GetValueAtIndex(i)?.Label(&mut label) };
                let label = CoTaskMemPWSTR::from(label).to_string();
                crate::applog::write(
                    app,
                    &format!(
                        "højreklik: {name} | {label} | {}",
                        if keep(&name) { "beholdes" } else { "fjernes" }
                    ),
                );
            }
        }
        if !keep(&name) {
            unsafe { items.RemoveValueAtIndex(i)? };
        }
    }
    count(&mut n)?;
    let seps = (0..n)
        .map(is_separator)
        .collect::<windows::core::Result<Vec<_>>>()?;
    for i in stray_separators(&seps).into_iter().rev() {
        unsafe { items.RemoveValueAtIndex(i as u32)? };
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browserpunkter_fjernes() {
        assert!(keep("copy") && keep("paste") && keep("spellCheck"));
        assert!(
            !keep("writingDirection")
                && !keep("inspectElement")
                && !keep("moreTools")
                && !keep("print")
        );
    }

    #[test]
    fn overfloedige_skillestreger() {
        // streg, kopiér, streg, streg, sæt ind, streg
        assert_eq!(
            stray_separators(&[true, false, true, true, false, true]),
            vec![0, 3, 5]
        );
        assert_eq!(stray_separators(&[false, true, false]), Vec::<usize>::new());
        assert_eq!(stray_separators(&[]), Vec::<usize>::new());
    }
}
