//! Status, #tags og frist i en tekst (plan 2026-10-08-bibliotek, ADR-0038). Alt står i filen:
//!
//! - status som én skjult linje øverst: `<!-- gt:status vaerdi=igang -->`
//! - #tags på tekstens sidste linje, kun hashtags: `#klima #kronik` (som i Ulysses)
//! - fristen fra længdemålet: `<!-- gt:maal … frist=2026-10-10 -->` (ADR-0034)
//!
//! Biblioteket læser kun filens hoved og hale, så funktionerne her tager tekststykker.

use crate::annotations::{self, Authorship, Span};
use crate::files::Eol;

const STATUS_START: &str = "<!-- gt:status vaerdi=";

/// Statussen i tekstens hoved, hvis den første ikke-tomme linje er en statuslinje.
pub fn status_of(head: &str) -> Option<String> {
    let line = head
        .trim_start_matches('\u{feff}')
        .lines()
        .find(|l| !l.trim().is_empty())?;
    let rest = line.trim().strip_prefix(STATUS_START)?;
    let id = rest.strip_suffix("-->")?.trim();
    valid_id(id).then(|| id.to_owned())
}

/// Et status-id: små bogstaver, tal og bindestreg (også æøå), højst 40 tegn.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= 40
        && id
            .chars()
            .all(|c| c.is_alphanumeric() && !c.is_uppercase() || c == '-')
}

/// Et hashtag: `#` og så bogstaver, tal, `_`, `-` eller `/`, og mindst ét bogstav eller tal først.
fn is_tag(word: &str) -> bool {
    let Some(rest) = word.strip_prefix('#') else {
        return false;
    };
    rest.chars().next().is_some_and(char::is_alphanumeric)
        && rest
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
}

/// En linje med kun hashtags (mindst ét). »# Overskrift« er ikke en, fordi `#` står alene.
pub fn tag_line(line: &str) -> Option<Vec<String>> {
    let words: Vec<&str> = line.split_whitespace().collect();
    (!words.is_empty() && words.iter().all(|w| is_tag(w)))
        .then(|| words.iter().map(|w| w[1..].to_owned()).collect())
}

/// Teksten uden forfatterblok og uden skjulte blokke (`<!-- … -->`, også over flere linjer).
fn visible_lines(tail: &str) -> Vec<&str> {
    let text = annotations::parse(tail, Eol::Lf).text;
    let end = text.len();
    let text = &tail[..end.min(tail.len())];
    let mut out = Vec::new();
    let mut in_comment = false;
    for line in text.lines() {
        let t = line.trim();
        if in_comment {
            in_comment = !t.contains("-->");
            continue;
        }
        if t.starts_with("<!--") {
            in_comment = !t.contains("-->");
            continue;
        }
        out.push(line);
    }
    out
}

/// Står der kun skjulte blokke og forfatterblok i halen? Så skal der læses længere tilbage.
pub fn only_hidden(tail: &str) -> bool {
    visible_lines(tail).iter().all(|l| l.trim().is_empty())
}

/// #tags fra tekstens sidste synlige linje. Tom, hvis linjen ikke kun er hashtags.
pub fn tags_of(tail: &str) -> Vec<String> {
    visible_lines(tail)
        .into_iter()
        .rev()
        .find(|l| !l.trim().is_empty())
        .and_then(tag_line)
        .unwrap_or_default()
}

/// Fristen fra længdemålet (ÅÅÅÅ-MM-DD, eventuelt med klokkeslæt ÅÅÅÅ-MM-DDTHH:MM fra 9/10). Står der
/// flere mål, gælder det sidste.
pub fn deadline_of(tail: &str) -> Option<String> {
    tail.match_indices("<!-- gt:maal ")
        .filter_map(|(i, _)| {
            let line = tail[i..].lines().next()?;
            let value = line
                .split_whitespace()
                .find_map(|w| w.strip_prefix("frist="))?;
            let ok = (value.len() == 10 || value.len() == 16)
                && value.chars().enumerate().all(|(n, c)| match n {
                    4 | 7 => c == '-',
                    10 => c == 'T',
                    13 => c == ':',
                    _ => c.is_ascii_digit(),
                });
            ok.then(|| value.to_owned())
        })
        .last()
}

/// Antal UTF-16-enheder, som forfatterskabets intervaller regnes i.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Teksten med en ny status (eller uden, ved `None`), og forfatterskabet flyttet med, så iA's
/// intervaller stadig peger på de samme ord. Statuslinjen selv har ingen forfatter.
pub fn with_status(
    text: &str,
    authors: &[Authorship],
    id: Option<&str>,
) -> (String, Vec<Authorship>) {
    let bom = if text.starts_with('\u{feff}') {
        "\u{feff}"
    } else {
        ""
    };
    let body = &text[bom.len()..];
    let old_len = if status_of(body.lines().next().unwrap_or("")).is_some() {
        body.find('\n').map_or(body.len(), |i| i + 1)
    } else {
        0
    };
    let line = id
        .map(|id| format!("{STATUS_START}{id} -->\n"))
        .unwrap_or_default();
    let new_text = format!("{bom}{line}{}", &body[old_len..]);
    let at = utf16_len(bom);
    let (old16, new16) = (utf16_len(&body[..old_len]), utf16_len(&line));
    let shift = |p: usize| {
        if p < at {
            p
        } else {
            at + p.saturating_sub(at).max(old16) - old16 + new16
        }
    };
    let moved = authors
        .iter()
        .map(|a| Authorship {
            author: a.author.clone(),
            spans: a
                .spans
                .iter()
                .map(|s| Span {
                    start: shift(s.start),
                    end: shift(s.end),
                })
                .filter(|s| s.end > s.start)
                .collect(),
        })
        .collect();
    (new_text, moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::annotations::{Author, Kind};

    #[test]
    fn status_staar_oeverst_og_ellers_ikke() {
        assert_eq!(
            status_of("<!-- gt:status vaerdi=igang -->\n# Titel\n").as_deref(),
            Some("igang")
        );
        assert_eq!(
            status_of("\n\n<!-- gt:status vaerdi=ide -->\n").as_deref(),
            Some("ide")
        );
        assert_eq!(
            status_of("# Titel\n<!-- gt:status vaerdi=igang -->\n"),
            None
        );
        assert_eq!(status_of("<!-- gt:status vaerdi=Ond Kode -->\n"), None);
        assert_eq!(
            status_of("<!-- gt:status vaerdi=færdig -->").as_deref(),
            Some("færdig")
        );
    }

    #[test]
    fn tags_kun_paa_sidste_linje_og_kun_hashtags() {
        assert_eq!(
            tags_of("Tekst.\n\n#klima #kronik\n"),
            vec!["klima", "kronik"]
        );
        assert_eq!(tags_of("Tekst.\n\n#klima og mere\n"), Vec::<String>::new());
        assert_eq!(tags_of("# Overskrift\n"), Vec::<String>::new());
        assert_eq!(
            tags_of(
                "Tekst.\n#ansøgning/fond\n\n<!-- gt:maal type=hoejst antal=7400 enhed=anslag -->\n"
            ),
            vec!["ansøgning/fond"]
        );
        assert_eq!(
            tags_of("Tekst.\n#a\n<!-- gt:parkeret id=p1 dato=2026-10-02\nParkeret #ikke\n-->\n"),
            vec!["a"]
        );
        assert_eq!(
            tags_of("Tekst.\n#a #b\n\n---\nAnnotations: 0,9 SHA-256 0123456789abcdef0123  \n...\n"),
            vec!["a", "b"]
        );
    }

    #[test]
    fn fristen_fra_maalet() {
        assert_eq!(
            deadline_of(
                "x\n<!-- gt:maal type=hoejst antal=7400 enhed=anslag frist=2026-10-11 -->\n"
            )
            .as_deref(),
            Some("2026-10-11")
        );
        assert_eq!(
            deadline_of("x\n<!-- gt:maal type=hoejst antal=7400 enhed=anslag -->\n"),
            None
        );
        assert_eq!(deadline_of("<!-- gt:maal frist=11-10-2026 -->"), None);
        // Med klokkeslæt (9/10), og et ødelagt klokkeslæt afvises.
        assert_eq!(
            deadline_of("<!-- gt:maal type=hoejst antal=10 enhed=ord frist=2026-10-10T14:00 -->\n")
                .as_deref(),
            Some("2026-10-10T14:00")
        );
        assert_eq!(
            deadline_of("<!-- gt:maal type=hoejst antal=10 enhed=ord frist=2026-10-10T14-00 -->\n"),
            None
        );
    }

    #[test]
    fn ny_status_flytter_forfatterskabet_med() {
        let me = Authorship {
            author: Author {
                kind: Kind::Human,
                name: "Kim Skribent".into(),
                identifier: None,
            },
            spans: vec![Span { start: 0, end: 5 }],
        };
        let (t, a) = with_status("Hallo verden", std::slice::from_ref(&me), Some("igang"));
        assert_eq!(t, "<!-- gt:status vaerdi=igang -->\nHallo verden");
        let off = "<!-- gt:status vaerdi=igang -->\n".len();
        assert_eq!(
            a[0].spans,
            vec![Span {
                start: off,
                end: off + 5
            }]
        );
        // Skift til en anden status: længden ændrer sig, intervallet følger.
        let (t2, a2) = with_status(&t, &a, Some("faerdig"));
        assert_eq!(t2, "<!-- gt:status vaerdi=faerdig -->\nHallo verden");
        let off2 = "<!-- gt:status vaerdi=faerdig -->\n".len();
        assert_eq!(
            a2[0].spans,
            vec![Span {
                start: off2,
                end: off2 + 5
            }]
        );
        // Fjern den igen: tilbage til start.
        let (t3, a3) = with_status(&t2, &a2, None);
        assert_eq!(t3, "Hallo verden");
        assert_eq!(a3[0].spans, me.spans);
    }
}
