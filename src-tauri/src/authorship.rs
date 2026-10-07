//! Forfatterskab gennem en rettelse udefra (ADR-0009). Passer iA-hashen ikke længere, fordi en
//! anden har rettet filen (typisk Claude), sammenlignes den nye tekst med programmets seneste
//! version: uændret tekst beholder sin forfatter, ny tekst tilskrives `&Claude`. Det er bedre end
//! iA, der kun kan spørge »behold eller kassér«.
//!
//! Positionerne er UTF-16, som editoren bruger.

use crate::annotations::{Author, Authorship, Kind, Span};

pub fn claude() -> Author {
    Author {
        kind: Kind::Ai,
        name: "Claude".to_owned(),
        identifier: None,
    }
}

fn u16len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Resultatet: forfatterskab på den nye tekst og de intervaller, der er kommet udefra (til stribe).
pub struct Mapped {
    pub authors: Vec<Authorship>,
    pub external: Vec<Span>,
}

/// Flyt `old_authors` fra `old` til `new`. Indsat tekst bliver Claudes og meldes i `external`.
pub fn map_external(old: &str, new: &str, old_authors: &[Authorship]) -> Mapped {
    // Stykker af den gamle tekst og hvor de havner i den nye (begge i UTF-16).
    let mut kept: Vec<(usize, usize, usize)> = Vec::new(); // (old_start, new_start, len)
    let mut external: Vec<Span> = Vec::new();
    let (mut o, mut n) = (0usize, 0usize);
    for piece in crate::merge::diff(old, new) {
        match piece {
            crate::merge::Piece::Equal(s) => {
                let l = u16len(&s);
                kept.push((o, n, l));
                o += l;
                n += l;
            }
            crate::merge::Piece::Delete(s) => o += u16len(&s),
            crate::merge::Piece::Insert(s) => {
                let l = u16len(&s);
                // Kun synlig tekst tæller som en rettelse. Et ekstra linjeskift er ikke AI-tekst.
                if s.chars().any(|c| !c.is_whitespace()) {
                    external.push(Span {
                        start: n,
                        end: n + l,
                    });
                }
                n += l;
            }
        }
    }

    let mut authors: Vec<Authorship> = old_authors
        .iter()
        .map(|a| {
            let mut spans = Vec::new();
            for s in &a.spans {
                for &(os, ns, l) in &kept {
                    let a0 = s.start.max(os);
                    let a1 = s.end.min(os + l);
                    if a1 > a0 {
                        spans.push(Span {
                            start: ns + (a0 - os),
                            end: ns + (a1 - os),
                        });
                    }
                }
            }
            Authorship {
                author: a.author.clone(),
                spans: merge(spans),
            }
        })
        .filter(|a| !a.spans.is_empty())
        .collect();

    if !external.is_empty() {
        let me = claude();
        match authors.iter_mut().find(|a| a.author == me) {
            Some(a) => {
                a.spans.extend(external.iter().cloned());
                a.spans = merge(std::mem::take(&mut a.spans));
            }
            None => authors.push(Authorship {
                author: me,
                spans: external.clone(),
            }),
        }
    }
    Mapped { authors, external }
}

fn merge(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by_key(|s| s.start);
    let mut out: Vec<Span> = Vec::new();
    for s in spans {
        match out.last_mut() {
            Some(last) if s.start <= last.end => last.end = last.end.max(s.end),
            _ => out.push(s),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skribent() -> Author {
        Author {
            kind: Kind::Human,
            name: "Kim Skribent".to_owned(),
            identifier: None,
        }
    }

    fn slice(text: &str, s: &Span) -> String {
        String::from_utf16_lossy(&text.encode_utf16().collect::<Vec<_>>()[s.start..s.end])
    }

    #[test]
    fn claudes_rettelse_bliver_ai_og_resten_bliver_skribentens() {
        let old = "Det lyder imponerende. Men det er svært.";
        let new = "Det lyder imponerende. Men det er langt sværere end ventet.";
        let authors = vec![Authorship {
            author: skribent(),
            spans: vec![Span {
                start: 0,
                end: u16len(old),
            }],
        }];
        let m = map_external(old, new, &authors);
        let ai = m.authors.iter().find(|a| a.author == claude()).unwrap();
        let added: Vec<String> = ai.spans.iter().map(|s| slice(new, s)).collect();
        assert!(added.iter().any(|s| s.contains("langt")), "{added:?}");
        let mine = m.authors.iter().find(|a| a.author == skribent()).unwrap();
        assert!(slice(new, &mine.spans[0]).starts_with("Det lyder imponerende"));
        assert!(!m.external.is_empty());
    }

    #[test]
    fn uaendret_tekst_giver_ingen_ai() {
        let t = "Samme tekst med æøå og 👍🏽.";
        let authors = vec![Authorship {
            author: skribent(),
            spans: vec![Span {
                start: 0,
                end: u16len(t),
            }],
        }];
        let m = map_external(t, t, &authors);
        assert!(m.external.is_empty());
        assert_eq!(m.authors, authors);
    }

    #[test]
    fn slettet_tekst_forsvinder_fra_intervallerne() {
        let old = "Første sætning. Anden sætning.";
        let new = "Første sætning.";
        let authors = vec![Authorship {
            author: skribent(),
            spans: vec![Span {
                start: 0,
                end: u16len(old),
            }],
        }];
        let m = map_external(old, new, &authors);
        assert_eq!(
            m.authors[0].spans,
            vec![Span {
                start: 0,
                end: u16len(new)
            }]
        );
    }

    #[test]
    fn kun_linjeskift_tilfoejet_er_ikke_ai() {
        let m = map_external("a", "a\n\n", &[]);
        assert!(m.external.is_empty());
    }
}
