//! Højreklik i programmet (2/10): WebView2's egen menu havde browserens punkter som
//! »Skriveretning«, »Flere værktøjer« og »Inspicer«. Kun det, et skriveprogram skal bruge, bliver.
//!
//! Fra 9/10 bygges menuen færdig her: lige før den vises, spørges fladen (`window.__gtMenu`,
//! ui/contextMenu.ts), hvad der står under musen. Et fund fra stil- og kommatjekket kommer øverst
//! med sin rettelse. Fladen bestemmer resten: undermenuer (»Formatér«, »AI-hjælp«, »Tabel«,
//! »Tilføj«) og enkelte punkter, lige før »Markér alt«. Stavekontrollens forslag er WebView2's egne.

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
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Environment9, ICoreWebView2_11,
        };
        use windows::core::Interface;
        // SAFETY: COM-kald på WebView2's egne objekter på UI-tråden (with_webview kører der).
        unsafe {
            let Ok(core) = wv.controller().CoreWebView2() else {
                return;
            };
            let Ok(core) = core.cast::<ICoreWebView2_11>() else {
                return;
            };
            // Uden miljø 9 (en gammel WebView2) kan der ikke laves egne punkter: kun oprydningen.
            let env = wv.environment().cast::<ICoreWebView2Environment9>().ok();
            let page = core.clone();
            let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let items = args.MenuItems()?;
                prune(&items)?;
                if let Some(env) = env.as_ref() {
                    ask_page(&page, env, &args, items);
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_ContextMenuRequested(&handler, &mut token);
        }
    });
}

/// Fladens svar (ui/contextMenu.ts). Et punkt uden `id` er en forklaring, der ikke kan vælges.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct PageMenu {
    /// Ordet under musen: er det stavet forkert, kommer forslagene øverst (spelling.rs).
    word: Option<String>,
    finding: Vec<Entry>,
    groups: Vec<Group>,
    plain: Vec<Entry>,
}

#[derive(serde::Deserialize)]
struct Group {
    label: String,
    items: Vec<Entry>,
}

#[derive(serde::Deserialize)]
struct Entry {
    id: Option<String>,
    label: Option<String>,
    checked: Option<bool>,
    sep: Option<bool>,
}

/// Spørg fladen, mens menuen venter (deferral), og byg punkterne af svaret. Fejler noget, vises
/// menuen bare uden dem.
#[cfg(windows)]
unsafe fn ask_page(
    page: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11,
    env: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment9,
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuRequestedEventArgs,
    items: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuItemCollection,
) {
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::HSTRING;
    // SAFETY: som i `install`; alt kører på UI-tråden.
    unsafe {
        let Ok(deferral) = args.GetDeferral() else {
            return;
        };
        let (page2, env2, deferral2) = (page.clone(), env.clone(), deferral.clone());
        let done = ExecuteScriptCompletedHandler::create(Box::new(move |_, json| {
            // ExecuteScript svarer med JSON for værdien, og værdien er selv JSON-tekst.
            let menu = serde_json::from_str::<Option<String>>(&json)
                .ok()
                .flatten()
                .and_then(|text| serde_json::from_str::<PageMenu>(&text).ok())
                .unwrap_or_default();
            let _ = build(&page2, &env2, &items, &menu);
            deferral2.Complete()?;
            Ok(())
        }));
        let script = HSTRING::from("window.__gtMenu ? window.__gtMenu.context() : null");
        if page.ExecuteScript(&script, &done).is_err() {
            let _ = deferral.Complete();
        }
    }
}

/// Fundet øverst, undermenuerne og de enkelte punkter lige før »Markér alt«, og så de overflødige
/// streger væk.
#[cfg(windows)]
unsafe fn build(
    page: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11,
    env: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment9,
    items: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuItemCollection,
    menu: &PageMenu,
) -> windows::core::Result<()> {
    use webview2_com::CoTaskMemPWSTR;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU;
    use windows::core::{HSTRING, PWSTR};
    // SAFETY: som i `install`.
    unsafe {
        let mut top = Vec::new();
        if let Some(word) = menu.word.as_deref() {
            if let Some(suggestions) = crate::spelling::word_status(word) {
                if suggestions.is_empty() {
                    top.push(command(
                        env,
                        crate::t!("Ingen forslag", "No suggestions"),
                        None,
                        None,
                    )?);
                }
                for s in suggestions {
                    let page = page.clone();
                    let json = serde_json::to_string(&s).unwrap_or_else(|_| "\"\"".to_owned());
                    top.push(command(env, &s, None, Some(Box::new(move || {
                        let script = HSTRING::from(format!("window.__gtMenu && window.__gtMenu.replaceWord({json})"));
                        let _ = page.ExecuteScript(&script, None::<&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ExecuteScriptCompletedHandler>);
                    })))?);
                }
                let word = word.to_owned();
                top.push(command(
                    env,
                    crate::t!("Tilføj til ordbog", "Add to dictionary"),
                    None,
                    Some(Box::new(move || {
                        let _ = crate::spelling::add_word(&word);
                    })),
                )?);
                top.push(separator(env)?);
            }
        }
        for e in &menu.finding {
            top.push(item(page, env, e)?);
        }
        if !menu.finding.is_empty() {
            top.push(separator(env)?);
        }
        for (i, it) in top.iter().enumerate() {
            items.InsertValueAtIndex(i as u32, it)?;
        }
        let mut subs = Vec::new();
        for group in &menu.groups {
            if group.items.is_empty() {
                continue;
            }
            let sub = env.CreateContextMenuItem(
                &HSTRING::from(group.label.as_str()),
                None::<&windows::Win32::System::Com::IStream>,
                COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU,
            )?;
            let children = sub.Children()?;
            for (i, e) in group.items.iter().enumerate() {
                children.InsertValueAtIndex(i as u32, &item(page, env, e)?)?;
            }
            subs.push(sub);
        }
        for e in &menu.plain {
            subs.push(item(page, env, e)?);
        }
        if !subs.is_empty() {
            // Før »Markér alt«, eller sidst, hvis den ikke er der.
            let mut n = 0u32;
            items.Count(&mut n)?;
            let mut at = n;
            for i in 0..n {
                let mut name = PWSTR::null();
                items.GetValueAtIndex(i)?.Name(&mut name)?;
                if CoTaskMemPWSTR::from(name).to_string() == "selectAll" {
                    at = i;
                    break;
                }
            }
            items.InsertValueAtIndex(at, &separator(env)?)?;
            for (k, sub) in subs.iter().enumerate() {
                items.InsertValueAtIndex(at + 1 + k as u32, sub)?;
            }
            items.InsertValueAtIndex(at + 1 + subs.len() as u32, &separator(env)?)?;
        }
        tidy_separators(items)
    }
}

#[cfg(windows)]
unsafe fn separator(
    env: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment9,
) -> windows::core::Result<
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuItem,
> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR;
    // SAFETY: som i `install`.
    unsafe {
        env.CreateContextMenuItem(
            &windows::core::HSTRING::new(),
            None::<&windows::Win32::System::Com::IStream>,
            COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        )
    }
}

/// Et punkt med en handling her i Rust. Uden handling kan det ikke vælges (en forklaring).
#[cfg(windows)]
unsafe fn command(
    env: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment9,
    label: &str,
    checked: Option<bool>,
    on_select: Option<Box<dyn FnMut()>>,
) -> windows::core::Result<
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuItem,
> {
    use webview2_com::CustomItemSelectedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_CHECK_BOX, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
    };
    use windows::core::HSTRING;
    // SAFETY: som i `install`.
    unsafe {
        let kind = if checked.is_some() {
            COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_CHECK_BOX
        } else {
            COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND
        };
        let it = env.CreateContextMenuItem(
            &HSTRING::from(label),
            None::<&windows::Win32::System::Com::IStream>,
            kind,
        )?;
        if let Some(c) = checked {
            it.SetIsChecked(c)?;
        }
        let Some(mut run) = on_select else {
            it.SetIsEnabled(false)?;
            return Ok(it);
        };
        let handler = CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
            run();
            Ok(())
        }));
        let mut token = 0i64;
        it.add_CustomItemSelected(&handler, &mut token)?;
        Ok(it)
    }
}

/// Et punkt fra fladen. Vælges det, kører fladen handlingen (`window.__gtMenu.run(id)`).
#[cfg(windows)]
unsafe fn item(
    page: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11,
    env: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment9,
    e: &Entry,
) -> windows::core::Result<
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuItem,
> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ExecuteScriptCompletedHandler;
    use windows::core::HSTRING;
    // SAFETY: som i `install`.
    unsafe {
        if e.sep == Some(true) {
            return separator(env);
        }
        let label = e.label.as_deref().unwrap_or_default();
        let Some(id) = e.id.clone() else {
            return command(env, label, e.checked, None);
        };
        let page = page.clone();
        command(
            env,
            label,
            e.checked,
            Some(Box::new(move || {
                // Id'et er fladens eget tal, men sendes som JSON-streng, så intet kan bryde ud af kaldet.
                let id = serde_json::to_string(&id).unwrap_or_else(|_| "\"\"".to_owned());
                let script = HSTRING::from(format!("window.__gtMenu && window.__gtMenu.run({id})"));
                let _ = page
                    .ExecuteScript(&script, None::<&ICoreWebView2ExecuteScriptCompletedHandler>);
            })),
        )
    }
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
    tidy_separators(items)
}

/// Streger først, sidst og to i træk fjernes.
#[cfg(windows)]
unsafe fn tidy_separators(
    items: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuItemCollection,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
    };
    let mut n = 0u32;
    // SAFETY: som i `install`.
    unsafe { items.Count(&mut n)? };
    let seps = (0..n)
        .map(|i| {
            let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
            // SAFETY: som i `install`.
            unsafe { items.GetValueAtIndex(i)?.Kind(&mut kind)? };
            Ok(kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR)
        })
        .collect::<windows::core::Result<Vec<_>>>()?;
    for i in stray_separators(&seps).into_iter().rev() {
        // SAFETY: som i `install`.
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
