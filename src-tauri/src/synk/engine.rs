//! Én synkrunde (ADR-0054): hent serverens ændringer, gennemgå synkmappen, og afgør for hver fil
//! ud fra basen, disken og serveren, hvad der skal ske (`synk_kerne::plan`).
//!
//! Reglerne, motoren aldrig bryder:
//! - En fil på disken overskrives eller slettes kun, hvis den stadig er den, gennemgangen så.
//!   Er den rettet imens, venter den til næste runde.
//! - Intet slettes, hvis markørfilen mangler (et drev, der ikke er sat i, ligner »alt slettet«).
//! - Sletter én runde mere end bremsen tillader, holdes sletningerne tilbage, og brugeren spørges.
//! - En konflikt koster aldrig tekst: den lokale udgave bliver en kopi ved siden af.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use synk_kerne::filter::{self, Ignorer};
use synk_kerne::plan::{decide, Action};
use synk_kerne::protokol::{Commit, CommitResult, Entry};
use synk_kerne::sti;

use super::state::{Base, State};
use super::transport::Transport;
use crate::files;

/// Markørfilen i synkroden (som Syncthings `.stfolder`).
pub const MARKER: &str = ".godesynk";
/// Bremsen: flere sletninger end dette (eller 5 % af filerne) i én runde kræver et ja.
const BRAKE_MIN: usize = 25;
/// Forsøg pr. fil, når serveren svarer med en nyere udgave undervejs.
const TRIES: usize = 3;

/// Hvad en runde gjorde. Stierne er relative til synkmappen.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub uploaded: Vec<String>,
    pub downloaded: Vec<String>,
    pub deleted_local: Vec<String>,
    pub deleted_remote: Vec<String>,
    pub merged: Vec<String>,
    /// Konfliktkopierne, der blev lavet.
    pub conflicts: Vec<String>,
    /// Filer, hvor en rettelse vandt over en sletning.
    pub resurrected: Vec<String>,
    /// Filer, der ikke kan synkes, med grunden.
    pub skipped: Vec<(String, String)>,
    /// Antal sletninger, bremsen holdt tilbage.
    pub held_deletes: usize,
    pub errors: Vec<String>,
    /// Runden lavede nye filer (konfliktkopier), som skal sendes i en runde mere.
    pub again: bool,
}

/// En fil på disken, som gennemgangen så den.
#[derive(Debug, Clone)]
struct Local {
    path: String,
    native: PathBuf,
    hash: String,
}

pub struct Engine<'a, T: Transport> {
    pub root: PathBuf,
    pub state: &'a State,
    pub transport: &'a T,
    /// Enhedens navn i konfliktkopier (»konflikt fra Telefon …«).
    pub device: String,
    /// Tid til konfliktkopiens navn. En funktion, så testene kan give en fast tid.
    pub now: fn() -> String,
    /// Brugeren har sagt ja til mange sletninger i denne runde.
    pub allow_mass_delete: bool,
}

fn stat(p: &Path) -> Option<(u64, u64)> {
    let m = fs::metadata(p).ok()?;
    let mtime = m
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos() as u64;
    Some((m.len(), mtime))
}

/// Er filen stadig den, gennemgangen så?
fn unchanged(p: &Path, hash: &str) -> bool {
    fs::read(p).is_ok_and(|b| synk_kerne::hash(&b) == hash)
}

/// Junctions, symlinks og OneDrive-pladsholdere følges aldrig (oplægget, »Kendte fælder«).
fn skip_entry(md: &fs::Metadata) -> bool {
    if md.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        const RECALL_ON_OPEN: u32 = 0x40000;
        const RECALL_ON_DATA_ACCESS: u32 = 0x400000;
        if md.file_attributes() & (REPARSE_POINT | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0 {
            return true;
        }
    }
    false
}

/// Teksten med `\n`, og hvordan den skal skrives tilbage.
fn text_of(bytes: &[u8]) -> Option<(String, files::FileMeta)> {
    let (raw, encoding) = files::decode(bytes).ok()?;
    let (text, eol, _) = files::normalize_eol(&raw);
    let meta = files::FileMeta {
        encoding,
        eol,
        mixed_eol: false,
        stamp: files::Stamp {
            size: 0,
            mtime_ns: 0,
            hash: String::new(),
        },
    };
    Some((text, meta))
}

/// Gennemgangen før en runde: disken, basen og serveren for hver fil.
struct Survey {
    local: HashMap<String, Local>,
    bases: HashMap<String, Base>,
    remotes: HashMap<String, Entry>,
    keys: BTreeSet<String>,
    report: Report,
}

/// Hvad en runde ville gøre, uden at gøre det. Vises før den første synk (oplægget: »først en
/// prøvekørsel med tal«).
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub same: usize,
    pub upload: usize,
    pub download: usize,
    pub merge: usize,
    pub delete_local: usize,
    pub delete_remote: usize,
    pub skipped: Vec<(String, String)>,
}

impl<T: Transport> Engine<'_, T> {
    fn survey(&self) -> Result<Survey, String> {
        if !self.root.join(MARKER).is_file() {
            return Err(format!(
                "Synkmappen {} mangler sin markørfil ({MARKER}). Synken venter, så en mappe, der \
                 ikke er tilgængelig, ikke bliver læst som slettet.",
                self.root.display()
            ));
        }
        let ignorer = fs::read_to_string(self.root.join(filter::IGNORE_FILE))
            .map(|t| Ignorer::parse(&t))
            .unwrap_or_default();
        self.pull()?;
        let mut report = Report::default();
        let local = self.scan(&ignorer, &mut report)?;
        let bases = self.state.bases()?;
        let remotes = self.state.remotes()?;
        let mut keys: BTreeSet<String> = BTreeSet::new();
        keys.extend(bases.keys().cloned());
        keys.extend(local.keys().cloned());
        keys.extend(
            remotes
                .iter()
                .filter(|(_, e)| filter::synced(&e.path, e.size, &ignorer))
                .map(|(k, _)| k.clone()),
        );
        Ok(Survey {
            local,
            bases,
            remotes,
            keys,
            report,
        })
    }

    /// Prøvekørslen: tal, intet ændret (ud over at serverens ændringsliste er hentet).
    pub fn preview(&self) -> Result<Preview, String> {
        let s = self.survey()?;
        let mut p = Preview {
            skipped: s.report.skipped,
            ..Preview::default()
        };
        for key in &s.keys {
            match self.action(key, &s.bases, &s.local, &s.remotes) {
                Action::Nothing => p.same += 1,
                Action::Upload | Action::ResurrectUpload => p.upload += 1,
                Action::Download | Action::ResurrectDownload => p.download += 1,
                Action::Merge => p.merge += 1,
                Action::DeleteLocal => p.delete_local += 1,
                Action::DeleteRemote => p.delete_remote += 1,
            }
        }
        Ok(p)
    }

    /// Én hel runde. En fejl, der rammer hele runden (nettet, markøren), er `Err`. Fejl på enkelte
    /// filer står i rapporten, og resten af filerne synkes alligevel.
    pub fn sync_once(&self) -> Result<Report, String> {
        let Survey {
            local,
            bases,
            remotes,
            keys,
            mut report,
        } = self.survey()?;

        // Bremsen afgøres, før noget udføres.
        let deletes = keys
            .iter()
            .filter(|k| {
                matches!(
                    self.action(k, &bases, &local, &remotes),
                    Action::DeleteLocal | Action::DeleteRemote
                )
            })
            .count();
        let limit = BRAKE_MIN.max(bases.len() / 20);
        let hold_deletes = deletes > limit && !self.allow_mass_delete;
        if hold_deletes {
            report.held_deletes = deletes;
        }

        for key in &keys {
            let mut remote = remotes.get(key).cloned();
            for _ in 0..TRIES {
                let base = bases.get(key);
                let action = decide(
                    base.and_then(|b| b.hash.as_deref()),
                    local.get(key).map(|l| l.hash.as_str()),
                    remote.as_ref().and_then(|r| r.hash.as_deref()),
                );
                if hold_deletes && matches!(action, Action::DeleteLocal | Action::DeleteRemote) {
                    break;
                }
                match self.apply(
                    key,
                    action,
                    base,
                    local.get(key),
                    remote.as_ref(),
                    &mut report,
                ) {
                    Ok(None) => break,
                    // Serveren havde en nyere udgave: afgør igen med den.
                    Ok(Some(newer)) => remote = newer,
                    Err(e) if e.starts_with("Ingen forbindelse") => return Err(e),
                    Err(e) => {
                        report.errors.push(format!("{key}: {e}"));
                        break;
                    }
                }
            }
        }
        Ok(report)
    }

    fn action(
        &self,
        key: &str,
        bases: &HashMap<String, Base>,
        local: &HashMap<String, Local>,
        remotes: &HashMap<String, Entry>,
    ) -> Action {
        decide(
            bases.get(key).and_then(|b| b.hash.as_deref()),
            local.get(key).map(|l| l.hash.as_str()),
            remotes.get(key).and_then(|r| r.hash.as_deref()),
        )
    }

    /// Serverens ændringer siden sidst, i sider.
    fn pull(&self) -> Result<(), String> {
        let mut cursor = self.state.cursor()?;
        loop {
            let c = self.transport.changes(cursor)?;
            for e in &c.entries {
                self.state.set_remote(&sti::key(&e.path), e)?;
            }
            cursor = c.seq;
            self.state.set_cursor(cursor)?;
            if !c.more {
                return Ok(());
            }
        }
    }

    fn scan(
        &self,
        ignorer: &Ignorer,
        report: &mut Report,
    ) -> Result<HashMap<String, Local>, String> {
        let mut out: HashMap<String, Local> = HashMap::new();
        let mut dirs = vec![self.root.clone()];
        while let Some(dir) = dirs.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(md) = entry.metadata() else { continue };
                if skip_entry(&md) {
                    continue;
                }
                let Some(rel) = sti::from_native(&self.root, &path) else {
                    continue;
                };
                let name = rel.rsplit('/').next().unwrap_or(&rel);
                if name.starts_with('.') {
                    continue;
                }
                if md.is_dir() {
                    if !ignorer.ignores(&rel) {
                        dirs.push(path);
                    }
                    continue;
                }
                let norm = match sti::normalize(&rel) {
                    Ok(n) => n,
                    Err(e) => {
                        if filter::mergeable(&rel) {
                            report.skipped.push((rel, e.to_string()));
                        }
                        continue;
                    }
                };
                if !filter::synced(&norm, md.len(), ignorer) {
                    continue;
                }
                let key = sti::key(&norm);
                if let Some(other) = out.get(&key) {
                    report.skipped.push((
                        norm,
                        format!(
                            "Hedder det samme som »{}« bortset fra store og små bogstaver.",
                            other.path
                        ),
                    ));
                    continue;
                }
                let Some(hash) = self.hash_of(&key, &path)? else {
                    continue;
                };
                out.insert(
                    key,
                    Local {
                        path: norm,
                        native: path,
                        hash,
                    },
                );
            }
        }
        Ok(out)
    }

    /// Filens hash, fra cachen hvis størrelse og mtime er de samme. `None`, hvis den ikke kan
    /// læses lige nu (låst af et andet program): så prøves den i næste runde.
    fn hash_of(&self, key: &str, path: &Path) -> Result<Option<String>, String> {
        let Some((size, mtime)) = stat(path) else {
            return Ok(None);
        };
        if let Some(h) = self.state.cached(key, size, mtime)? {
            return Ok(Some(h));
        }
        let Ok(bytes) = fs::read(path) else {
            return Ok(None);
        };
        let h = synk_kerne::hash(&bytes);
        self.state.set_cached(key, size, mtime, &h)?;
        Ok(Some(h))
    }

    fn remember(&self, key: &str, path: &Path, hash: &str) -> Result<(), String> {
        if let Some((size, mtime)) = stat(path) {
            self.state.set_cached(key, size, mtime, hash)?;
        }
        Ok(())
    }

    fn agree(&self, key: &str, e: &Entry) -> Result<(), String> {
        self.state.set_remote(key, e)?;
        self.state.set_base(
            key,
            &Base {
                path: e.path.clone(),
                rev: e.rev,
                hash: e.hash.clone(),
            },
        )
    }

    /// Udfør én handling. `Ok(Some(entry))` betyder, at serveren havde en nyere udgave, og at
    /// filen skal afgøres igen med den.
    fn apply(
        &self,
        key: &str,
        action: Action,
        base: Option<&Base>,
        local: Option<&Local>,
        remote: Option<&Entry>,
        report: &mut Report,
    ) -> Result<Option<Option<Entry>>, String> {
        match (action, local, remote) {
            (Action::Nothing, Some(l), Some(r)) if l.path != r.path => {
                // Samme indhold, men store og små bogstaver i navnet er forskellige. Den side, der
                // har ændret stavemåden siden basen, vinder.
                let base_path = base.map(|b| b.path.as_str());
                if base_path == Some(r.path.as_str()) {
                    let result = self.upload(key, l, r.rev)?;
                    if result.is_none() {
                        report.uploaded.push(l.path.clone());
                    }
                    return Ok(result);
                }
                let target = sti::to_native(&self.root, &r.path);
                fs::rename(&l.native, &target).map_err(|e| e.to_string())?;
                self.agree(key, r)?;
                report.downloaded.push(r.path.clone());
                Ok(None)
            }
            (Action::Nothing, _, Some(r)) => {
                if base.is_none_or(|b| b.rev != r.rev || b.hash != r.hash || b.path != r.path) {
                    self.agree(key, r)?;
                }
                Ok(None)
            }
            (Action::Nothing, _, None) => Ok(None),
            (Action::Upload | Action::ResurrectUpload, Some(l), _) => {
                let r = self.upload(key, l, remote.map_or(0, |r| r.rev))?;
                if r.is_none() {
                    if action == Action::ResurrectUpload {
                        report.resurrected.push(l.path.clone());
                    }
                    report.uploaded.push(l.path.clone());
                }
                Ok(r)
            }
            (Action::Download | Action::ResurrectDownload, _, Some(r)) => {
                if self.download(key, local, r)? {
                    if action == Action::ResurrectDownload {
                        report.resurrected.push(r.path.clone());
                    }
                    report.downloaded.push(r.path.clone());
                }
                Ok(None)
            }
            (Action::DeleteRemote, None, Some(r)) => {
                let result = self.transport.commit(&Commit {
                    path: r.path.clone(),
                    base_rev: r.rev,
                    hash: None,
                    size: 0,
                })?;
                match result {
                    CommitResult::Ok { entry } => {
                        self.agree(key, &entry)?;
                        report.deleted_remote.push(r.path.clone());
                        Ok(None)
                    }
                    CommitResult::Conflict { current } => self.newer(key, current),
                }
            }
            (Action::DeleteLocal, Some(l), Some(r)) => {
                if !unchanged(&l.native, &l.hash) {
                    return Ok(None);
                }
                files::to_trash(&l.native)?;
                self.agree(key, r)?;
                report.deleted_local.push(l.path.clone());
                Ok(None)
            }
            (Action::Merge, Some(l), Some(r)) => self.merge(key, base, l, r, report),
            _ => Ok(None),
        }
    }

    /// Serveren svarede med en anden udgave: husk den og afgør igen. Ingen udgave betyder, at
    /// serveren ikke kender filen (eller den allerede er slettet).
    fn newer(&self, key: &str, current: Option<Entry>) -> Result<Option<Option<Entry>>, String> {
        if let Some(e) = &current {
            self.state.set_remote(key, e)?;
        }
        Ok(Some(current))
    }

    fn upload(&self, key: &str, l: &Local, base_rev: u64) -> Result<Option<Option<Entry>>, String> {
        let bytes = fs::read(&l.native).map_err(|e| e.to_string())?;
        if synk_kerne::hash(&bytes) != l.hash {
            // Rettet efter gennemgangen. Næste runde tager den nye udgave.
            return Ok(None);
        }
        self.transport.put_blob(&l.hash, &bytes)?;
        let result = self.transport.commit(&Commit {
            path: l.path.clone(),
            base_rev,
            hash: Some(l.hash.clone()),
            size: bytes.len() as u64,
        })?;
        match result {
            CommitResult::Ok { entry } => {
                self.agree(key, &entry)?;
                Ok(None)
            }
            CommitResult::Conflict { current } => {
                // Samme indhold allerede derovre (et svar, der gik tabt): så er vi enige.
                if let Some(e) = current
                    .as_ref()
                    .filter(|e| e.hash.as_deref() == Some(&l.hash))
                {
                    self.agree(key, e)?;
                    return Ok(None);
                }
                self.newer(key, current)
            }
        }
    }

    /// Hent serverens udgave. Findes filen lokalt, skrives den kun, hvis den er uændret.
    /// Returnerer, om noget blev skrevet.
    fn download(&self, key: &str, local: Option<&Local>, r: &Entry) -> Result<bool, String> {
        let Some(hash) = &r.hash else {
            return Ok(false);
        };
        let bytes = self.transport.get_blob(hash)?;
        let target = match local {
            Some(l) => {
                if !unchanged(&l.native, &l.hash) {
                    return Ok(false);
                }
                files::write_atomic(&l.native, &bytes).map_err(|e| e.to_string())?;
                l.native.clone()
            }
            None => {
                let target = sti::to_native(&self.root, &r.path);
                if let Some(dir) = target.parent() {
                    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                if let Err(e) = files::write_atomic_new(&target, &bytes) {
                    if target.exists() {
                        // Lavet lokalt efter gennemgangen. Næste runde fletter.
                        return Ok(false);
                    }
                    return Err(e.to_string());
                }
                target
            }
        };
        self.remember(key, &target, hash)?;
        self.agree(key, r)?;
        Ok(true)
    }

    /// Begge har rettet. Tekst med en kendt base flettes, når rettelserne rører hver sin linje.
    /// Ellers bliver den lokale udgave en konfliktkopi, og serverens kommer på filens plads.
    fn merge(
        &self,
        key: &str,
        base: Option<&Base>,
        l: &Local,
        r: &Entry,
        report: &mut Report,
    ) -> Result<Option<Option<Entry>>, String> {
        let Some(remote_hash) = &r.hash else {
            return Ok(None);
        };
        let local_bytes = fs::read(&l.native).map_err(|e| e.to_string())?;
        if synk_kerne::hash(&local_bytes) != l.hash {
            return Ok(None);
        }
        let remote_bytes = self.transport.get_blob(remote_hash)?;
        let base_hash = base.and_then(|b| b.hash.as_deref());
        if let (true, Some(bh)) = (filter::mergeable(&l.path), base_hash) {
            let base_bytes = self.transport.get_blob(bh)?;
            if let (Some((b, _)), Some((mine, meta)), Some((theirs, _))) = (
                text_of(&base_bytes),
                text_of(&local_bytes),
                text_of(&remote_bytes),
            ) {
                let m = crate::merge::merge(&b, &mine, &theirs);
                if !m.conflict {
                    let merged = crate::merge::apply(&mine, &m.changes);
                    let bytes = files::encode(&merged, &meta).map_err(|e| e.to_string())?;
                    files::write_atomic(&l.native, &bytes).map_err(|e| e.to_string())?;
                    let h = synk_kerne::hash(&bytes);
                    self.remember(key, &l.native, &h)?;
                    let merged_local = Local {
                        path: l.path.clone(),
                        native: l.native.clone(),
                        hash: h,
                    };
                    let result = self.upload(key, &merged_local, r.rev)?;
                    if result.is_none() {
                        report.merged.push(l.path.clone());
                    }
                    return Ok(result);
                }
            }
        }
        // Programmets egen, urørte hilsen er ikke brugerens tekst. Den skal ikke gemmes som kopi.
        if crate::welcome::untouched(&l.path, &local_bytes) {
            files::write_atomic(&l.native, &remote_bytes).map_err(|e| e.to_string())?;
            self.remember(key, &l.native, remote_hash)?;
            self.agree(key, r)?;
            return Ok(None);
        }
        // Konfliktkopien først, så den lokale tekst er sikret, før filen får serverens udgave.
        let copy = self.free_conflict_name(&l.path);
        let copy_native = sti::to_native(&self.root, &copy);
        files::write_atomic_new(&copy_native, &local_bytes).map_err(|e| e.to_string())?;
        files::write_atomic(&l.native, &remote_bytes).map_err(|e| e.to_string())?;
        self.remember(key, &l.native, remote_hash)?;
        self.agree(key, r)?;
        report.conflicts.push(copy);
        report.again = true;
        Ok(None)
    }

    fn free_conflict_name(&self, path: &str) -> String {
        let when = (self.now)();
        let name = sti::conflict_name(path, &self.device, &when);
        let mut candidate = name.clone();
        let mut n = 2;
        while sti::to_native(&self.root, &candidate).exists() {
            candidate = sti::conflict_name(path, &self.device, &format!("{when} {n}"));
            n += 1;
        }
        candidate
    }
}
