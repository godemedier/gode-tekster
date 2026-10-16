//! Simulationstesten (planen, fase 2): flere enheder, tilfældige rettelser mod samme lager, og
//! svar der går tabt. Som Dropbox' tests af Nucleus er den ikke valgfri: synken er den del af
//! programmet, hvor en fejl koster tekst.
//!
//! Invarianterne:
//! 1. **Intet går tabt.** Hver rettelse indsætter et unikt mærke og fjerner aldrig noget. Når det er
//!    stille, står hvert mærke i en fil hos alle (i filen selv eller i en konfliktkopi). Gælder
//!    kun uden sletninger; med sletninger må et mærke forsvinde med sin fil.
//! 2. **Alle ender ens.** Efter et par stille runder har alle enheder de samme filer med samme
//!    indhold, og serveren har præcis dem.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use synk_kerne::protokol::{Changes, Commit, CommitResult};
use synk_kerne::store::Store;

use super::engine::{Engine, MARKER};
use super::state::State;
use super::transport::Transport;

/// En lille, forudsigelig tilfældighedsgenerator, så en fejl kan genskabes med sit frø.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

/// Lageret i samme proces. Kan »tabe« svaret på en commit, der faktisk er gennemført, eller fejle
/// før den når frem: de to tilfælde, en enhed på et dårligt net skal tåle.
struct Local<'a> {
    store: &'a Store,
    device: String,
    lose_reply: Cell<u64>,
    fail_before: Cell<u64>,
    rng: Cell<u64>,
}

impl Local<'_> {
    fn roll(&self, percent: u64) -> bool {
        let mut r = Rng(self.rng.get());
        let hit = r.chance(percent);
        self.rng.set(r.0);
        hit
    }
}

const NET: &str = "Ingen forbindelse til synkserveren: simuleret";

impl Transport for Local<'_> {
    fn changes(&self, since: u64) -> Result<Changes, String> {
        self.store.changes(since, 7).map_err(|e| e.to_string())
    }
    fn get_blob(&self, hash: &str) -> Result<Vec<u8>, String> {
        self.store
            .get_blob(hash)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "blob mangler".into())
    }
    fn put_blob(&self, hash: &str, bytes: &[u8]) -> Result<(), String> {
        self.store.put_blob(hash, bytes).map_err(|e| e.to_string())
    }
    fn commit(&self, c: &Commit) -> Result<CommitResult, String> {
        if self.roll(self.fail_before.get()) {
            return Err(NET.into());
        }
        let r = self
            .store
            .commit(c, &self.device)
            .map_err(|e| e.to_string())?;
        if self.roll(self.lose_reply.get()) {
            return Err(NET.into());
        }
        Ok(r)
    }
}

struct Device {
    root: PathBuf,
    state: State,
    name: String,
}

fn fixed_now() -> String {
    "2026-10-14 12.00".into()
}

fn sync(d: &Device, t: &Local<'_>) -> Result<super::engine::Report, String> {
    let e = Engine {
        root: d.root.clone(),
        state: &d.state,
        transport: t,
        device: d.name.clone(),
        now: fixed_now,
        allow_mass_delete: true,
    };
    let mut r = e.sync_once()?;
    // Konfliktkopier sendes i en runde mere, som appen gør.
    while r.again {
        r = e.sync_once()?;
    }
    Ok(r)
}

/// Alle synkede filer under `root`: relativ sti → indhold.
fn files_of(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let p = e.path();
            let rel = synk_kerne::sti::from_native(root, &p).unwrap_or_default();
            if rel.starts_with('.') || rel.contains("/.") {
                continue;
            }
            if p.is_dir() {
                dirs.push(p);
            } else if let Ok(t) = fs::read_to_string(&p) {
                out.insert(rel, t);
            }
        }
    }
    out
}

const NAMES: &[&str] = &[
    "Kapitel 1.md",
    "kapitel 1.md",
    "Noter/Idé.md",
    "Noter/Liste.md",
    "Skriv/Æblet.md",
    "Skriv/Ny mappe/Udkast.md",
];

fn run(seed: u64, steps: usize, deletes: bool) {
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let store = Store::open(&tmp.path().join("server")).unwrap_or_else(|e| panic!("{e}"));
    let mut rng = Rng(seed);
    let devices: Vec<Device> = ["Pc", "Telefon", "Bærbar"]
        .iter()
        .map(|n| {
            let root = tmp.path().join(n);
            fs::create_dir_all(&root).unwrap_or_else(|e| panic!("{e}"));
            fs::write(root.join(MARKER), "").unwrap_or_else(|e| panic!("{e}"));
            Device {
                root,
                state: State::in_memory().unwrap_or_else(|e| panic!("{e}")),
                name: (*n).into(),
            }
        })
        .collect();
    let transports: Vec<Local<'_>> = devices
        .iter()
        .enumerate()
        .map(|(i, d)| Local {
            store: &store,
            device: d.name.clone(),
            lose_reply: Cell::new(8),
            fail_before: Cell::new(5),
            rng: Cell::new(seed ^ ((i as u64 + 1) * 0x9E37_79B9)),
        })
        .collect();

    let mut marks: BTreeSet<String> = BTreeSet::new();
    for step in 0..steps {
        let i = rng.below(devices.len());
        let d = &devices[i];
        let existing: Vec<String> = files_of(&d.root).into_keys().collect();
        match rng.below(10) {
            // Ny fil eller rettelse: et mærke, der aldrig fjernes igen.
            0..=4 => {
                let name = if !existing.is_empty() && rng.chance(70) {
                    existing[rng.below(existing.len())].clone()
                } else {
                    NAMES[rng.below(NAMES.len())].to_owned()
                };
                let path = synk_kerne::sti::to_native(&d.root, &name);
                let old = fs::read_to_string(&path).unwrap_or_default();
                let mark = format!("«{seed}-{step}»");
                let mut paras: Vec<String> = old
                    .split("\n\n")
                    .filter(|p| !p.trim().is_empty())
                    .map(str::to_owned)
                    .collect();
                if paras.is_empty() || rng.chance(40) {
                    let at = rng.below(paras.len() + 1);
                    paras.insert(at, format!("Afsnit {mark}"));
                } else {
                    let at = rng.below(paras.len());
                    paras[at] = format!("{} {mark}", paras[at]);
                }
                if let Some(dir) = path.parent() {
                    fs::create_dir_all(dir).unwrap_or_else(|e| panic!("{e}"));
                }
                // To filer, der kun adskiller sig på store bogstaver, kan ikke ligge i samme mappe på
                // Windows. Testen kører på Windows, så den skriver bare i den, der findes.
                fs::write(&path, paras.join("\n\n") + "\n").unwrap_or_else(|e| panic!("{e}"));
                if !deletes {
                    marks.insert(mark);
                }
            }
            // Omdøb: indholdet flytter med.
            5 if !existing.is_empty() && !deletes => {
                let from = &existing[rng.below(existing.len())];
                let to = format!("Omdøbt {step}.md");
                let _ = fs::rename(
                    synk_kerne::sti::to_native(&d.root, from),
                    synk_kerne::sti::to_native(&d.root, &to),
                );
            }
            6 if deletes && !existing.is_empty() => {
                let victim = &existing[rng.below(existing.len())];
                let _ = fs::remove_file(synk_kerne::sti::to_native(&d.root, victim));
            }
            _ => {
                let _ = sync(d, &transports[i]);
            }
        }
    }

    // Stille: intet net svigter, og alle synker et par gange.
    for t in &transports {
        t.lose_reply.set(0);
        t.fail_before.set(0);
    }
    for _ in 0..4 {
        for (d, t) in devices.iter().zip(&transports) {
            let r = sync(d, t).unwrap_or_else(|e| panic!("frø {seed}: {e}"));
            assert!(r.errors.is_empty(), "frø {seed}: {:?}", r.errors);
        }
    }

    let first = files_of(&devices[0].root);
    for d in &devices[1..] {
        let other = files_of(&d.root);
        assert_eq!(
            first.keys().collect::<Vec<_>>(),
            other.keys().collect::<Vec<_>>(),
            "frø {seed}: {} har andre filer end {}",
            d.name,
            devices[0].name
        );
        for (k, v) in &first {
            assert_eq!(
                Some(v),
                other.get(k),
                "frø {seed}: {k} er forskellig hos {}",
                d.name
            );
        }
    }
    // Serveren har præcis de samme levende filer.
    let mut on_server = BTreeMap::new();
    let changes = store.changes(0, 100_000).unwrap_or_else(|e| panic!("{e}"));
    for e in changes.entries.iter().filter(|e| !e.deleted()) {
        on_server.insert(synk_kerne::sti::key(&e.path), e.hash.clone());
    }
    let mine: BTreeMap<String, Option<String>> = first
        .iter()
        .map(|(k, v)| {
            (
                synk_kerne::sti::key(k),
                Some(synk_kerne::hash(v.as_bytes())),
            )
        })
        .collect();
    assert_eq!(mine, on_server, "frø {seed}: serveren afviger");

    let all: String = first.values().cloned().collect();
    for m in &marks {
        assert!(
            all.contains(m.as_str()),
            "frø {seed}: mærket {m} er forsvundet"
        );
    }
}

/// Antal forløb: få i commit-gaten, mange med `GT_SIM_FORLOEB=500 cargo test --lib synk::sim`.
fn runs() -> u64 {
    std::env::var("GT_SIM_FORLOEB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4)
}

#[test]
fn intet_gaar_tabt_uden_sletninger() {
    for seed in 1..=runs() {
        run(seed * 7919, 120, false);
    }
}

#[test]
fn alle_ender_ens_med_sletninger() {
    for seed in 1..=runs() {
        run(seed * 104_729, 120, true);
    }
}

/// To enheder med hver sin hilsen fra programmet (16/10): den urørte giver ingen konfliktkopi.
#[test]
fn uroert_hilsen_giver_ingen_konfliktkopi() {
    let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let store = Store::open(&tmp.path().join("server")).unwrap_or_else(|e| panic!("{e}"));
    let welcome = format!("Gode Tekster/{}", crate::welcome::WELCOME_NAME);
    let bundled = include_str!("../../welcome/velkommen.md").replace("\r\n", "\n");
    let mut out = Vec::new();
    for (name, text) in [
        ("Pc", "# Velkommen\n\nEn ældre udgave.\n"),
        ("Telefon", bundled.as_str()),
    ] {
        let root = tmp.path().join(name);
        fs::create_dir_all(root.join("Gode Tekster")).unwrap_or_else(|e| panic!("{e}"));
        fs::write(root.join(MARKER), "").unwrap_or_else(|e| panic!("{e}"));
        fs::write(synk_kerne::sti::to_native(&root, &welcome), text)
            .unwrap_or_else(|e| panic!("{e}"));
        let d = Device {
            root,
            state: State::in_memory().unwrap_or_else(|e| panic!("{e}")),
            name: name.into(),
        };
        let t = Local {
            store: &store,
            device: name.into(),
            lose_reply: Cell::new(0),
            fail_before: Cell::new(0),
            rng: Cell::new(1),
        };
        let r = sync(&d, &t).unwrap_or_else(|e| panic!("{e}"));
        out.push((d, r));
    }
    let (phone, report) = &out[1];
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    let files = files_of(&phone.root);
    assert_eq!(files.len(), 1, "{:?}", files.keys());
    assert_eq!(files[&welcome], "# Velkommen\n\nEn ældre udgave.\n");
}
