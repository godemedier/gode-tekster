//! Rettelser udefra, mens skribenten skriver (2/10). Tre udgaver: `base` (sidst gemt eller
//! indlæst), `mine` (editoren) og `theirs` (disken). Rettelserne fra `base` til `theirs` flyttes
//! over i editorens tekst som almindelige ændringer, så markøren og fortryd overlever. Har begge
//! rettet på samme linje, er det en konflikt, og skribenten vælger. Hellere spørge én gang for
//! meget end at flette midt i en sætning, der er ved at blive skrevet.
//!
//! Positionerne er UTF-16, som editoren bruger.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Merge {
    pub conflict: bool,
    /// Ændringerne i editorens koordinater (`mine`), klar til én CodeMirror-transaktion.
    pub changes: Vec<Change>,
}

fn u16len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Et stykke af en diff. Ejet tekst, fordi linjediffen bygger stykkerne selv.
pub enum Piece {
    Equal(String),
    Delete(String),
    Insert(String),
}

fn char_pieces(a: &str, b: &str, out: &mut Vec<Piece>) {
    for c in dissimilar::diff(a, b) {
        out.push(match c {
            dissimilar::Chunk::Equal(s) => Piece::Equal(s.to_owned()),
            dissimilar::Chunk::Delete(s) => Piece::Delete(s.to_owned()),
            dissimilar::Chunk::Insert(s) => Piece::Insert(s.to_owned()),
        });
    }
}

/// Hver forskellig linje bliver ét tegn i Unicodes private plan, så en linjediff er en tegndiff.
fn encode_lines<'t>(lines: &[&'t str], ids: &mut HashMap<&'t str, char>) -> String {
    lines
        .iter()
        .map(|l| {
            let n = ids.len() as u32;
            *ids.entry(l)
                .or_insert_with(|| char::from_u32(0xF0000 + n).unwrap_or('\u{FFFD}'))
        })
        .collect()
}

/// Diff i to trin (performance-review 2/10): først linjer, hvor hver linje er ét tegn, så tegn,
/// men kun inde i de linjer, der er ændret. En tegn-diff over hele teksten er O(N·D) og kunne
/// fryse vinduet i sekunder ved et par hundrede sider. Uændrede afsnit koster nu næsten intet.
pub fn diff<'t>(a: &'t str, b: &'t str) -> Vec<Piece> {
    let la: Vec<&str> = a.split_inclusive('\n').collect();
    let lb: Vec<&str> = b.split_inclusive('\n').collect();
    let mut out = Vec::new();
    // Linjerne kodes som tegn i Unicodes private plan 15-16 (131.068 pladser).
    if la.len() + lb.len() > 130_000 {
        char_pieces(a, b, &mut out);
        return out;
    }
    let mut ids: HashMap<&'t str, char> = HashMap::new();
    let sa = encode_lines(&la, &mut ids);
    let sb = encode_lines(&lb, &mut ids);
    let (mut ia, mut ib) = (0usize, 0usize);
    let (mut pend_a, mut pend_b) = (String::new(), String::new());
    for chunk in dissimilar::diff(&sa, &sb) {
        match chunk {
            dissimilar::Chunk::Equal(s) => {
                char_pieces(&pend_a, &pend_b, &mut out);
                pend_a.clear();
                pend_b.clear();
                let n = s.chars().count();
                out.push(Piece::Equal(la[ia..ia + n].concat()));
                ia += n;
                ib += n;
            }
            dissimilar::Chunk::Delete(s) => {
                let n = s.chars().count();
                pend_a.push_str(&la[ia..ia + n].concat());
                ia += n;
            }
            dissimilar::Chunk::Insert(s) => {
                let n = s.chars().count();
                pend_b.push_str(&lb[ib..ib + n].concat());
                ib += n;
            }
        }
    }
    char_pieces(&pend_a, &pend_b, &mut out);
    out
}

/// Rettelserne fra `a` til `b` som (fra, til, indsæt) i `a`'s koordinater.
pub fn edits(a: &str, b: &str) -> Vec<Change> {
    let mut out: Vec<Change> = Vec::new();
    let mut pos = 0usize;
    for piece in diff(a, b) {
        match piece {
            Piece::Equal(s) => pos += u16len(&s),
            Piece::Delete(s) => {
                let l = u16len(&s);
                match out.last_mut() {
                    Some(last) if last.to == pos => last.to += l,
                    _ => out.push(Change {
                        from: pos,
                        to: pos + l,
                        insert: String::new(),
                    }),
                }
                pos += l;
            }
            Piece::Insert(s) => match out.last_mut() {
                Some(last) if last.to == pos => last.insert.push_str(&s),
                _ => out.push(Change {
                    from: pos,
                    to: pos,
                    insert: s,
                }),
            },
        }
    }
    out
}

/// Linjenummeret for hver UTF-16-position i `text` slås op i linjestarterne.
fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    let mut pos = 0;
    for c in text.chars() {
        pos += c.len_utf16();
        if c == '\n' {
            starts.push(pos);
        }
    }
    starts
}

fn line_of(starts: &[usize], pos: usize) -> usize {
    match starts.binary_search(&pos) {
        Ok(i) => i,
        Err(i) => i - 1,
    }
}

fn lines(starts: &[usize], c: &Change) -> (usize, usize) {
    let first = line_of(starts, c.from);
    let last = if c.to > c.from {
        line_of(starts, c.to - 1)
    } else {
        first
    };
    (first, last)
}

pub fn merge(base: &str, mine: &str, theirs: &str) -> Merge {
    let starts = line_starts(base);
    let ours = edits(base, mine);
    let theirs_edits = edits(base, theirs);
    let conflict = theirs_edits.iter().any(|t| {
        let (t0, t1) = lines(&starts, t);
        ours.iter().any(|m| {
            let (m0, m1) = lines(&starts, m);
            t0 <= m1 && m0 <= t1
        })
    });
    if conflict {
        return Merge {
            conflict,
            changes: Vec::new(),
        };
    }
    // Flyt deres rettelser over i editorens tekst: forskyd med vores rettelser, der ligger før.
    let shift = |pos: usize| -> usize {
        let mut p = pos as isize;
        for m in &ours {
            if m.to <= pos {
                p += u16len(&m.insert) as isize - (m.to - m.from) as isize;
            }
        }
        p.max(0) as usize
    };
    let changes = theirs_edits
        .into_iter()
        .map(|t| Change {
            from: shift(t.from),
            to: shift(t.from) + (t.to - t.from),
            insert: t.insert,
        })
        .collect();
    Merge {
        conflict: false,
        changes,
    }
}

/// Async, så diffen ikke kører på Rusts hovedtråd, der også tegner vinduet.
#[tauri::command]
pub async fn merge_texts(base: String, mine: String, theirs: String) -> Merge {
    merge(&base, &mine, &theirs)
}

/// Ord, mellemrum og andre tegn hver for sig. En rettelse på ordniveau læses som »5 → 6«, ikke
/// som tegn midt i et ord.
fn word_tokens(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut prev: Option<u8> = None;
    for (i, c) in s.char_indices() {
        let class = if c.is_alphanumeric() {
            0
        } else if c.is_whitespace() {
            1
        } else {
            2
        };
        // Tegnsætning står alene; ord og mellemrum samles i løb.
        let boundary = match prev {
            None => false,
            Some(p) => p != class || class == 2,
        };
        if boundary {
            out.push(&s[start..i]);
            start = i;
        }
        prev = Some(class);
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// Rettelserne fra `a` til `b` på ordniveau, i `a`'s koordinater (UTF-16). Rettelser, der kun er
/// adskilt af et mellemrum, slås sammen, så en omskrevet sætning bliver én rettelse, ikke ti.
pub fn word_edits(a: &str, b: &str) -> Vec<Change> {
    let ta = word_tokens(a);
    let tb = word_tokens(b);
    if ta.len() + tb.len() > 130_000 {
        return edits(a, b);
    }
    let mut ids: HashMap<&str, char> = HashMap::new();
    let sa = encode_lines(&ta, &mut ids);
    let sb = encode_lines(&tb, &mut ids);
    let mut out: Vec<Change> = Vec::new();
    let (mut ia, mut ib, mut pos) = (0usize, 0usize, 0usize);
    for chunk in dissimilar::diff(&sa, &sb) {
        match chunk {
            dissimilar::Chunk::Equal(s) => {
                let n = s.chars().count();
                pos += u16len(&ta[ia..ia + n].concat());
                ia += n;
                ib += n;
            }
            dissimilar::Chunk::Delete(s) => {
                let n = s.chars().count();
                let l = u16len(&ta[ia..ia + n].concat());
                match out.last_mut() {
                    Some(last) if last.to == pos => last.to += l,
                    _ => out.push(Change {
                        from: pos,
                        to: pos + l,
                        insert: String::new(),
                    }),
                }
                pos += l;
                ia += n;
            }
            dissimilar::Chunk::Insert(s) => {
                let n = s.chars().count();
                let text = tb[ib..ib + n].concat();
                match out.last_mut() {
                    Some(last) if last.to == pos => last.insert.push_str(&text),
                    _ => out.push(Change {
                        from: pos,
                        to: pos,
                        insert: text,
                    }),
                }
                ib += n;
            }
        }
    }
    // Slå rettelser sammen, der kun er adskilt af et kort mellemrum.
    let units: Vec<u16> = a.encode_utf16().collect();
    let mut joined: Vec<Change> = Vec::new();
    for c in out {
        if let Some(last) = joined.last_mut() {
            let gap = String::from_utf16_lossy(&units[last.to..c.from]);
            if c.from - last.to <= 2 && gap.chars().all(char::is_whitespace) {
                last.insert.push_str(&gap);
                last.insert.push_str(&c.insert);
                last.to = c.to;
                continue;
            }
        }
        joined.push(c);
    }
    joined
}

/// Sammenlign med en version (fanen Versioner): forskellen på ordniveau.
#[tauri::command]
pub async fn word_diff(old: String, new: String) -> Vec<Change> {
    word_edits(&old, &new)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Anvend ændringer (i `text`'s koordinater) bagfra, som CodeMirror gør det samlet.
    fn apply(text: &str, changes: &[Change]) -> String {
        let mut u: Vec<u16> = text.encode_utf16().collect();
        let mut sorted = changes.to_vec();
        sorted.sort_by_key(|c| std::cmp::Reverse(c.from));
        for c in sorted {
            u.splice(c.from..c.to, c.insert.encode_utf16());
        }
        String::from_utf16_lossy(&u)
    }

    #[test]
    fn ingen_lokale_rettelser_giver_bare_deres() {
        let base = "Første linje.\nAnden linje.\n";
        let theirs = "Første linje.\nAnden linje, rettet af Claude.\n";
        let m = merge(base, base, theirs);
        assert!(!m.conflict);
        assert_eq!(apply(base, &m.changes), theirs);
    }

    #[test]
    fn rettelser_paa_hver_sin_linje_flettes() {
        let base = "Øverst.\nMidten 👍🏽.\nNederst.\n";
        let mine = "Øverst, som skribenten skrev.\nMidten 👍🏽.\nNederst.\n";
        let theirs = "Øverst.\nMidten 👍🏽.\nNederst, rettet af Claude.\n";
        let m = merge(base, mine, theirs);
        assert!(!m.conflict);
        assert_eq!(
            apply(mine, &m.changes),
            "Øverst, som skribenten skrev.\nMidten 👍🏽.\nNederst, rettet af Claude.\n"
        );
    }

    #[test]
    fn samme_linje_er_en_konflikt() {
        let base = "En sætning her.\n";
        let mine = "En sætning her, som skribenten skriver.\n";
        let theirs = "En anden sætning her.\n";
        assert!(merge(base, mine, theirs).conflict);
    }

    #[test]
    fn identiske_udgaver_giver_ingen_aendringer() {
        let m = merge("a\nb", "a\nb", "a\nb");
        assert!(!m.conflict);
        assert!(m.changes.is_empty());
    }

    #[test]
    fn linjediffen_giver_samme_tekst_tilbage() {
        let a = "En\nTo 👍🏽\nTre\nFire\n";
        let b = "En\nTo 👍🏽 rettet\nTre\nFem\n";
        let (mut ra, mut rb) = (String::new(), String::new());
        for p in diff(a, b) {
            match p {
                Piece::Equal(s) => {
                    ra.push_str(&s);
                    rb.push_str(&s);
                }
                Piece::Delete(s) => ra.push_str(&s),
                Piece::Insert(s) => rb.push_str(&s),
            }
        }
        assert_eq!((ra.as_str(), rb.as_str()), (a, b));
    }

    #[test]
    fn lang_tekst_med_en_rettelse() {
        let base: String = (0..20_000)
            .map(|i| format!("Afsnit nummer {i} med lidt tekst.\n"))
            .collect();
        let theirs = base.replacen(
            "Afsnit nummer 15000 med",
            "Afsnit nummer 15000, rettet, med",
            1,
        );
        let m = merge(&base, &base, &theirs);
        assert!(!m.conflict);
        assert_eq!(apply(&base, &m.changes), theirs);
        assert_eq!(m.changes.len(), 1, "kun det rettede, ikke hele afsnit");
    }

    #[test]
    fn ordniveau_og_sammenlagte_rettelser() {
        let old = "Prisen var 5 mia. og steg lidt.";
        let new = "Prisen var 6 mia. og faldt meget.";
        let e = word_edits(old, new);
        assert_eq!(apply(old, &e), new);
        assert_eq!(e.len(), 2, "{e:?}");
        assert_eq!(e[0].insert, "6");
        assert_eq!(e[1].insert, "faldt meget");
    }
}
