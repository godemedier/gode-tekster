//! Læsning og gem af tekstfiler (ADR-0013: kilden røres aldrig).
//!
//! Editoren arbejder altid med `\n`. Her huskes filens kodning, BOM og linjeskift, så et gem uden
//! rettelser giver præcis de samme bytes tilbage. Et gem er atomisk (midlertidig fil i samme mappe,
//! `ReplaceFileW`) og nægter at overskrive en fil, der er ændret på disken siden sidst.

use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Kodningen, filen blev læst med, og som den skrives tilbage med.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16LeBom,
    Utf16BeBom,
    /// Gamle danske filer uden BOM, der ikke er gyldig UTF-8.
    Windows1252,
}

/// Linjeskiftet, filen bruger. Ved blandede linjeskift er det det hyppigste.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
    Cr,
}

impl Eol {
    fn as_str(self) -> &'static str {
        match self {
            Eol::Lf => "\n",
            Eol::Crlf => "\r\n",
            Eol::Cr => "\r",
        }
    }
}

/// Filens tilstand på disken, da programmet sidst læste eller gemte den.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stamp {
    pub size: u64,
    /// Nanosekunder siden 1970. Kun et hurtigt forfilter, hashen er sandheden.
    pub mtime_ns: u64,
    /// blake3 af filens bytes, som hex.
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileMeta {
    pub encoding: Encoding,
    pub eol: Eol,
    /// Filen havde flere slags linjeskift. Et gem ensretter dem og kræver derfor et ja.
    pub mixed_eol: bool,
    pub stamp: Stamp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Opened {
    /// Teksten med `\n` som eneste linjeskift.
    pub text: String,
    pub meta: FileMeta,
}

#[derive(Debug)]
pub enum FileError {
    Io(std::io::Error),
    /// Teksten indeholder tegn, som filens kodning (windows-1252) ikke kan rumme.
    Unencodable,
    /// Filen har blandede linjeskift, og brugeren har ikke sagt ja til at ensrette dem.
    MixedLineEndings,
    /// Filen er ændret på disken siden sidste læsning eller gem. Intet er skrevet.
    ChangedOnDisk {
        current: Stamp,
    },
    /// Filen er slettet eller flyttet, siden den blev åbnet.
    Gone,
}

impl fmt::Display for FileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            // Uden »(os error 5)«: beskeden skal sige, hvad der skete, og hvad man kan gøre (NN/g,
            // testprotokollen 2/10). Teksten er aldrig væk, den står stadig i programmet.
            FileError::Io(e) => match e.kind() {
                std::io::ErrorKind::PermissionDenied => f.write_str(t!(
                    "Filen er skrivebeskyttet, eller du har ikke lov til at gemme her. Har du slået Kontrolleret mappeadgang til i Windows Sikkerhed, skal Gode Tekster have lov dér. Din tekst er ikke væk.",
                    "The file is read-only, or you are not allowed to save here. If Controlled folder access is turned on in Windows Security, Gode Tekster needs permission there. Your text is not lost."
                )),
                std::io::ErrorKind::StorageFull => f.write_str(t!(
                    "Der er ikke plads på drevet. Din tekst er ikke væk.",
                    "The drive is full. Your text is not lost."
                )),
                _ => {
                    let msg = e.to_string();
                    let msg = msg.split(" (os error").next().unwrap_or(&msg);
                    f.write_str(&t!(
                        format!("Filen kunne ikke gemmes: {msg}. Din tekst er ikke væk."),
                        format!("The file could not be saved: {msg}. Your text is not lost.")
                    ))
                }
            },
            FileError::Unencodable => f.write_str(t!(
                "Teksten har tegn, filens gamle kodning ikke kan gemme. Gem som UTF-8 i stedet.",
                "The text has characters the file's old encoding cannot store. Save as UTF-8 instead."
            )),
            FileError::MixedLineEndings => f.write_str(t!(
                "Filen har blandede linjeskift. Den gemmes først, når du har sagt ja til at ensrette dem.",
                "The file has mixed line endings. It will be saved once you agree to make them the same."
            )),
            FileError::ChangedOnDisk { .. } => f.write_str(t!(
                "Filen er rettet udefra.",
                "The file was changed outside Gode Tekster."
            )),
            FileError::Gone => f.write_str(t!(
                "Filen findes ikke længere det sted, den blev åbnet fra.",
                "The file is no longer where it was opened from."
            )),
        }
    }
}

impl std::error::Error for FileError {}

impl From<std::io::Error> for FileError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            FileError::Gone
        } else {
            FileError::Io(e)
        }
    }
}

pub type Result<T> = std::result::Result<T, FileError>;

/// Åbner en fil og husker alt, der skal til for at skrive den tilbage uændret.
pub fn open(path: &Path) -> Result<Opened> {
    let bytes = fs::read(path)?;
    let stamp = stamp_from(&fs::metadata(path)?, &bytes);
    let (raw, encoding) = decode(&bytes);
    let (text, eol, mixed_eol) = normalize_eol(&raw);
    Ok(Opened {
        text,
        meta: FileMeta {
            encoding,
            eol,
            mixed_eol,
            stamp,
        },
    })
}

/// Laver editorens tekst om til filens bytes: linjeskift, kodning og BOM som før.
pub fn encode(text: &str, meta: &FileMeta) -> Result<Vec<u8>> {
    let with_eol = if meta.eol == Eol::Lf {
        text.to_owned()
    } else {
        text.replace('\n', meta.eol.as_str())
    };
    match meta.encoding {
        Encoding::Utf8 => Ok(with_eol.into_bytes()),
        Encoding::Utf8Bom => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(with_eol.as_bytes());
            Ok(out)
        }
        Encoding::Utf16LeBom => {
            let mut out = vec![0xFF, 0xFE];
            for unit in with_eol.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            Ok(out)
        }
        Encoding::Utf16BeBom => {
            let mut out = vec![0xFE, 0xFF];
            for unit in with_eol.encode_utf16() {
                out.extend_from_slice(&unit.to_be_bytes());
            }
            Ok(out)
        }
        Encoding::Windows1252 => {
            let (bytes, _, had_errors) = encoding_rs::WINDOWS_1252.encode(&with_eol);
            if had_errors {
                Err(FileError::Unencodable)
            } else {
                Ok(bytes.into_owned())
            }
        }
    }
}

/// Gemmer atomisk, men kun hvis filen på disken stadig er den, programmet kender (`expected`).
/// `None` betyder en ny fil. Returnerer filens nye stempel.
pub fn save(
    path: &Path,
    text: &str,
    meta: &FileMeta,
    expected: Option<&Stamp>,
    allow_eol_normalize: bool,
) -> Result<Stamp> {
    if meta.mixed_eol && !allow_eol_normalize {
        return Err(FileError::MixedLineEndings);
    }
    if let Some(expected) = expected {
        check_unchanged(path, expected)?;
    }
    let bytes = encode(text, meta)?;
    let target = resolve_target(path)?;
    // Låser et andet program filen, prøves der igen, men først efter et nyt tjek af disken: et
    // program, der skriver i filen lige nu, må ikke få sin ændring overskrevet (trykprøve 3/10).
    let guard = || expected.map_or(Ok(()), |e| check_unchanged(path, e));
    write_atomic_guarded(&target, &bytes, &guard)?;
    Ok(stamp_from(&fs::metadata(&target)?, &bytes))
}

/// Læser filens nuværende stempel (til »er den rettet udefra?«).
pub fn current_stamp(path: &Path) -> Result<Stamp> {
    let bytes = fs::read(path)?;
    Ok(stamp_from(&fs::metadata(path)?, &bytes))
}

/// Kopierer en fil til `backup_dir` med et tidsstempel i navnet, før den overskrives første gang.
pub fn backup(path: &Path, backup_dir: &Path) -> Result<PathBuf> {
    fs::create_dir_all(backup_dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "fil".to_owned());
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dest = backup_dir.join(format!("{now}-{name}"));
    fs::copy(path, &dest)?;
    Ok(dest)
}

// --- indlæsning -------------------------------------------------------------------------------

fn decode(bytes: &[u8]) -> (String, Encoding) {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return (
            String::from_utf8_lossy(rest).into_owned(),
            Encoding::Utf8Bom,
        );
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let (text, _) = encoding_rs::UTF_16LE.decode_without_bom_handling(rest);
        return (text.into_owned(), Encoding::Utf16LeBom);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let (text, _) = encoding_rs::UTF_16BE.decode_without_bom_handling(rest);
        return (text.into_owned(), Encoding::Utf16BeBom);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_owned(), Encoding::Utf8),
        Err(_) => {
            let (text, _) = encoding_rs::WINDOWS_1252.decode_without_bom_handling(bytes);
            (text.into_owned(), Encoding::Windows1252)
        }
    }
}

/// Ensretter til `\n` og finder det hyppigste linjeskift. Ingen linjeskift → LF.
fn normalize_eol(raw: &str) -> (String, Eol, bool) {
    let (mut lf, mut crlf, mut cr) = (0usize, 0usize, 0usize);
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' if chars.peek() == Some(&'\n') => {
                chars.next();
                crlf += 1;
                out.push('\n');
            }
            '\r' => {
                cr += 1;
                out.push('\n');
            }
            '\n' => {
                lf += 1;
                out.push('\n');
            }
            other => out.push(other),
        }
    }
    let kinds = [lf, crlf, cr].iter().filter(|&&n| n > 0).count();
    let eol = if crlf >= lf && crlf >= cr && crlf > 0 {
        Eol::Crlf
    } else if cr > lf && cr > crlf {
        Eol::Cr
    } else {
        Eol::Lf
    };
    (out, eol, kinds > 1)
}

fn stamp_from(meta: &fs::Metadata, bytes: &[u8]) -> Stamp {
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    Stamp {
        size: bytes.len() as u64,
        mtime_ns,
        hash: blake3::hash(bytes).to_hex().to_string(),
    }
}

// --- gem ---------------------------------------------------------------------------------------

/// Stat først (billigt). Kun hvis størrelse eller tid afviger, læses og hashes filen.
/// Er indholdet det samme (fx OneDrive har rørt tiden), er alt i orden.
/// Samme størrelse og ændringstid som sidst: filen er urørt, uden at den læses og hashes.
/// Den åbne fil er væk: er den omdøbt eller flyttet i samme mappe udefra? En fil med præcis de
/// bytes, programmet sidst skrev eller læste, er den samme tekst (testprotokollen 2/10: før tilbød
/// programmet at gemme den på det gamle navn, så der blev to).
pub fn find_moved(path: &Path, expected: &Stamp) -> Option<PathBuf> {
    let dir = path.parent()?;
    let mut candidates = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p != path && p.is_file())
        .filter(|p| {
            let ext = p
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            matches!(ext.as_str(), "md" | "markdown" | "txt")
        })
        // En omdøbning bevarer størrelse og ændringstid til nanosekundet; hashen afgør resten.
        .filter(|p| stat_unchanged(p, expected))
        .filter(|p| {
            std::fs::read(p).is_ok_and(|b| blake3::hash(&b).to_hex().as_str() == expected.hash)
        });
    // Kun når der er præcis én: to ens kopier i mappen er ikke en omdøbning, men et gæt (målt 2/10:
    // den første udgave gemte i en anden fil med samme indhold).
    let first = candidates.next()?;
    candidates.next().is_none().then_some(first)
}

pub fn stat_unchanged(path: &Path, expected: &Stamp) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    meta.len() == expected.size && mtime_ns == expected.mtime_ns
}

fn check_unchanged(path: &Path, expected: &Stamp) -> Result<()> {
    if stat_unchanged(path, expected) {
        return Ok(());
    }
    let current = current_stamp(path)?;
    if current.hash == expected.hash {
        Ok(())
    } else {
        Err(FileError::ChangedOnDisk { current })
    }
}

/// Følger symlinks, så et gem erstatter filen og ikke selve linket.
fn resolve_target(path: &Path) -> Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Ok(fs::canonicalize(path)?),
        _ => Ok(path.to_path_buf()),
    }
}

fn temp_path_for(target: &Path) -> PathBuf {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    // Starter med punktum og ender på .tmp, så OneDrive ikke synkroniserer den (MS-dokumentation).
    dir.join(format!(".{name}.{}-{nanos}.gt.tmp", std::process::id()))
}

/// Skriv atomisk: midlertidig fil i samme mappe, `sync_all`, og så `ReplaceFileW` eller omdøb.
/// Bruges af gem, eksport og Word-import, så der kun er én måde at skrive en fil på.
pub(crate) fn write_atomic(target: &Path, bytes: &[u8]) -> Result<()> {
    write_atomic_guarded(target, bytes, &|| Ok(()))
}

/// Som `write_atomic`, men `guard` kaldes før hvert nyt forsøg, når filen er låst et øjeblik.
fn write_atomic_guarded(target: &Path, bytes: &[u8], guard: &dyn Fn() -> Result<()>) -> Result<()> {
    let tmp = temp_path_for(target);
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    let result = if target.exists() {
        replace_existing(target, &tmp, guard)
    } else {
        fs::rename(&tmp, target).map_err(FileError::from)
    };
    if result.is_err() && tmp.exists() {
        // Originalen er urørt, når ReplaceFileW fejler før byttet. Ryd kun vores egen kladde op.
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(windows)]
fn replace_existing(target: &Path, tmp: &Path, guard: &dyn Fn() -> Result<()>) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        GetLastError, ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION,
        ERROR_UNABLE_TO_MOVE_REPLACEMENT, ERROR_UNABLE_TO_REMOVE_REPLACED,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        REPLACEFILE_IGNORE_ACL_ERRORS, REPLACEFILE_IGNORE_MERGE_ERRORS,
    };

    let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(Some(0)).collect() };
    let target_w = wide(target);
    let tmp_w = wide(tmp);

    let mut last = 0u32;
    for attempt in 0..5u32 {
        guard()?;
        // SAFETY: begge stier er nul-terminerede UTF-16-buffere, der lever hele kaldet.
        let ok = unsafe {
            ReplaceFileW(
                target_w.as_ptr(),
                tmp_w.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_IGNORE_MERGE_ERRORS | REPLACEFILE_IGNORE_ACL_ERRORS,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if ok != 0 {
            return Ok(());
        }
        // SAFETY: læser trådens sidste fejlkode lige efter kaldet.
        last = unsafe { GetLastError() };
        match last {
            // OneDrive, antivirus, søgeindeksering eller et andet program har filen åben et øjeblik.
            // 1175: åben uden lov til sletning. I alle tre tilfælde er begge filer urørte.
            ERROR_SHARING_VIOLATION | ERROR_ACCESS_DENIED | ERROR_UNABLE_TO_REMOVE_REPLACED => {
                std::thread::sleep(Duration::from_millis(60 * u64::from(attempt + 1)));
            }
            ERROR_UNABLE_TO_MOVE_REPLACEMENT => {
                // 1176: originalen er væk, kladden ligger under sit eget navn. Flyt den selv på plads.
                // SAFETY: som ovenfor.
                let moved = unsafe {
                    MoveFileExW(
                        tmp_w.as_ptr(),
                        target_w.as_ptr(),
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                    )
                };
                return if moved != 0 {
                    Ok(())
                } else {
                    Err(FileError::Io(std::io::Error::last_os_error()))
                };
            }
            _ => break,
        }
    }
    Err(FileError::Io(std::io::Error::from_raw_os_error(
        last as i32,
    )))
}

#[cfg(not(windows))]
fn replace_existing(target: &Path, tmp: &Path, _guard: &dyn Fn() -> Result<()>) -> Result<()> {
    fs::rename(tmp, target).map_err(FileError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(bytes: &[u8]) -> (Opened, Vec<u8>) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.md");
        fs::write(&p, bytes).unwrap();
        let o = open(&p).unwrap();
        let back = encode(&o.text, &o.meta).unwrap();
        (o, back)
    }

    #[test]
    fn rundtur_er_byte_identisk() {
        let cases: &[&[u8]] = &[
            b"# Overskrift\n\nTekst med \xc3\xa6\xc3\xb8\xc3\xa5.\n",
            b"Linje 1\r\nLinje 2\r\n",
            b"\xEF\xBB\xBFMed BOM\nog \xc3\xa6\n",
            b"Gammel Mac\rlinje\r",
            b"Ingen afsluttende linjeskift",
            b"",
            b"\xFF\xFEH\x00e\x00j\x00\n\x00",
            b"\xFE\xFF\x00H\x00e\x00j\x00\n",
            b"Gammel dansk \xe6\xf8\xe5 i windows-1252\r\n",
        ];
        for case in cases {
            let (o, back) = roundtrip(case);
            assert_eq!(&back, case, "kodning {:?}", o.meta.encoding);
            assert!(!o.text.contains('\r'));
        }
    }

    #[test]
    fn kodning_og_linjeskift_genkendes() {
        assert_eq!(roundtrip(b"a\r\nb").0.meta.eol, Eol::Crlf);
        assert_eq!(roundtrip(b"a\nb").0.meta.eol, Eol::Lf);
        assert_eq!(
            roundtrip(b"\xe6\xf8\xe5").0.meta.encoding,
            Encoding::Windows1252
        );
        assert_eq!(roundtrip(b"\xe6\xf8\xe5").0.text, "æøå");
        assert_eq!(
            roundtrip(b"\xEF\xBB\xBFx").0.meta.encoding,
            Encoding::Utf8Bom
        );
    }

    /// Trykprøve 3/10: et andet program har filen åben (uden lov til sletning) og skriver i den,
    /// mens der gemmes. Gem må ikke overskrive ændringen, når låsen slipper.
    #[cfg(windows)]
    #[test]
    fn laast_fil_der_aendres_overskrives_ikke() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("laast.md");
        fs::write(&p, "Min tekst\n").unwrap();
        let o = open(&p).unwrap();
        // FILE_SHARE_READ | FILE_SHARE_WRITE, ikke DELETE: som Pythons open().
        let mut other = fs::OpenOptions::new()
            .write(true)
            .share_mode(0x1 | 0x2)
            .open(&p)
            .unwrap();
        let saver = {
            let (p, meta) = (p.clone(), o.meta.clone());
            std::thread::spawn(move || {
                save(&p, "Min tekst, rettet\n", &meta, Some(&meta.stamp), false)
            })
        };
        std::thread::sleep(Duration::from_millis(20));
        other
            .write_all(b"Andens tekst, ny og l\xc3\xa6ngere\n")
            .unwrap();
        other.sync_all().unwrap();
        std::thread::sleep(Duration::from_millis(400));
        drop(other);
        let result = saver.join().unwrap();
        assert!(
            matches!(result, Err(FileError::ChangedOnDisk { .. })),
            "{result:?}"
        );
        assert!(fs::read_to_string(&p).unwrap().starts_with("Andens tekst"));
    }

    #[test]
    fn blandede_linjeskift_kraever_et_ja() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("blandet.md");
        fs::write(&p, b"a\r\nb\nc\r\n").unwrap();
        let o = open(&p).unwrap();
        assert!(o.meta.mixed_eol);
        assert_eq!(o.meta.eol, Eol::Crlf);
        let err = save(&p, &o.text, &o.meta, Some(&o.meta.stamp), false).unwrap_err();
        assert!(matches!(err, FileError::MixedLineEndings));
        assert_eq!(
            fs::read(&p).unwrap(),
            b"a\r\nb\nc\r\n",
            "intet må være skrevet"
        );
        save(&p, &o.text, &o.meta, Some(&o.meta.stamp), true).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"a\r\nb\r\nc\r\n");
    }

    #[test]
    fn tegn_uden_plads_i_windows_1252_afvises() {
        let (o, _) = roundtrip(b"\xe6");
        let err = encode("ł", &o.meta).unwrap_err();
        assert!(matches!(err, FileError::Unencodable));
    }

    #[test]
    fn gem_skriver_ny_tekst_og_bevarer_kodning() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.md");
        fs::write(&p, b"\xEF\xBB\xBFHej\r\n").unwrap();
        let o = open(&p).unwrap();
        let stamp = save(&p, "Hej igen\n", &o.meta, Some(&o.meta.stamp), false).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"\xEF\xBB\xBFHej igen\r\n");
        assert_eq!(stamp, current_stamp(&p).unwrap());
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".gt.tmp"))
            .collect();
        assert!(leftovers.is_empty(), "kladdefiler blev liggende");
    }

    #[test]
    fn omdoebt_udefra_findes_paa_indholdet() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("foer.md");
        fs::write(&p, b"Samme tekst\n").unwrap();
        let o = open(&p).unwrap();
        fs::write(dir.path().join("anden.md"), b"Anden tekst\n").unwrap();
        fs::rename(&p, dir.path().join("efter.md")).unwrap();
        assert_eq!(
            find_moved(&p, &o.meta.stamp),
            Some(dir.path().join("efter.md"))
        );
        // En kopi med samme indhold, men et andet tidspunkt, forveksles ikke.
        fs::write(dir.path().join("kopi.md"), b"Samme tekst\n").unwrap();
        assert_eq!(
            find_moved(&p, &o.meta.stamp),
            Some(dir.path().join("efter.md"))
        );
        // Ændret indhold er ikke den samme tekst.
        fs::write(dir.path().join("efter.md"), b"Rettet\n").unwrap();
        assert_eq!(find_moved(&p, &o.meta.stamp), None);
    }

    #[test]
    fn rettelse_udefra_overskrives_aldrig() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("delt.md");
        fs::write(&p, b"Skribenten skrev\n").unwrap();
        let o = open(&p).unwrap();
        fs::write(&p, b"Claude rettede\n").unwrap();
        let err = save(
            &p,
            "Skribenten skrev mere\n",
            &o.meta,
            Some(&o.meta.stamp),
            false,
        )
        .unwrap_err();
        match err {
            FileError::ChangedOnDisk { current } => {
                assert_eq!(
                    current.hash,
                    blake3::hash(b"Claude rettede\n").to_hex().to_string()
                )
            }
            other => panic!("forventede ChangedOnDisk, fik {other:?}"),
        }
        assert_eq!(fs::read(&p).unwrap(), b"Claude rettede\n");
    }

    #[test]
    fn samme_indhold_med_ny_tid_er_ikke_en_konflikt() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("rørt.md");
        fs::write(&p, b"uaendret\n").unwrap();
        let o = open(&p).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&p, b"uaendret\n").unwrap();
        save(&p, "uaendret og ny\n", &o.meta, Some(&o.meta.stamp), false).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"uaendret og ny\n");
    }

    #[test]
    fn slettet_fil_giver_gone() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("vaek.md");
        fs::write(&p, b"x").unwrap();
        let o = open(&p).unwrap();
        fs::remove_file(&p).unwrap();
        let err = save(&p, "x", &o.meta, Some(&o.meta.stamp), false).unwrap_err();
        assert!(matches!(err, FileError::Gone));
    }

    #[cfg(windows)]
    #[test]
    fn oprettelsestid_bevares_ved_gem() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("gammel.md");
        fs::write(&p, b"v1\n").unwrap();
        let created = fs::metadata(&p).unwrap().created().unwrap();
        std::thread::sleep(Duration::from_millis(50));
        let o = open(&p).unwrap();
        save(&p, "v2\n", &o.meta, Some(&o.meta.stamp), false).unwrap();
        assert_eq!(fs::metadata(&p).unwrap().created().unwrap(), created);
    }

    #[test]
    fn backup_kopierer_originalen() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("org.md");
        fs::write(&p, b"original\n").unwrap();
        let dest = backup(&p, &dir.path().join("backup")).unwrap();
        assert_eq!(fs::read(dest).unwrap(), b"original\n");
    }

    /// Kriterie 1 i plan 1: alle rigtige filer i `tests/private/` (gitignoreret) skal tåle en rundtur.
    /// Springes over, hvis mappen ikke findes.
    #[test]
    fn rigtige_filer_taaler_rundtur() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/private");
        if !root.exists() {
            eprintln!("tests/private findes ikke, springer over");
            return;
        }
        let (mut ok, mut mixed) = (0, 0);
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()) {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|e| e == "md") {
                    let bytes = fs::read(&p).unwrap();
                    let o = open(&p).unwrap();
                    if o.meta.mixed_eol {
                        mixed += 1;
                        continue;
                    }
                    assert_eq!(encode(&o.text, &o.meta).unwrap(), bytes, "{}", p.display());
                    ok += 1;
                }
            }
        }
        eprintln!("rundtur: {ok} filer byte-identiske, {mixed} med blandede linjeskift meldt");
        assert!(ok > 0);
    }
}
