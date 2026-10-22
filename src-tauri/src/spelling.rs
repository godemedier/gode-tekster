//! Stavekontrollen (ADR-0063). Dansk med Hunspell 1.7.5 (`vendor/hunspell`, bygget i build.rs) og
//! Stavekontroldens ordbog da_DK (`resources/ordbog`). Windows' egen stavekontrol (ISpellChecker)
//! kendte ikke »skriveprogram« og godkendte opdigtede sammensætninger som »skrivedrogram«.
//!
//! Windows bruges stadig til engelsk (engelsk brugerflade) og som reserve, hvis den danske ordbog
//! ikke kan indlæses (fx den flytbare udgave, der er én exe uden mappen med ordbogen). Windows'
//! danske forslag fylder op, når Hunspell har få, men kun dem, Hunspell selv godkender.
//!
//! Brugerens egen ordbog er `<data>\ordbog.txt` (ét ord pr. linje, UTF-8). Første gang hentes ordene
//! fra Windows' danske brugerordbog og iA Writers ordbog ind, hvis de findes.
//!
//! Positionerne er i UTF-16-enheder ligesom JavaScript-strenge, så fladen kan bruge dem direkte.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError, TryLockError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize)]
pub struct SpellError {
    pub from: u32,
    pub to: u32,
    pub word: String,
    /// Forslag, bedste først (højst fem). Tom streng = slet (et ord, der står to gange).
    pub suggestions: Vec<String>,
}

/// Højst så mange forslag.
const MAX_SUGGESTIONS: usize = 5;

/// Højreklik bygger menuen på vinduets egen tråd. Den venter højst så længe på den danske
/// stavekontrol, ellers fryser vinduet, mens fanen Sprog tjekker en lang tekst (gennemgang 22/10).
const MENU_WAIT: Duration = Duration::from_millis(150);

/// Så mange ord ad gangen i `check`. Låsen slippes mellem bidderne, så højreklik og stregerne kan
/// komme til.
const CHECK_CHUNK: usize = 500;

// --- Hunspell ------------------------------------------------------------------------------------

mod ffi {
    use std::ffi::{c_char, c_int};

    /// Hunspells eget objekt. Kun som peger.
    #[repr(C)]
    pub struct Hunhandle {
        _private: [u8; 0],
    }

    extern "C" {
        pub fn Hunspell_create(affpath: *const c_char, dpath: *const c_char) -> *mut Hunhandle;
        pub fn Hunspell_destroy(h: *mut Hunhandle);
        pub fn Hunspell_spell(h: *mut Hunhandle, word: *const c_char) -> c_int;
        pub fn Hunspell_get_dic_encoding(h: *mut Hunhandle) -> *mut c_char;
        pub fn Hunspell_suggest(
            h: *mut Hunhandle,
            slst: *mut *mut *mut c_char,
            word: *const c_char,
        ) -> c_int;
        pub fn Hunspell_free_list(h: *mut Hunhandle, slst: *mut *mut *mut c_char, n: c_int);
        pub fn Hunspell_add(h: *mut Hunhandle, word: *const c_char) -> c_int;
    }
}

/// Én Hunspell med én ordbog. Ordene er UTF-8 (ordbogen har `SET UTF-8`, tjekket i `open`).
pub struct Hunspell {
    handle: std::ptr::NonNull<ffi::Hunhandle>,
}

// SAFETY: objektet er ikke bundet til en bestemt tråd, men er heller ikke trådsikkert. Alle metoder
// tager `&mut self`, så Rust sikrer, at kun én tråd bruger det ad gangen (i programmet bag `DANISH`).
unsafe impl Send for Hunspell {}

/// Hunspell har global tilstand i C++ (tegntabellerne i csutil.cxx), som oprettes og nedlægges uden
/// lås. Programmet har kun ét objekt, men låsen gør det sikkert uanset, også i testene.
static FFI: Mutex<()> = Mutex::new(());

fn ffi_lock() -> std::sync::MutexGuard<'static, ()> {
    FFI.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Hunspell {
    pub fn open(aff: &Path, dic: &Path) -> Result<Self, String> {
        let failed = |why: String| {
            t!(
                format!("Den danske ordbog kunne ikke indlæses: {why}"),
                format!("The Danish dictionary could not be loaded: {why}")
            )
        };
        let aff = c_path(aff).map_err(failed)?;
        let dic = c_path(dic).map_err(failed)?;
        let raw = {
            let _ffi = ffi_lock();
            // SAFETY: begge stier er gyldige, nul-afsluttede strenge, der lever under kaldet.
            unsafe { ffi::Hunspell_create(aff.as_ptr(), dic.as_ptr()) }
        };
        let handle = std::ptr::NonNull::new(raw).ok_or_else(|| failed("Hunspell".to_owned()))?;
        let mut me = Self { handle };
        // Kan filerne ikke læses, giver Hunspell et tomt objekt uden fejl. Tegnsættet og et
        // almindeligt ord afslører det.
        if me.encoding() != "UTF-8" || !me.spell("og") {
            return Err(failed("da_DK.aff/da_DK.dic".to_owned()));
        }
        Ok(me)
    }

    fn encoding(&mut self) -> String {
        let _ffi = ffi_lock();
        // SAFETY: Hunspell ejer strengen og frigiver den selv. Den kopieres med det samme.
        unsafe {
            let p = ffi::Hunspell_get_dic_encoding(self.handle.as_ptr());
            if p.is_null() {
                return String::new();
            }
            std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned()
        }
    }

    pub fn spell(&mut self, word: &str) -> bool {
        let Ok(w) = std::ffi::CString::new(composed(word)) else {
            return false;
        };
        let _ffi = ffi_lock();
        // SAFETY: gyldigt objekt og en nul-afsluttet UTF-8-streng, der lever under kaldet.
        unsafe { ffi::Hunspell_spell(self.handle.as_ptr(), w.as_ptr()) != 0 }
    }

    pub fn suggest(&mut self, word: &str) -> Vec<String> {
        let Ok(w) = std::ffi::CString::new(composed(word)) else {
            return Vec::new();
        };
        let mut list: *mut *mut std::ffi::c_char = std::ptr::null_mut();
        let _ffi = ffi_lock();
        // SAFETY: Hunspell lægger `n` strenge i `list`. De kopieres, og listen gives tilbage til
        // Hunspell med samme antal, som den selv har sagt.
        unsafe {
            let n = ffi::Hunspell_suggest(self.handle.as_ptr(), &mut list, w.as_ptr());
            if n <= 0 || list.is_null() {
                return Vec::new();
            }
            let out = (0..n as usize)
                .map(|i| *list.add(i))
                .filter(|p| !p.is_null())
                .map(|p| std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned())
                .collect();
            ffi::Hunspell_free_list(self.handle.as_ptr(), &mut list, n);
            out
        }
    }

    /// Ordet godkendes fra nu af, i den form det har (stort begyndelsesbogstav tillader ikke småt).
    pub fn add(&mut self, word: &str) -> bool {
        let Ok(w) = std::ffi::CString::new(composed(word)) else {
            return false;
        };
        let _ffi = ffi_lock();
        // SAFETY: gyldigt objekt og en nul-afsluttet streng. Hunspell kopierer ordet.
        unsafe { ffi::Hunspell_add(self.handle.as_ptr(), w.as_ptr()) == 0 }
    }
}

impl Drop for Hunspell {
    fn drop(&mut self) {
        let _ffi = ffi_lock();
        // SAFETY: objektet er lavet af Hunspell_create og frigives kun her, én gang.
        unsafe { ffi::Hunspell_destroy(self.handle.as_ptr()) }
    }
}

/// Stien som Hunspell kan åbne den på Windows: fuld, med `\\?\` foran og i UTF-8. Så åbner Hunspell
/// den med `_wfopen` (csutil.cxx `myopen`), og et brugernavn med »ø« i stien virker.
/// Ordbogen har »å« som ét tegn. Et ord fra en Mac eller en PDF kan have a plus ring (U+030A), og så
/// afviste Hunspell »på« (målingen 21/10: 18 tilfælde i korpusset).
fn composed(word: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    word.nfc().collect()
}

fn c_path(path: &Path) -> Result<std::ffi::CString, String> {
    let full = std::fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let text = full
        .to_str()
        .ok_or_else(|| format!("{}: ugyldige tegn i stien", path.display()))?;
    #[cfg(windows)]
    let text = if text.starts_with(r"\\?\") {
        text.to_owned()
    } else {
        format!(r"\\?\{text}")
    };
    std::ffi::CString::new(text).map_err(|e| e.to_string())
}

// --- den danske stavekontrol -----------------------------------------------------------------------

/// Hunspell med da_DK og brugerens egne ord.
pub struct Danish {
    hun: Hunspell,
    /// `<data>\ordbog.txt`. `None` i tests uden fil.
    user_file: Option<PathBuf>,
    user_words: Vec<String>,
    /// Forslag tager 0,1-0,4 s pr. ord. Højreklik og fanen Sprog spørger ofte om det samme.
    suggestions: HashMap<String, Vec<String>>,
}

impl Danish {
    /// `imports` læses kun, når brugerens ordbog ikke findes endnu (første start).
    pub fn open(
        aff: &Path,
        dic: &Path,
        user_file: Option<PathBuf>,
        imports: &[PathBuf],
    ) -> Result<Self, String> {
        let hun = Hunspell::open(aff, dic)?;
        let mut me = Self {
            hun,
            user_file,
            user_words: Vec::new(),
            suggestions: HashMap::new(),
        };
        let words = match me.user_file.as_deref() {
            Some(f) if f.exists() => read_word_list(f),
            Some(_) => {
                let mut found: Vec<String> = Vec::new();
                for w in imports
                    .iter()
                    .filter(|p| p.is_file())
                    .flat_map(|p| read_word_list(p))
                {
                    if valid_word(&w) && !found.contains(&w) {
                        found.push(w);
                    }
                }
                found
            }
            None => Vec::new(),
        };
        let first_time = me.user_file.as_deref().is_some_and(|f| !f.exists());
        for w in words {
            me.remember(w);
        }
        // Importen sker én gang: filen skrives, også selv om ingen ord blev fundet i de andre.
        if first_time && imports.iter().any(|p| p.is_file()) {
            me.save()?;
        }
        Ok(me)
    }

    fn remember(&mut self, word: String) {
        if !self.user_words.contains(&word) {
            self.hun.add(&word);
            self.user_words.push(word);
        }
    }

    pub fn is_correct(&mut self, word: &str) -> bool {
        self.hun.spell(word)
    }

    /// Hunspells egne forslag. Windows' fyldes på uden for låsen (`suggest_danish`).
    fn own_suggestions(&mut self, word: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for s in self.hun.suggest(word) {
            if out.len() >= MAX_SUGGESTIONS {
                break;
            }
            if !out.contains(&s) {
                out.push(s);
            }
        }
        out
    }

    fn cache_suggestions(&mut self, word: &str, list: &[String]) {
        if self.suggestions.len() > 2000 {
            self.suggestions.clear();
        }
        self.suggestions.insert(word.to_owned(), list.to_vec());
    }

    pub fn add(&mut self, word: &str) -> Result<(), String> {
        let word = word.trim();
        if !valid_word(word) {
            return Err(t!(
                "Kun et enkelt ord kan føjes til ordbogen.",
                "Only a single word can be added to the dictionary."
            )
            .to_owned());
        }
        if self.user_words.iter().any(|w| w == word) {
            return Ok(());
        }
        self.remember(word.to_owned());
        self.suggestions.clear();
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        let Some(file) = self.user_file.as_deref() else {
            return Ok(());
        };
        let failed = |e: String| {
            t!(
                format!("Ordbogen kunne ikke gemmes: {e}"),
                format!("The dictionary could not be saved: {e}")
            )
        };
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| failed(e.to_string()))?;
        }
        let mut text = String::new();
        for w in &self.user_words {
            text.push_str(w);
            text.push('\n');
        }
        crate::files::write_atomic(file, text.as_bytes()).map_err(|e| failed(e.to_string()))
    }
}

/// Et ord, der kan stå i ordbogen: ikke tomt, ingen mellemrum, ikke absurd langt.
fn valid_word(word: &str) -> bool {
    !word.is_empty()
        && word.chars().count() <= 100
        && !word.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Ét ord pr. linje. Windows' `default.dic` er UTF-16 med BOM, de andre UTF-8.
fn read_word_list(path: &Path) -> Vec<String> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let text = if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        let rest = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
        String::from_utf8_lossy(rest).into_owned()
    };
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && valid_word(l))
        .map(str::to_owned)
        .collect()
}

// --- programmets ene stavekontrol ------------------------------------------------------------------

struct Config {
    aff: PathBuf,
    dic: PathBuf,
    user_file: Option<PathBuf>,
    imports: Vec<PathBuf>,
}

enum Slot {
    Waiting,
    Ready(Box<Danish>),
    Failed,
}

static CONFIG: OnceLock<Config> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
static DANISH: Mutex<Slot> = Mutex::new(Slot::Waiting);

/// Ved start: find ordbogen og brugerens ordbog, og indlæs i baggrunden (0,1-0,3 s), så de første
/// streger ikke venter.
pub fn init(app: &AppHandle) {
    use tauri::Manager;
    let _ = APP.set(app.clone());
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(r) = app.path().resource_dir() {
        dirs.push(r.join("resources").join("ordbog"));
    }
    // `tauri dev` uden kopierede ressourcer: ordbogen i kildetræet.
    #[cfg(debug_assertions)]
    dirs.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ordbog"),
    );
    let Some(dir) = dirs.into_iter().find(|d| d.join("da_DK.dic").is_file()) else {
        crate::applog::write(app, "stavekontrol: ordbogen findes ikke, Windows bruges");
        return;
    };
    let mut imports = Vec::new();
    if let Some(roaming) = std::env::var_os("APPDATA").map(PathBuf::from) {
        imports.push(
            roaming
                .join("Microsoft")
                .join("Spelling")
                .join("da-DK")
                .join("default.dic"),
        );
        imports.push(roaming.join("iA Writer").join("custom_dictionary.txt"));
    }
    let _ = CONFIG.set(Config {
        aff: dir.join("da_DK.aff"),
        dic: dir.join("da_DK.dic"),
        user_file: app
            .path()
            .app_local_data_dir()
            .ok()
            .map(|d| d.join("ordbog.txt")),
        imports,
    });
    std::thread::spawn(|| with_danish(|_| ()));
}

/// Kør `f` med den danske stavekontrol. `None`, når den ikke kan bruges: så tager Windows over.
fn with_danish<R>(f: impl FnOnce(&mut Danish) -> R) -> Option<R> {
    let mut slot = DANISH.lock().unwrap_or_else(PoisonError::into_inner);
    if matches!(*slot, Slot::Waiting) {
        let c = CONFIG.get()?;
        let started = std::time::Instant::now();
        *slot = match Danish::open(&c.aff, &c.dic, c.user_file.clone(), &c.imports) {
            Ok(d) => {
                if let Some(app) = APP.get() {
                    crate::applog::write(
                        app,
                        &format!(
                            "stavekontrol: ordbogen indlæst på {} ms, {} egne ord",
                            started.elapsed().as_millis(),
                            d.user_words.len()
                        ),
                    );
                }
                Slot::Ready(Box::new(d))
            }
            Err(e) => {
                if let Some(app) = APP.get() {
                    crate::applog::write(app, &format!("stavekontrol: {e}"));
                }
                Slot::Failed
            }
        };
    }
    match &mut *slot {
        Slot::Ready(d) => Some(f(d)),
        _ => None,
    }
}

/// Som `with_danish`, men venter højst `wait` på låsen og indlæser aldrig ordbogen. `Err(())`: den
/// er optaget eller ikke indlæst endnu. `Ok(None)`: den kan ikke bruges, så tager Windows over.
fn try_danish<R>(wait: Duration, f: impl FnOnce(&mut Danish) -> R) -> Result<Option<R>, ()> {
    let started = Instant::now();
    let mut slot = loop {
        match DANISH.try_lock() {
            Ok(g) => break g,
            Err(TryLockError::Poisoned(p)) => break p.into_inner(),
            Err(TryLockError::WouldBlock) if started.elapsed() < wait => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(TryLockError::WouldBlock) => return Err(()),
        }
    };
    match &mut *slot {
        Slot::Ready(d) => Ok(Some(f(d))),
        Slot::Waiting if CONFIG.get().is_some() => Err(()),
        Slot::Waiting | Slot::Failed => Ok(None),
    }
}

/// Dansk med Hunspell? Nej ved engelsk brugerflade, eller når ordbogen mangler.
fn use_danish() -> bool {
    !crate::i18n::english() && with_danish(|_| ()).is_some()
}

/// Forslag til et forkert ord, bedste først.
pub fn suggest(word: &str) -> Result<Vec<String>, String> {
    if use_danish() {
        return Ok(suggest_danish(word));
    }
    win::suggest(word)
}

/// Hunspells forslag først. Er der få, fyldes op med Windows' danske, som Hunspell godkender
/// (»byrådsmøbe« → »byrådsmøde«, research 9/10). Windows spørges uden låsen, så stregerne ikke venter.
fn suggest_danish(word: &str) -> Vec<String> {
    let Some((mut out, cached)) = with_danish(|d| match d.suggestions.get(word) {
        Some(hit) => (hit.clone(), true),
        None => (d.own_suggestions(word), false),
    }) else {
        return Vec::new();
    };
    if cached {
        return out;
    }
    if out.len() < MAX_SUGGESTIONS {
        let extra = win::raw_suggestions(word);
        let _ = with_danish(|d| {
            for s in extra {
                if out.len() >= MAX_SUGGESTIONS {
                    break;
                }
                if !out.contains(&s) && d.is_correct(&s) {
                    out.push(s);
                }
            }
        });
    }
    let _ = with_danish(|d| d.cache_suggestions(word, &out));
    out
}

/// Højreklik (9/10): `None`, når ordet er rigtigt, ellers forslagene. Er den danske stavekontrol
/// optaget, kommer menuen uden stavning, frem for at vinduet fryser (22/10).
pub fn word_status(word: &str) -> Option<Vec<String>> {
    if !crate::i18n::english() {
        match try_danish(MENU_WAIT, |d| d.is_correct(word)) {
            Ok(Some(true)) | Err(()) => return None,
            Ok(Some(false)) => return Some(suggest_danish(word)),
            Ok(None) => {}
        }
    }
    win::word_status(word)
}

/// »Tilføj til ordbog« fra højreklik (contextmenu.rs) og fanen Sprog. Fladen får besked
/// (`spell-added`), så stregen under ordet forsvinder med det samme i alle vinduer.
pub fn add_word(word: &str) -> Result<(), String> {
    let word = word.trim();
    if use_danish() {
        with_danish(|d| d.add(word)).unwrap_or(Ok(()))?;
    } else {
        win::add(word)?;
    }
    if let Some(app) = APP.get() {
        let _ = app.emit("spell-added", word);
    }
    Ok(())
}

/// Stavefejlene i en tekst (fanen Sprog). Kun de første få får forslag med det samme: fanen viser ét
/// ord ad gangen og henter selv forslag til de næste (`spell_suggest`).
fn check(text: &str) -> Result<Vec<SpellError>, String> {
    if !use_danish() {
        return win::check(text);
    }
    let toks = tokens(text);
    let mut out = Vec::new();
    // Hvert ord slås op én gang (en lang tekst har langt færre forskellige ord end ord), og låsen
    // slippes mellem bidderne, så højreklik ikke venter på hele teksten (gennemgang 22/10).
    let mut unique: Vec<&str> = toks.iter().map(|t| t.check.as_str()).collect();
    unique.sort_unstable();
    unique.dedup();
    let mut wrong: HashSet<&str> = HashSet::new();
    for chunk in unique.chunks(CHECK_CHUNK) {
        if let Some(bad) = with_danish(|d| {
            chunk
                .iter()
                .copied()
                .filter(|w| !d.is_correct(w))
                .collect::<Vec<_>>()
        }) {
            wrong.extend(bad);
        }
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    for (i, t) in toks.iter().enumerate() {
        if let Some(prev) = i.checked_sub(1).map(|p| &toks[p]) {
            let between = String::from_utf16_lossy(&units[prev.to..t.from]);
            if !prev.dot
                && !between.is_empty()
                && between.chars().all(|c| c == ' ')
                && prev.word.to_lowercase() == t.word.to_lowercase()
            {
                out.push(SpellError {
                    from: t.from as u32,
                    to: t.to as u32,
                    word: t.word.clone(),
                    suggestions: vec![String::new()],
                });
                continue;
            }
        }
        if wrong.contains(t.check.as_str()) {
            out.push(SpellError {
                from: t.from as u32,
                to: t.to as u32,
                word: t.word.clone(),
                suggestions: Vec::new(),
            });
        }
    }
    for e in out.iter_mut().filter(|e| e.suggestions.is_empty()).take(3) {
        e.suggestions = suggest_danish(&e.word);
    }
    Ok(out)
}

// --- ordene i en tekst -----------------------------------------------------------------------------

/// Et ord, som stavekontrollen ser det. Positionerne i UTF-16.
#[derive(Debug, PartialEq)]
pub struct Token {
    pub from: usize,
    pub to: usize,
    /// Ordet, som det står (uden et punktum efter).
    pub word: String,
    /// Det, Hunspell spørges om: ordet med punktummet efter, hvis der står et (»kr.«, »bl.a.«).
    /// Hunspell prøver selv uden punktummet først.
    pub check: String,
    pub dot: bool,
}

const JOINERS: &[char] = &['-', '\'', '’', '.'];

fn is_letter(c: char) -> bool {
    c.is_alphabetic() || ('\u{300}'..='\u{36f}').contains(&c)
}

/// Ordene, stavekontrollen skal se på. Samme regler som fladen (src/editor/spelling.ts
/// `spellTokens`): ingen tal og ord ved tal, ingen #tags og @navne, ingen ord med store bogstaver
/// inde i ordet (CamelCase, forkortelser), ingen adresser, stier eller domæner, intet på ét bogstav.
pub fn tokens(text: &str) -> Vec<Token> {
    let chars: Vec<char> = text.chars().collect();
    let mut pos = Vec::with_capacity(chars.len() + 1);
    let mut u = 0usize;
    for c in &chars {
        pos.push(u);
        u += c.len_utf16();
    }
    pos.push(u);
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !is_letter(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i + 1;
        while j < chars.len() {
            if is_letter(chars[j]) {
                j += 1;
            } else if JOINERS.contains(&chars[j]) && chars.get(j + 1).is_some_and(|c| is_letter(*c))
            {
                j += 2;
            } else {
                break;
            }
        }
        i = j;
        let word: String = chars[start..j].iter().collect();
        let dot = chars.get(j) == Some(&'.');
        let before = start.checked_sub(1).map(|b| chars[b]);
        let after = chars.get(j).copied();
        let touches = |c: Option<char>, extra: &[char]| {
            c.is_some_and(|c| c.is_numeric() || extra.contains(&c))
        };
        if touches(before, &['#', '@', '_'])
            || touches(after, &['_', '@'])
            || word.chars().count() < 2
            || word.chars().count() > 60
            || inner_capital(&word)
            || in_address(&chars, start, j)
        {
            continue;
        }
        let check = if dot {
            format!("{word}.")
        } else {
            word.clone()
        };
        out.push(Token {
            from: pos[start],
            to: pos[j],
            word,
            check,
            dot,
        });
    }
    out
}

/// Stort bogstav inde i et led: »OneDrive«, »iPhone«, »GPL«. »Nord-Korea« er i orden.
fn inner_capital(word: &str) -> bool {
    word.split('-')
        .any(|part| part.chars().skip(1).any(char::is_uppercase))
}

/// Står ordet i en adresse, en sti, en mail eller et domæne (»godemedier.dk«)?
fn in_address(chars: &[char], start: usize, end: usize) -> bool {
    let mut a = start;
    while a > 0 && !chars[a - 1].is_whitespace() {
        a -= 1;
    }
    let mut b = end;
    while b < chars.len() && !chars[b].is_whitespace() {
        b += 1;
    }
    let chunk: String = chars[a..b].iter().collect();
    let chunk = chunk.trim_matches(|c: char| "()[]{}<>\"'«»“”‘’,;:!?*".contains(c));
    chunk.contains("://")
        || chunk.contains('@')
        || chunk.contains('\\')
        || chunk.starts_with("www.")
        || (chunk.contains('/') && chunk.contains('.'))
        || is_domain(chunk.trim_end_matches('.'))
}

/// »godemedier.dk«, »dr.dk«: ASCII, første led mindst to tegn, sidste led to til seks bogstaver.
/// Ikke »f.eks« eller »bl.a« (et led på ét bogstav).
fn is_domain(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() >= 2
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        && parts[0].len() >= 2
        && parts.last().is_some_and(|t| {
            (2..=6).contains(&t.len()) && t.chars().all(|c| c.is_ascii_lowercase())
        })
}

// --- Windows' stavekontrol: engelsk og reserve -----------------------------------------------------

#[cfg(windows)]
mod win {
    use super::SpellError;
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Globalization::{
        GetUserDefaultLocaleName, ISpellChecker, ISpellCheckerFactory, ISpellingError,
        SpellCheckerFactory, CORRECTIVE_ACTION_DELETE, CORRECTIVE_ACTION_GET_SUGGESTIONS,
        CORRECTIVE_ACTION_REPLACE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };

    fn take(p: PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        // SAFETY: Windows har allokeret strengen med CoTaskMemAlloc; den læses og frigives her.
        unsafe {
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as *const _));
            s
        }
    }

    /// Ordbøgerne, der prøves i rækkefølge. På engelsk brugerens eget engelske sprog fra Windows
    /// (»en-AU«), ellers amerikansk og så britisk (i18n.rs, 5/10).
    fn tags() -> Vec<String> {
        if !crate::i18n::english() {
            return vec!["da-DK".to_owned(), "da".to_owned()];
        }
        let mut out = Vec::new();
        let mut buf = [0u16; 85]; // LOCALE_NAME_MAX_LENGTH
                                  // SAFETY: Windows skriver højst bufferens længde, inklusive det afsluttende nul.
        let n = unsafe { GetUserDefaultLocaleName(&mut buf) };
        if n > 1 {
            let name = String::from_utf16_lossy(&buf[..n as usize - 1]);
            if name.to_ascii_lowercase().starts_with("en-") {
                out.push(name);
            }
        }
        for tag in ["en-US", "en-GB"] {
            if !out.iter().any(|o| o.eq_ignore_ascii_case(tag)) {
                out.push(tag.to_owned());
            }
        }
        out
    }

    fn checker() -> Result<ISpellChecker, String> {
        let failed = || {
            t!(
                "Windows' stavekontrol kunne ikke startes.",
                "Windows spell check could not be started."
            )
            .to_owned()
        };
        // SAFETY: COM initialiseres på denne tråd (et andet tilstandsvalg er allerede i orden),
        // og fabrikken oprettes efter Windows' dokumentation.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let factory: ISpellCheckerFactory =
                CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER)
                    .map_err(|_| failed())?;
            for tag in tags() {
                let tag = HSTRING::from(tag);
                if factory
                    .IsSupported(&tag)
                    .map(|b| b.as_bool())
                    .unwrap_or(false)
                {
                    return factory.CreateSpellChecker(&tag).map_err(|_| failed());
                }
            }
            Err(t!(
                "Windows har ikke dansk stavekontrol installeret. Tilføj dansk under Indstillinger, Tid og sprog, Sprog.",
                "Windows does not have English spell check installed. Add English under Settings, Time & language, Language & region."
            )
            .to_owned())
        }
    }

    fn suggestions(c: &ISpellChecker, word: &str) -> Vec<String> {
        let mut out = Vec::new();
        // SAFETY: enumeratoren læses, til den er tom; hver streng frigives i `take`.
        unsafe {
            let Ok(list) = c.Suggest(&HSTRING::from(word)) else {
                return out;
            };
            loop {
                let mut one = [PWSTR::null()];
                let mut got = 0u32;
                if list.Next(&mut one, Some(&mut got)).is_err() || got == 0 {
                    break;
                }
                out.push(take(one[0]));
                if out.len() >= super::MAX_SUGGESTIONS {
                    break;
                }
            }
        }
        out
    }

    /// Står ordet i Windows' ordbog (eller er det et gyldigt sammensat ord)?
    fn is_correct(c: &ISpellChecker, word: &str) -> bool {
        // SAFETY: Check returnerer en enumerator; ingen fejl betyder, at ordet er rigtigt.
        unsafe {
            let Ok(errors) = c.Check(&HSTRING::from(word)) else {
                return false;
            };
            let mut e: Option<ISpellingError> = None;
            errors.Next(&mut e).is_ok() && e.is_none()
        }
    }

    pub fn are_correct(words: &[String]) -> Result<Vec<bool>, String> {
        let c = checker()?;
        Ok(words.iter().map(|w| is_correct(&c, w)).collect())
    }

    /// Windows' egne forslag, uden noget ovenpå (til den danske stavekontrol).
    pub fn raw_suggestions(word: &str) -> Vec<String> {
        checker().map(|c| suggestions(&c, word)).unwrap_or_default()
    }

    /// Forslag til et forkert ord (9/10): ordet med ét bogstav for meget eller to bogstaver byttet om
    /// (`edits`), som Windows godkender, og derefter Windows' egne forslag.
    pub fn suggest(word: &str) -> Result<Vec<String>, String> {
        let c = checker()?;
        // Én tastefejl er det mest sandsynlige, så de rettelser, Windows godkender, står først
        // (højst tre). Windows' egne forslag fylder op.
        let mut out: Vec<String> = super::edits(word)
            .into_iter()
            .filter(|cand| is_correct(&c, cand))
            .take(3)
            .collect();
        for s in suggestions(&c, word) {
            if out.len() >= super::MAX_SUGGESTIONS {
                break;
            }
            if !out.contains(&s) {
                out.push(s);
            }
        }
        Ok(out)
    }

    /// Højreklik (9/10): `None`, når ordet er rigtigt, ellers forslagene.
    pub fn word_status(word: &str) -> Option<Vec<String>> {
        let c = checker().ok()?;
        if is_correct(&c, word) {
            return None;
        }
        suggest(word).ok()
    }

    pub fn check(text: &str) -> Result<Vec<SpellError>, String> {
        let c = checker()?;
        let units: Vec<u16> = text.encode_utf16().collect();
        let mut out = Vec::new();
        // SAFETY: Check returnerer en enumerator over fejl; hver læses, til den er tom.
        unsafe {
            let errors = c.Check(&HSTRING::from(text)).map_err(|_| {
                t!(
                    "Stavekontrollen kunne ikke læse teksten.",
                    "Spell check could not read the text."
                )
                .to_owned()
            })?;
            loop {
                let mut e: Option<ISpellingError> = None;
                if errors.Next(&mut e).is_err() {
                    break;
                }
                let Some(e) = e else { break };
                let (Ok(from), Ok(len)) = (e.StartIndex(), e.Length()) else {
                    continue;
                };
                let to = (from + len).min(units.len() as u32);
                let word = String::from_utf16_lossy(&units[from as usize..to as usize]);
                let action = e.CorrectiveAction().unwrap_or_default();
                let suggestions = if action == CORRECTIVE_ACTION_REPLACE {
                    vec![e.Replacement().map(take).unwrap_or_default()]
                } else if action == CORRECTIVE_ACTION_DELETE {
                    vec![String::new()]
                } else if action == CORRECTIVE_ACTION_GET_SUGGESTIONS {
                    suggestions(&c, &word)
                } else {
                    Vec::new()
                };
                out.push(SpellError {
                    from,
                    to,
                    word,
                    suggestions,
                });
            }
        }
        Ok(out)
    }

    pub fn add(word: &str) -> Result<(), String> {
        let c = checker()?;
        // SAFETY: et rent kald; ordet kopieres af Windows.
        unsafe { c.Add(&HSTRING::from(word)) }.map_err(|_| {
            t!(
                "Ordet kunne ikke føjes til ordbogen.",
                "The word could not be added to the dictionary."
            )
            .to_owned()
        })
    }
}

#[cfg(not(windows))]
mod win {
    use super::SpellError;
    pub fn are_correct(words: &[String]) -> Result<Vec<bool>, String> {
        Ok(vec![true; words.len()])
    }
    pub fn raw_suggestions(_word: &str) -> Vec<String> {
        Vec::new()
    }
    pub fn suggest(_word: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    pub fn word_status(_word: &str) -> Option<Vec<String>> {
        None
    }
    pub fn check(_text: &str) -> Result<Vec<SpellError>, String> {
        Err(t!("Kun på Windows.", "Windows only.").to_owned())
    }
    pub fn add(_word: &str) -> Result<(), String> {
        Err(t!("Kun på Windows.", "Windows only.").to_owned())
    }
}

/// Ordet med én rettelse af de to sikreste slags tastefejl: et bogstav for meget og to bogstaver
/// byttet om. Kun til Windows' engelske forslag: med Hunspell gav de sludder (»skriversogram«,
/// research 9/10). Stort begyndelsesbogstav bevares.
pub fn edits(word: &str) -> Vec<String> {
    let lower: Vec<char> = word.to_lowercase().chars().collect();
    let cap = word.chars().next().is_some_and(char::is_uppercase);
    let n = lower.len();
    let mut out: Vec<String> = Vec::new();
    let mut push = |v: Vec<char>| {
        let mut s: String = v.into_iter().collect();
        if cap {
            let mut c = s.chars();
            s = c
                .next()
                .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                .unwrap_or_default();
        }
        if !s.is_empty() && s != word && !out.contains(&s) {
            out.push(s);
        }
    };
    for i in 0..n {
        let mut v = lower.clone();
        v.remove(i);
        push(v);
    }
    for i in 0..n.saturating_sub(1) {
        let mut v = lower.clone();
        v.swap(i, i + 1);
        push(v);
    }
    out
}

// --- kommandoerne ----------------------------------------------------------------------------------

/// Flere forslag til ét ord (fanen Sprog).
#[tauri::command]
pub async fn spell_suggest(word: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || suggest(word.trim()))
        .await
        .map_err(|e| e.to_string())?
}

/// Stavefejlene i teksten (fladen har blanket markdown-tegn og skjulte blokke ud først).
#[tauri::command]
pub async fn spell_check(text: String) -> Result<Vec<SpellError>, String> {
    tauri::async_runtime::spawn_blocking(move || check(&text))
        .await
        .map_err(|e| e.to_string())?
}

/// Mange ord på én gang til de røde streger i skrivefladen (src/editor/spelling.ts): sand for de
/// rigtige, i samme rækkefølge. Fladen har allerede sorteret kode, links og tal fra.
#[tauri::command]
pub async fn spell_check_words(words: Vec<String>) -> Result<Vec<bool>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::i18n::english() {
            if let Some(v) = with_danish(|d| words.iter().map(|w| d.is_correct(w)).collect()) {
                return Ok(v);
            }
        }
        win::are_correct(&words)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// »Tilføj til ordbog« i fanen Sprog.
#[tauri::command]
pub async fn spell_add(word: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || add_word(&word))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod edit_tests {
    use super::edits;

    #[test]
    fn rettelser_af_et_ord() {
        let e = edits("skriveprsogram");
        // Et bogstav for meget kommer først, så to byttet om.
        assert!(e
            .iter()
            .position(|w| w == "skriveprogram")
            .is_some_and(|i| i < 14));
        assert!(e.contains(&"skrievprsogram".to_owned()));
        assert!(!e.contains(&"skriveprsogram".to_owned()));
        assert!(edits("Tektst").contains(&"Tekst".to_owned()));
    }
}

#[cfg(test)]
mod token_tests {
    use super::tokens;

    fn words(text: &str) -> Vec<String> {
        tokens(text).into_iter().map(|t| t.check).collect()
    }

    #[test]
    fn ord_og_positioner() {
        let t = tokens("Én tekts, bl.a. med e-mail og kr. 5.");
        let w: Vec<&str> = t.iter().map(|t| t.check.as_str()).collect();
        assert_eq!(w, ["Én", "tekts", "bl.a.", "med", "e-mail", "og", "kr."]);
        // Positioner i UTF-16, uden punktummet.
        assert_eq!((t[1].from, t[1].to), (3, 8));
        assert_eq!((t[6].from, t[6].to, t[6].word.as_str()), (30, 32, "kr"));
    }

    /// Samme tilfælde som src/editor/spelling.test.ts, så fanen Sprog og stregerne er enige.
    #[test]
    fn springer_over() {
        let text = "OneDrive iPhone GPL 3D 10kr H2O #tag @navn https://godemedier.dk/a www.dr.dk \
                    godemedier.dk mail@x.dk C:\\Brugere\\x src/editor/x.ts a i Nord-Korea f.eks. og/eller";
        assert_eq!(
            words(text),
            ["Nord-Korea", "f.eks.", "og", "eller"],
            "{:?}",
            tokens(text)
        );
    }

    #[test]
    fn tegn_uden_for_bmp() {
        let t = tokens("😀 hej");
        assert_eq!((t[0].from, t[0].to), (3, 6));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Højreklik, mens fanen Sprog holder låsen: menuen må ikke vente på hele tjekket (22/10).
    #[test]
    fn hoejreklik_venter_ikke_paa_en_optaget_stavekontrol() {
        let _held = DANISH.lock().unwrap_or_else(PoisonError::into_inner);
        let t = Instant::now();
        assert_eq!(try_danish(MENU_WAIT, |_| ()), Err(()));
        assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    }

    fn dict() -> (PathBuf, PathBuf) {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ordbog");
        (dir.join("da_DK.aff"), dir.join("da_DK.dic"))
    }

    fn danish(user: Option<PathBuf>, imports: &[PathBuf]) -> Danish {
        let (aff, dic) = dict();
        Danish::open(&aff, &dic, user, imports).expect("ordbogen kan indlæses")
    }

    /// Prøveordene fra researchen (9/10). En ny ordbog, der pludselig afviser »skriveprogram«
    /// eller godkender »skrivedrogram«, stopper her (scripts/ordbog.mjs).
    #[test]
    fn rigtige_og_forkerte_ord() {
        let mut d = danish(None, &[]);
        for w in [
            "skriveprogram",
            "skriveprogrammet",
            "coronakrisen",
            "havnebadet",
            "byrådsmøde",
            "tekstbehandling",
            "forvaltningen",
            "Folketinget",
            "fejlloggen",
            "standardknappen",
            "designprincipper",
            "gennemstreget",
            "København",
            "Huset",
            "kr.",
            "mio.",
            "bl.a.",
            "e-mail",
            "huset.",
        ] {
            assert!(d.is_correct(w), "{w} skal være rigtigt");
        }
        for w in [
            "skriveprogarm",
            "skriveprsogram",
            "havnebaddet",
            "tekts",
            "stavefjel",
            "skrivedrogram",
            "skriveprægram",
            "forvlatningen",
            "semikolonner",
        ] {
            // Hunspell giver op på et sammensat ord efter 50 ms (TIMELIMIT_MS i atypes.hxx) og
            // godkender det så. Under gaten, med alle testene på én gang, sker det for
            // »skriveprægram« (22/10). Et nyt forsøg er hurtigt nok, en ordbogsfejl er det ikke.
            assert!((0..3).any(|_| !d.is_correct(w)), "{w} skal være forkert");
        }
    }

    /// »på« og »Århus« med a plus ring (U+030A), som fra en Mac eller en PDF.
    #[test]
    fn aa_som_a_plus_ring() {
        let mut d = danish(None, &[]);
        for w in ["pa\u{30A}", "A\u{30A}rhus", "ga\u{30A}r"] {
            assert!(d.is_correct(w), "{w} skal være rigtigt");
        }
        assert!(d
            .own_suggestions("pa\u{30A}a")
            .iter()
            .all(|s| !s.contains('\u{30A}')));
    }

    #[test]
    fn forslag() {
        let mut d = danish(None, &[]);
        for (wrong, right) in [
            ("skriveprogarm", "skriveprogram"),
            ("havnebaddet", "havnebadet"),
            ("stavefjel", "stavefejl"),
            ("forvlatningen", "forvaltningen"),
        ] {
            let list = d.own_suggestions(wrong);
            assert!(list.iter().any(|w| w == right), "{wrong}: {list:?}");
            assert!(list.len() <= MAX_SUGGESTIONS);
        }
        assert_eq!(
            d.own_suggestions("havnebaddet").first().map(String::as_str),
            Some("havnebadet")
        );
    }

    #[test]
    fn egen_ordbog_gemmes_og_indlaeses() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("data").join("ordbog.txt");
        let mut d = danish(Some(file.clone()), &[]);
        assert!(!d.is_correct("Zyxwvutsrq"));
        d.add("Zyxwvutsrq").expect("tilføjet");
        d.add("  Zyxwvutsrq ").expect("samme ord igen");
        assert!(d.is_correct("Zyxwvutsrq"));
        assert!(d.add("to ord").is_err());
        assert_eq!(
            std::fs::read_to_string(&file).expect("filen findes"),
            "Zyxwvutsrq\n"
        );
        // Ved næste start er ordet der stadig.
        let mut again = danish(Some(file), &[]);
        assert!(again.is_correct("Zyxwvutsrq"));
        assert!(!again.is_correct("Zyxwvutsrqb"));
    }

    /// Windows' brugerordbog (UTF-16 med BOM) og iA Writers (UTF-8) hentes ind første gang, og kun
    /// første gang. Kopier i en midlertidig mappe, aldrig brugerens rigtige filer.
    #[test]
    fn import_kun_foerste_gang() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let windows = tmp.path().join("default.dic");
        let mut bytes = vec![0xFF, 0xFE];
        for u in "Kimsen\r\nTekstbix\r\n".encode_utf16() {
            bytes.extend(u.to_le_bytes());
        }
        std::fs::write(&windows, bytes).expect("skrevet");
        let ia = tmp.path().join("custom_dictionary.txt");
        std::fs::write(&ia, "\u{feff}Skrivbar\nKimsen\n").expect("skrevet");
        let file = tmp.path().join("ordbog.txt");
        let imports = [windows.clone(), ia, tmp.path().join("findes-ikke.dic")];
        let mut d = danish(Some(file.clone()), &imports);
        assert!(d.is_correct("Kimsen") && d.is_correct("Tekstbix") && d.is_correct("Skrivbar"));
        assert_eq!(
            std::fs::read_to_string(&file).expect("filen findes"),
            "Kimsen\nTekstbix\nSkrivbar\n"
        );
        // Et ord, der kommer i Windows' ordbog senere, hentes ikke ind igen.
        std::fs::write(&windows, "Senereord\n").expect("skrevet");
        let mut again = danish(Some(file), &imports);
        assert!(!again.is_correct("Senereord"));
    }

    /// Hunspell åbner stien med `\\?\` og UTF-8, så »ø« i et brugernavn virker.
    #[test]
    fn sti_med_danske_bogstaver() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("Søren Æblegård");
        std::fs::create_dir_all(&dir).expect("mappe");
        let (aff, dic) = dict();
        std::fs::copy(&aff, dir.join("da_DK.aff")).expect("kopi");
        std::fs::copy(&dic, dir.join("da_DK.dic")).expect("kopi");
        let mut h = Hunspell::open(&dir.join("da_DK.aff"), &dir.join("da_DK.dic")).expect("åbnet");
        assert!(h.spell("skriveprogram"));
    }

    #[test]
    fn manglende_ordbog_giver_fejl() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(Hunspell::open(&tmp.path().join("x.aff"), &tmp.path().join("x.dic")).is_err());
        // En tom fil giver et tomt Hunspell-objekt, som ikke må godtages.
        std::fs::write(tmp.path().join("x.aff"), "").expect("skrevet");
        std::fs::write(tmp.path().join("x.dic"), "0\n").expect("skrevet");
        assert!(Hunspell::open(&tmp.path().join("x.aff"), &tmp.path().join("x.dic")).is_err());
    }

    /// Tiderne i ADR-0063: indlæsning og 10.000 ord fra projektets egne dokumenter.
    /// `cargo test --release maal_tider -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn maal_tider() {
        let (aff, dic) = dict();
        let t = std::time::Instant::now();
        let mut d = Danish::open(&aff, &dic, None, &[]).expect("indlæst");
        let load = t.elapsed();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut text = String::new();
        for f in ["ARKITEKTUR.md", "README.da.md", "STRATEGI.md"] {
            text.push_str(&std::fs::read_to_string(root.join(f)).unwrap_or_default());
        }
        let toks: Vec<String> = tokens(&text).into_iter().map(|t| t.check).collect();
        let words: Vec<&String> = toks.iter().cycle().take(10_000).collect();
        let mut unique: Vec<&String> = words.clone();
        unique.sort();
        unique.dedup();
        let t = std::time::Instant::now();
        let wrong = words.iter().filter(|w| !d.is_correct(w)).count();
        let all = t.elapsed();
        let t = std::time::Instant::now();
        for w in &unique {
            d.is_correct(w);
        }
        let distinct = t.elapsed();
        let t = std::time::Instant::now();
        let s = d.own_suggestions("skriveprogarm");
        let sug = t.elapsed();
        println!(
            "indlæsning {load:?}; 10.000 ord {all:?} ({wrong} forkerte); {} forskellige {distinct:?}; ét forslag {sug:?} {s:?}",
            unique.len()
        );
    }
}

/// Måling 21/10: Hunspell mod Windows på et korpus (falske røde streger) og på lavede tastefejl
/// (fangede fejl). `GT_KORPUS=<mappe med .txt> cargo test --release maal_korpus -- --ignored --nocapture`.
#[cfg(all(test, windows))]
mod maal_korpus {
    use super::*;
    use std::collections::{BTreeMap, HashSet};

    #[test]
    #[ignore]
    fn maal_korpus() {
        let dir = std::env::var("GT_KORPUS").unwrap();
        let res = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ordbog");
        let mut hun = Hunspell::open(&res.join("da_DK.aff"), &res.join("da_DK.dic")).unwrap();
        // Ord → antal forekomster.
        let mut count: BTreeMap<String, usize> = BTreeMap::new();
        for f in std::fs::read_dir(&dir).unwrap().flatten() {
            let text = std::fs::read_to_string(f.path()).unwrap();
            for t in tokens(&text) {
                *count.entry(t.check).or_default() += 1;
            }
        }
        let words: Vec<String> = count.keys().cloned().collect();
        let win_ok = win::are_correct(&words).unwrap();
        let (mut h_only, mut w_only, mut both) = (Vec::new(), Vec::new(), Vec::new());
        let (mut h_tok, mut w_tok, mut total) = (0usize, 0usize, 0usize);
        let mut both_ok: Vec<String> = Vec::new();
        for (w, wok) in words.iter().zip(win_ok) {
            let n = count[w];
            total += n;
            let hok = hun.spell(w);
            if !hok {
                h_tok += n;
            }
            if !wok {
                w_tok += n;
            }
            match (hok, wok) {
                (false, true) => h_only.push((n, w.clone())),
                (true, false) => w_only.push((n, w.clone())),
                (false, false) => both.push((n, w.clone())),
                (true, true) => both_ok.push(w.clone()),
            }
        }
        for l in [&mut h_only, &mut w_only, &mut both] {
            l.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        }
        println!(
            "KORPUS: {} forskellige ord, {} forekomster",
            words.len(),
            total
        );
        println!(
            "Hunspell markerer {} forekomster ({:.2} %), Windows {} ({:.2} %)",
            h_tok,
            100.0 * h_tok as f64 / total as f64,
            w_tok,
            100.0 * w_tok as f64 / total as f64
        );
        println!(
            "kun Hunspell: {} ord, kun Windows: {} ord, begge: {} ord",
            h_only.len(),
            w_only.len(),
            both.len()
        );
        let show = |name: &str, l: &[(usize, String)]| {
            println!(
                "{name}: {}",
                l.iter()
                    .take(60)
                    .map(|(n, w)| format!("{w}({n})"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        show("KUN HUNSPELL", &h_only);
        show("KUN WINDOWS", &w_only);
        show("BEGGE", &both);

        // Tastefejl: lange ord, begge godkender. Ét bogstav byttet ud eller to byttet om, deterministisk.
        let long: Vec<&String> = both_ok
            .iter()
            .filter(|w| w.chars().count() >= 9 && w.chars().all(|c| c.is_lowercase()))
            .collect();
        let step = (long.len() / 300).max(1);
        let mut seen = HashSet::new();
        let (mut tried, mut h_caught, mut w_caught) = (0, 0, 0);
        let mut missed_h = Vec::new();
        let mut missed_w = Vec::new();
        let mut typos = Vec::new();
        for (k, w) in long.iter().step_by(step).take(300).enumerate() {
            let mut c: Vec<char> = w.chars().collect();
            let i = 2 + (k * 7) % (c.len() - 4);
            if k % 2 == 0 {
                c.swap(i, i + 1);
            } else {
                c[i] = if c[i] == 'e' { 'a' } else { 'e' };
            }
            let typo: String = c.into_iter().collect();
            if typo == **w || count.contains_key(&typo) || !seen.insert(typo.clone()) {
                continue;
            }
            typos.push(typo);
        }
        let w_ok = win::are_correct(&typos).unwrap();
        for (t, wok) in typos.iter().zip(w_ok) {
            tried += 1;
            if !hun.spell(t) {
                h_caught += 1;
            } else {
                missed_h.push(t.clone());
            }
            if !wok {
                w_caught += 1;
            } else {
                missed_w.push(t.clone());
            }
        }
        println!("TASTEFEJL: {tried} lavet. Hunspell fanger {h_caught}, Windows {w_caught}");
        println!(
            "Hunspell godkender: {}",
            missed_h
                .iter()
                .take(40)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        );
        println!(
            "Windows godkender: {}",
            missed_w
                .iter()
                .take(40)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
}
