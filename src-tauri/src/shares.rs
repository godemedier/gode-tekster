//! Delinger fra pc'en (ADR-0060). Serveren har delen og hver persons udgave. Pc'en husker resten:
//! hvilken tekst delen kom fra, hele teksten og delen, som de så ud ved deling, og for hvert link
//! den udgave, forslagene sidst blev hentet ind fra (`shadow`). Det er grundlaget for
//! trevejsfletningen i `src/share/merge.ts`, så de samme forslag aldrig hentes ind to gange.
//!
//! Gemmes i `<data>\delinger.json`. Linkene står der også, så de kan kopieres igen. Et link giver
//! kun adgang til den del, det blev lavet til, og kan stoppes.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use synk_kerne::protokol::{NewShare, ShareInfo};
use tauri::AppHandle;

use crate::merge::{apply, edits, merge, Change};
use crate::synk::service::http;

/// Én læs-ret-skriv ad gangen på filen.
static FILE: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLink {
    pub id: String,
    pub name: String,
    pub url: String,
    /// Hele teksten med gæstens forslag, som de var, da de sidst blev hentet ind.
    pub shadow: String,
    /// Gæstens revision ved sidste hentning.
    pub fetched_rev: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShare {
    pub id: String,
    pub path: String,
    pub title: String,
    pub created: i64,
    /// Hele teksten ved deling.
    pub snapshot: String,
    /// Hvor delen stod i `snapshot` (positioner i fladens tegn, UTF-16).
    pub from: u64,
    pub to: u64,
    /// Det, serveren fik: delen uden det private.
    pub base: String,
    /// Det private, der blev taget ud af delen (`src/share/extract.ts`).
    pub removed: Vec<Removed>,
    pub links: Vec<LocalLink>,
}

/// Noter, parkeret og dæmpet tekst, taget ud af delen: hvor det stod i basen, og hvad det var.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Removed {
    pub at: u64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub path: String,
    pub title: String,
    pub snapshot: String,
    pub from: u64,
    pub to: u64,
    pub base: String,
    pub removed: Vec<Removed>,
    pub names: Vec<String>,
    pub days: Option<u32>,
}

/// En deling, som ruden viser den: pc'ens viden og serverens status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareView {
    pub id: String,
    pub title: String,
    pub path: Option<String>,
    pub created: i64,
    pub expires: i64,
    pub revoked: bool,
    pub links: Vec<LinkView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkView {
    pub id: String,
    pub name: String,
    pub url: Option<String>,
    pub rev: u64,
    pub fetched_rev: u64,
    pub updated: Option<i64>,
    pub last_seen: Option<i64>,
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    crate::paths::data_dir(app).map(|d| d.join("delinger.json"))
}

fn not_read(e: impl std::fmt::Display) -> String {
    t!(
        format!("Listen over delinger kunne ikke læses: {e}"),
        format!("The list of shares could not be read: {e}")
    )
}

fn load(app: &AppHandle) -> Result<Vec<LocalShare>, String> {
    let f = file(app)?;
    match std::fs::read(&f) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(not_read),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(not_read(e)),
    }
}

fn save(app: &AppHandle, shares: &[LocalShare]) -> Result<(), String> {
    let f = file(app)?;
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(shares).map_err(|e| e.to_string())?;
    crate::files::write_atomic(&f, &json).map_err(|e| {
        t!(
            format!("Listen over delinger kunne ikke gemmes: {e}"),
            format!("The list of shares could not be saved: {e}")
        )
    })
}

fn update(
    app: &AppHandle,
    change: impl FnOnce(&mut Vec<LocalShare>) -> Result<(), String>,
) -> Result<(), String> {
    let _lock = FILE.lock().unwrap_or_else(|e| e.into_inner());
    let mut shares = load(app)?;
    change(&mut shares)?;
    save(app, &shares)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Del en del af en tekst med navngivne personer. Giver delingen med et link pr. person.
#[tauri::command]
pub async fn share_create(app: AppHandle, req: CreateRequest) -> Result<ShareView, String> {
    blocking(move || {
        let http = http(&app)?;
        // »Dit navn« følger med, så modtageren kan se, hvem teksten er fra (gæstens side, 21/10).
        let from = Some(crate::settings::author_name(&app)).filter(|n| !n.is_empty());
        let info = http.create_share(&NewShare {
            title: req.title.clone(),
            text: req.base.clone(),
            names: req.names.clone(),
            days: req.days,
            from,
        })?;
        let links: Vec<LocalLink> = info
            .links
            .iter()
            .map(|l| LocalLink {
                id: l.id.clone(),
                name: l.name.clone(),
                url: format!(
                    "{}/del/{}",
                    http.base(),
                    l.token.as_deref().unwrap_or_default()
                ),
                shadow: req.snapshot.clone(),
                fetched_rev: 1,
            })
            .collect();
        let local = LocalShare {
            id: info.id.clone(),
            path: req.path,
            title: info.title.clone(),
            created: info.created,
            snapshot: req.snapshot,
            from: req.from,
            to: req.to,
            base: req.base,
            removed: req.removed,
            links,
        };
        let view = view_of(&info, Some(&local));
        update(&app, |all| {
            all.push(local);
            Ok(())
        })?;
        Ok(view)
    })
    .await
}

fn view_of(info: &ShareInfo, local: Option<&LocalShare>) -> ShareView {
    ShareView {
        id: info.id.clone(),
        title: info.title.clone(),
        path: local.map(|l| l.path.clone()),
        created: info.created,
        expires: info.expires,
        revoked: info.revoked,
        links: info
            .links
            .iter()
            .map(|l| {
                let mine = local.and_then(|s| s.links.iter().find(|x| x.id == l.id));
                LinkView {
                    id: l.id.clone(),
                    name: l.name.clone(),
                    url: mine.map(|m| m.url.clone()),
                    rev: l.rev,
                    fetched_rev: mine.map(|m| m.fetched_rev).unwrap_or(l.rev),
                    updated: l.updated,
                    last_seen: l.last_seen,
                }
            })
            .collect(),
    }
}

/// Alle delinger med serverens status. Delinger lavet fra en anden pc har ingen sti og intet link.
#[tauri::command]
pub async fn share_list(app: AppHandle) -> Result<Vec<ShareView>, String> {
    blocking(move || {
        let server = http(&app)?.shares()?;
        let local = load(&app)?;
        Ok(server
            .iter()
            .map(|s| view_of(s, local.iter().find(|l| l.id == s.id)))
            .collect())
    })
    .await
}

fn u16len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Hvor positionen `p` i `edits`' udgangstekst står efter ændringerne. Står en indsættelse lige
/// ved `p`, kommer positionen efter den.
fn map_pos(edits: &[Change], p: usize) -> usize {
    let mut delta: isize = 0;
    for e in edits {
        if e.to <= p {
            delta += u16len(&e.insert) as isize - (e.to - e.from) as isize;
        } else if e.from < p {
            return (e.from as isize + delta).max(0) as usize + u16len(&e.insert);
        } else {
            break;
        }
    }
    (p as isize + delta).max(0) as usize
}

/// Gæstens udgave med det private sat ind igen, der hvor det stod.
pub fn restore(base: &str, guest: &str, removed: &[Removed]) -> String {
    let e = edits(base, guest);
    let changes: Vec<Change> = removed
        .iter()
        .map(|r| {
            let at = map_pos(&e, r.at as usize);
            Change {
                from: at,
                to: at,
                insert: r.text.clone(),
            }
        })
        .collect();
    apply(guest, &changes)
}

/// UTF-16-positionen `u` som byte-position i `s`.
fn byte_at(s: &str, u: usize) -> usize {
    let mut n = 0;
    for (i, c) in s.char_indices() {
        if n >= u {
            return i;
        }
        n += c.len_utf16();
    }
    s.len()
}

/// Udfaldet af »Hent forslag«.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    /// Intet nyt siden sidst.
    Nothing,
    /// Ændringerne til editorens tekst og grundlaget til næste gang.
    Changes {
        changes: Vec<Change>,
        shadow: String,
    },
    /// Skribenten har rettet samme sted. Gæstens udgave af delen, med det private sat ind.
    Conflict { part: String },
}

/// Flet gæstens udgave ind i teksten, som den står nu. `shadow` er hele teksten med gæstens
/// forslag fra sidste hentning (eller teksten ved deling), så kun det nye kommer med.
pub fn merge_back(local: &LocalShare, shadow: &str, guest: &str, current: &str) -> Outcome {
    let part = restore(&local.base, guest, &local.removed);
    let snap = &local.snapshot;
    let (a, b) = (
        byte_at(snap, local.from as usize),
        byte_at(snap, local.to as usize),
    );
    let theirs = format!("{}{}{}", &snap[..a], part, &snap[b..]);
    if theirs == shadow {
        return Outcome::Nothing;
    }
    let m = merge(shadow, current, &theirs);
    if m.conflict {
        return Outcome::Conflict { part };
    }
    Outcome::Changes {
        changes: m.changes,
        shadow: theirs,
    }
}

/// Gæstens tekst er data. Programmets skjulte blokke (`<!-- gt:… -->`) kommer aldrig fra en gæst,
/// for basen har dem ikke (`extract.ts` tager dem ud). Skriver gæsten én, gøres den uskadelig, før
/// den kan blive til en lydfil, et mål eller et parkeret stykke hos skribenten (gennemgang 22/10).
fn defuse(guest: String) -> String {
    if guest.contains("<!-- gt:") {
        guest.replace("<!-- gt:", "<!-- gæst:")
    } else {
        guest
    }
}

/// Svaret på »Hent forslag«: udfaldet og det, fladen skal tjekke og huske.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    pub outcome: Outcome,
    /// Basen og gæstens udgave, så fladen kan se, om gæsten har rettet uden om forslagene.
    pub base: String,
    pub guest: String,
    pub rev: u64,
    pub path: String,
}

/// Hent forslagene fra ét link og flet dem ind i `current` (editorens tekst). Intet gemmes her:
/// fladen kalder `share_fetched`, når ændringerne står i editoren.
#[tauri::command]
pub async fn share_merge(
    app: AppHandle,
    id: String,
    link: String,
    current: String,
) -> Result<Fetched, String> {
    blocking(move || {
        let local = load(&app)?.into_iter().find(|l| l.id == id).ok_or(t!(
            "Delingen er lavet på en anden pc. Forslagene kan kun hentes ind dér.",
            "The share was made on another PC. The suggestions can only be fetched there."
        ))?;
        let shadow = local
            .links
            .iter()
            .find(|l| l.id == link)
            .map(|l| l.shadow.clone())
            .ok_or(t!(
                "Linket findes ikke længere på denne pc.",
                "The link no longer exists on this PC."
            ))?;
        let server = http(&app)?.share(&id)?;
        let copy = server.links.into_iter().find(|l| l.id == link).ok_or(t!(
            "Linket findes ikke længere på serveren.",
            "The link no longer exists on the server."
        ))?;
        let guest = defuse(copy.text.unwrap_or_default());
        Ok(Fetched {
            outcome: merge_back(&local, &shadow, &guest, &current),
            base: local.base.clone(),
            guest,
            rev: copy.rev,
            path: local.path,
        })
    })
    .await
}

/// Forslagene fra et link er hentet ind: husk grundlaget til næste gang.
#[tauri::command]
pub async fn share_fetched(
    app: AppHandle,
    id: String,
    link: String,
    shadow: String,
    rev: u64,
) -> Result<(), String> {
    blocking(move || {
        update(&app, |all| {
            let l = all
                .iter_mut()
                .find(|s| s.id == id)
                .and_then(|s| s.links.iter_mut().find(|l| l.id == link))
                .ok_or(t!(
                    "Delingen findes ikke længere på denne pc.",
                    "The share no longer exists on this PC."
                ))?;
            l.shadow = shadow;
            l.fetched_rev = rev;
            Ok(())
        })
    })
    .await
}

/// Stop en deling (linkene holder op med at virke), eller slet den helt, også her.
#[tauri::command]
pub async fn share_end(app: AppHandle, id: String, delete: bool) -> Result<(), String> {
    blocking(move || {
        http(&app)?.end_share(&id, delete)?;
        if delete {
            update(&app, |all| {
                all.retain(|s| s.id != id);
                Ok(())
            })?;
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gaestens_skjulte_blokke_goeres_uskadelige() {
        let guest = "Hej {++<!-- gt:lyd {\"audio\":\"..\\\\x.wav\"} -->++} der.".to_owned();
        let out = defuse(guest);
        assert!(!out.contains("<!-- gt:"), "{out}");
        assert!(out.contains("<!-- gæst:lyd"), "{out}");
        assert_eq!(defuse("Ingen blokke.".into()), "Ingen blokke.");
    }

    /// »Del« af afsnit 2 i en tekst med en note i afsnittet.
    fn share() -> LocalShare {
        let snapshot = "# Titel\n\nFørste afsnit.\n\nDet var en mørk <!-- tjek --> aften. Vi gik hjem.\n\nSidste.\n";
        // Positionerne er UTF-16 som i fladen, ikke bytes: »ø« er to bytes, men ét tegn.
        let u16 = |needle: &str| u16len(&snapshot[..snapshot.find(needle).unwrap_or(0)]);
        let (from, to) = (u16("Det var"), u16("\n\nSidste"));
        LocalShare {
            id: "d1".into(),
            path: "C:/Tekster/Kapitel.md".into(),
            title: "Kapitel".into(),
            created: 0,
            snapshot: snapshot.into(),
            from: from as u64,
            to: to as u64,
            base: "Det var en mørk aften. Vi gik hjem.".into(),
            removed: vec![Removed {
                at: 15,
                text: " <!-- tjek -->".into(),
            }],
            links: Vec::new(),
        }
    }

    fn apply_outcome(current: &str, o: &Outcome) -> String {
        match o {
            Outcome::Changes { changes, .. } => apply(current, changes),
            other => panic!("ventede ændringer: {other:?}"),
        }
    }

    #[test]
    fn noten_kommer_tilbage_der_hvor_den_stod() {
        let s = share();
        let guest = "Det var en {++kold og ++}mørk aften. {~~Vi gik hjem.~>Så gik vi hjem.~~}";
        assert_eq!(
            restore(&s.base, guest, &s.removed),
            "Det var en {++kold og ++}mørk <!-- tjek --> aften. {~~Vi gik hjem.~>Så gik vi hjem.~~}"
        );
    }

    #[test]
    fn forslagene_flettes_ind_og_skribentens_rettelser_bliver() {
        let s = share();
        // Skribenten har imens rettet første afsnit.
        let current = s.snapshot.replace("Første afsnit.", "Det første afsnit.");
        let guest = "Det var en mørk aften. {~~Vi gik hjem.~>Så gik vi hjem.~~}";
        let o = merge_back(&s, &s.snapshot, guest, &current);
        let merged = apply_outcome(&current, &o);
        assert_eq!(
            merged,
            "# Titel\n\nDet første afsnit.\n\nDet var en mørk <!-- tjek --> aften. {~~Vi gik hjem.~>Så gik vi hjem.~~}\n\nSidste.\n"
        );

        // Næste hentning med det nye grundlag: kun gæstens nye forslag kommer med, også efter
        // at skribenten har godtaget det første.
        let Outcome::Changes { shadow, .. } = o else {
            panic!("ingen skygge")
        };
        let accepted = merged.replace("{~~Vi gik hjem.~>Så gik vi hjem.~~}", "Så gik vi hjem.");
        assert_eq!(merge_back(&s, &shadow, guest, &accepted), Outcome::Nothing);
        let more =
            "Det var en mørk aften. {~~Vi gik hjem.~>Så gik vi hjem.~~}\n\n{++Et nyt afsnit.++}";
        let o = merge_back(&s, &shadow, more, &accepted);
        assert_eq!(
            apply_outcome(&accepted, &o),
            "# Titel\n\nDet første afsnit.\n\nDet var en mørk <!-- tjek --> aften. Så gik vi hjem.\n\n{++Et nyt afsnit.++}\n\nSidste.\n"
        );
    }

    #[test]
    fn samme_sted_giver_en_konflikt_med_gaestens_udgave() {
        let s = share();
        let current = s.snapshot.replace("Vi gik hjem.", "Vi løb hjem.");
        let guest = "Det var en mørk aften. {~~Vi gik hjem.~>Så gik vi hjem.~~}";
        assert_eq!(
            merge_back(&s, &s.snapshot, guest, &current),
            Outcome::Conflict {
                part: "Det var en mørk <!-- tjek --> aften. {~~Vi gik hjem.~>Så gik vi hjem.~~}"
                    .into()
            }
        );
    }

    #[test]
    fn positioner_er_utf16_som_i_fladen() {
        // Emoji før delen: to UTF-16-enheder, fire bytes.
        let mut s = share();
        s.snapshot = format!("😀{}", s.snapshot);
        s.from += 2;
        s.to += 2;
        let guest = "Det var en mørk aften. {++Ja.++} Vi gik hjem.";
        let o = merge_back(&s, &s.snapshot.clone(), guest, &s.snapshot.clone());
        assert!(apply_outcome(&s.snapshot, &o).starts_with("😀# Titel"));
        assert!(apply_outcome(&s.snapshot, &o).contains("aften. {++Ja.++} Vi gik"));
    }
}
