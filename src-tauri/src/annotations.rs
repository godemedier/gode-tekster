//! iA Writers Markdown Annotations v0.2 (ADR-0009): forfatterskab i en blok sidst i filen.
//!
//! Filen: tekst, tom linje, `---`, `Annotations: <range> SHA-256 <hex>`, én linje pr. forfatter,
//! `...`. Hver annotationslinje slutter med to mellemrum. Intervaller tæller grafemer fra filens
//! første tegn. Editoren regner i UTF-16, så der konverteres her og kun her.
//!
//! Teksten, der kommer ind, er normaliseret til `\n` af `files.rs`. Da `\r\n` er ét grafem, ændrer
//! det ikke tællingen. Hashen beregnes derimod over de oprindelige bytes, så linjeskiftet sættes
//! tilbage, før der hashes.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_segmentation::UnicodeSegmentation;

use crate::files::Eol;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// `@`: et menneske.
    Human,
    /// `&`: AI.
    Ai,
    /// `*`: referencemateriale.
    Reference,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Author {
    pub kind: Kind,
    /// Kan være tom: iA skriver `@:` for en unavngiven forfatter.
    pub name: String,
    pub identifier: Option<String>,
}

impl Author {
    fn key(&self) -> String {
        let prefix = match self.kind {
            Kind::Human => '@',
            Kind::Ai => '&',
            Kind::Reference => '*',
        };
        match &self.identifier {
            Some(id) if self.name.is_empty() => format!("{prefix}<{id}>"),
            Some(id) => format!("{prefix}{} <{id}>", self.name),
            None => format!("{prefix}{}", self.name),
        }
    }

    fn parse(key: &str) -> Option<Author> {
        let mut chars = key.chars();
        let kind = match chars.next()? {
            '@' => Kind::Human,
            '&' => Kind::Ai,
            '*' => Kind::Reference,
            _ => return None,
        };
        let rest = chars.as_str().trim();
        let (name, identifier) = match (rest.rfind('<'), rest.ends_with('>')) {
            (Some(i), true) => (
                rest[..i].trim().to_owned(),
                Some(rest[i + 1..rest.len() - 1].to_owned()),
            ),
            _ => (rest.to_owned(), None),
        };
        Some(Author {
            kind,
            name,
            identifier,
        })
    }
}

/// Et halvåbent interval `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Authorship {
    pub author: Author,
    /// UTF-16-offsets i editorens tekst.
    pub spans: Vec<Span>,
}

/// Det, der skal huskes fra den oprindelige blok for at kunne skrive den tilbage præcist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockInfo {
    pub hash_valid: bool,
    /// Linjeskiftene mellem teksten og `---` (normalt `\n\n`).
    separator: String,
    /// Nøglen på hash-linjen. Skrives altid tilbage, som den var.
    hash_key: String,
    hash_len: usize,
    /// Alt efter `...` (normalt `\n`).
    tail: String,
    /// Blokken fra `---` og til filens slutning, ordret.
    raw: String,
    original_text: String,
    original_authors: Vec<Authorship>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Parsed {
    /// Teksten uden blokken og uden linjeskiftene før den.
    pub text: String,
    pub authors: Vec<Authorship>,
    pub block: Option<BlockInfo>,
    /// Gamle annotationsblokke inde i teksten (UTF-16), som iA engang ikke genkendte.
    pub stale_blocks: Vec<Span>,
}

const HASH_HEX_LEN: usize = 20;

/// Læser en fil (normaliseret til `\n`). `eol` er filens oprindelige linjeskift.
pub fn parse(full: &str, eol: Eol) -> Parsed {
    let Some(found) = find_block(full) else {
        return Parsed {
            stale_blocks: find_stale_blocks(full),
            text: full.to_owned(),
            authors: Vec::new(),
            block: None,
        };
    };
    let before = &full[..found.dashes_at];
    let text = before.trim_end_matches('\n');
    let separator = before[text.len()..].to_owned();

    let entries = parse_entries(&full[found.dashes_at + 4..found.dots_at]);
    let mut hash_key = String::from("Annotations");
    let mut hash_len = HASH_HEX_LEN;
    let mut hash_valid = false;
    let mut authors = Vec::new();
    let map = GraphemeMap::new(text);
    for (i, (key, value)) in entries.iter().enumerate() {
        if i == 0 {
            if let Some((range, hex)) = parse_hash_value(value) {
                hash_key = key.clone();
                hash_len = hex.len();
                hash_valid = hash_matches(before, range, &hex, eol);
            }
            continue;
        }
        if let Some(author) = Author::parse(key) {
            let spans = parse_ranges(value)
                .into_iter()
                .filter_map(|(s, l)| map.to_utf16(s, s + l))
                .collect();
            authors.push(Authorship { author, spans });
        }
    }

    Parsed {
        stale_blocks: find_stale_blocks(text),
        text: text.to_owned(),
        authors: authors.clone(),
        block: Some(BlockInfo {
            hash_valid,
            separator,
            hash_key,
            hash_len,
            tail: full[found.dots_at + 3..].to_owned(),
            raw: full[found.dashes_at..].to_owned(),
            original_text: text.to_owned(),
            original_authors: authors,
        }),
    }
}

/// Skriver tekst og forfatterskab tilbage til én streng (normaliseret til `\n`).
/// Uden blok fra start og uden forfatterskab skrives ingen blok: filen røres ikke (ADR-0013).
pub fn write(text: &str, authors: &[Authorship], block: Option<&BlockInfo>, eol: Eol) -> String {
    if let Some(b) = block {
        if text == b.original_text && authors == b.original_authors.as_slice() {
            return format!("{text}{}{}", b.separator, b.raw);
        }
    } else if authors.iter().all(|a| a.spans.is_empty()) {
        return text.to_owned();
    }

    let text = text.trim_end_matches('\n');
    let map = GraphemeMap::new(text);
    let total = map.len();
    let hash_len = block.map_or(HASH_HEX_LEN, |b| b.hash_len.clamp(20, 64));
    let hex = sha256_hex(&with_eol(text, eol));
    let mut lines = vec![format!(
        "{}: 0,{total} SHA-256 {}  ",
        block.map_or("Annotations", |b| b.hash_key.as_str()),
        &hex[..hash_len]
    )];
    for a in authors {
        let mut ranges: Vec<(usize, usize)> = a
            .spans
            .iter()
            .filter_map(|s| map.to_graphemes(s.start, s.end))
            .filter(|(s, e)| e > s)
            .collect();
        ranges.sort_unstable();
        let merged = merge(ranges);
        if merged.is_empty() {
            continue;
        }
        let list: Vec<String> = merged
            .iter()
            .map(|&(s, e)| {
                if e - s == 1 {
                    s.to_string()
                } else {
                    format!("{s},{}", e - s)
                }
            })
            .collect();
        lines.push(format!("{}: {}  ", a.author.key(), list.join(" ")));
    }
    let separator = block.map_or("\n\n", |b| b.separator.as_str());
    let tail = block.map_or("\n", |b| b.tail.as_str());
    format!("{text}{separator}---\n{}\n...{tail}", lines.join("\n"))
}

// --- blokken -----------------------------------------------------------------------------------

struct Found {
    /// Byte-offset for `---`-linjen.
    dashes_at: usize,
    /// Byte-offset for `...`-linjen.
    dots_at: usize,
}

/// Den sidste blok, der står helt sidst i filen. Første linje efter `---` skal være hash-linjen.
fn find_block(full: &str) -> Option<Found> {
    let trimmed = full.trim_end();
    // ends_with før offset-regning: en fil, der slutter på en emoji, må ikke skæres midt i tegnet.
    if !trimmed.ends_with("...") {
        return None;
    }
    let dots_at = trimmed.len() - 3;
    if !(dots_at == 0 || full[..dots_at].ends_with('\n')) {
        return None;
    }
    let mut search_end = dots_at;
    while let Some(i) = full[..search_end].rfind("\n---\n") {
        let first_line = full[i + 5..dots_at].lines().next().unwrap_or("");
        if let Some((_, value)) = split_key(first_line) {
            if parse_hash_value(&value).is_some() {
                return Some(Found {
                    dashes_at: i + 1,
                    dots_at,
                });
            }
        }
        search_end = i;
    }
    None
}

/// Gamle blokke midt i teksten: `---`, en hash-linje og frem til næste `...`-linje.
fn find_stale_blocks(text: &str) -> Vec<Span> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = text[from..].find("---\n") {
        let at = from + rel;
        let line_start = at == 0 || text[..at].ends_with('\n');
        let first = text[at + 4..].lines().next().unwrap_or("");
        let is_hash = split_key(first).is_some_and(|(_, v)| parse_hash_value(&v).is_some());
        if line_start && is_hash {
            if let Some(end_rel) = text[at..].find("\n...") {
                let mut end = at + end_rel + 4;
                if text[end..].starts_with('\n') {
                    end += 1;
                }
                out.push(Span {
                    start: utf16_len(&text[..at]),
                    end: utf16_len(&text[..end]),
                });
                from = end;
                continue;
            }
        }
        from = at + 4;
    }
    out
}

/// Nøgle og værdi pr. annotation. Fortsættelseslinjer (indrykket) hægtes på den forrige.
fn parse_entries(body: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in body.lines() {
        if line.starts_with("  ") && !out.is_empty() {
            if let Some(last) = out.last_mut() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
        } else if let Some((k, v)) = split_key(line) {
            out.push((k, v));
        }
    }
    out
}

/// Deler ved første `:`, der ikke er escaped som `\:`.
fn split_key(line: &str) -> Option<(String, String)> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b':' => {
                let key = line[..i].replace("\\:", ":").trim().to_owned();
                return Some((key, line[i + 1..].trim().to_owned()));
            }
            _ => i += 1,
        }
    }
    None
}

/// `0,95 SHA-256 1132bf…` → ((0, 95), hex). Hex skal være 20-64 tegn.
fn parse_hash_value(value: &str) -> Option<((usize, usize), String)> {
    let mut parts = value.split_whitespace();
    let range = parse_range(parts.next()?)?;
    if parts.next()? != "SHA-256" {
        return None;
    }
    let hex = parts.next()?.to_ascii_lowercase();
    let ok = (20..=64).contains(&hex.len()) && hex.bytes().all(|b| b.is_ascii_hexdigit());
    ok.then_some((range, hex))
}

fn parse_range(token: &str) -> Option<(usize, usize)> {
    match token.split_once(',') {
        Some((s, l)) => Some((s.parse().ok()?, l.parse().ok()?)),
        None => Some((token.parse().ok()?, 1)),
    }
}

fn parse_ranges(value: &str) -> Vec<(usize, usize)> {
    value.split_whitespace().filter_map(parse_range).collect()
}

fn merge(sorted: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    for (s, e) in sorted {
        match out.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out
}

// --- hash ---------------------------------------------------------------------------------------

fn with_eol(text: &str, eol: Eol) -> String {
    match eol {
        Eol::Lf => text.to_owned(),
        Eol::Crlf => text.replace('\n', "\r\n"),
        Eol::Cr => text.replace('\n', "\r"),
    }
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn hash_matches(before: &str, (start, len): (usize, usize), hex: &str, eol: Eol) -> bool {
    let graphemes: Vec<&str> = before.graphemes(true).collect();
    if start > graphemes.len() {
        return false;
    }
    let end = (start + len).min(graphemes.len());
    let slice: String = graphemes[start..end].concat();
    // Også LF: git (autocrlf) laver LF om til CRLF ved checkout, så en fil iA hashede med LF står
    // med CRLF i et worktree. Indholdet er det samme. Set 2/10-2026 i tre worktrees.
    sha256_hex(&with_eol(&slice, eol)).starts_with(hex)
        || (eol != Eol::Lf && sha256_hex(&slice).starts_with(hex))
}

// --- grafemer ↔ UTF-16 --------------------------------------------------------------------------

/// UTF-16-offset for hver grafemgrænse i teksten (længde = antal grafemer + 1).
struct GraphemeMap {
    utf16_at: Vec<usize>,
}

impl GraphemeMap {
    fn new(text: &str) -> Self {
        let mut utf16_at = Vec::with_capacity(text.len() + 1);
        let mut pos = 0;
        utf16_at.push(0);
        for g in text.graphemes(true) {
            pos += g.encode_utf16().count();
            utf16_at.push(pos);
        }
        GraphemeMap { utf16_at }
    }

    fn len(&self) -> usize {
        self.utf16_at.len() - 1
    }

    /// Grafem-interval → UTF-16. Intervaller ud over teksten klippes.
    fn to_utf16(&self, start: usize, end: usize) -> Option<Span> {
        let n = self.len();
        let (s, e) = (start.min(n), end.min(n));
        (e > s).then(|| Span {
            start: self.utf16_at[s],
            end: self.utf16_at[e],
        })
    }

    /// UTF-16-interval → grafemer. En grænse midt i et grafem rundes ud, så tegnet tæller med.
    fn to_graphemes(&self, start: usize, end: usize) -> Option<(usize, usize)> {
        let s = self
            .utf16_at
            .partition_point(|&u| u <= start)
            .saturating_sub(1);
        let e = self.utf16_at.partition_point(|&u| u < end);
        (e > s && e <= self.len()).then_some((s, e))
    }
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: &str = "Markdown Annotations embed authorship in text while preserving its readability and portability.\n\n---\nAnnotations: 0,95 SHA-256 1132bf5e376a605f5beed4b204456114  \n@Human: 0,20 33,4 45,6 62,4  \n&AI: 20,13 37,8 51,11 66,29  \n...\n";

    fn slice(text: &str, s: &Span) -> String {
        String::from_utf16_lossy(&text.encode_utf16().collect::<Vec<_>>()[s.start..s.end])
    }

    #[test]
    fn spec_eksemplet_laeses_og_hashen_passer() {
        let p = parse(SPEC, Eol::Lf);
        let b = p.block.as_ref().unwrap();
        assert!(b.hash_valid);
        assert_eq!(p.text.len(), 95);
        let human = &p.authors[0];
        assert_eq!(human.author.kind, Kind::Human);
        assert_eq!(human.author.name, "Human");
        assert_eq!(slice(&p.text, &human.spans[0]), "Markdown Annotations");
        assert_eq!(slice(&p.text, &human.spans[1]), "ship");
        assert_eq!(slice(&p.text, &p.authors[1].spans[0]), " embed author");
    }

    #[test]
    fn uaendret_fil_skrives_tilbage_ordret() {
        let p = parse(SPEC, Eol::Lf);
        assert_eq!(write(&p.text, &p.authors, p.block.as_ref(), Eol::Lf), SPEC);
    }

    #[test]
    fn ny_tekst_giver_gyldig_hash_og_ia_form() {
        let p = parse(SPEC, Eol::Lf);
        let text = format!("{} Og skribenten tilføjede dette.", p.text);
        let mut authors = p.authors.clone();
        let start = utf16_len(&p.text);
        authors[0].spans.push(Span {
            start,
            end: utf16_len(&text),
        });
        let out = write(&text, &authors, p.block.as_ref(), Eol::Lf);
        let n = text.graphemes(true).count();
        assert!(out.contains(&format!("\n\n---\nAnnotations: 0,{n} SHA-256 ")));
        assert!(out.ends_with("  \n...\n"));
        let again = parse(&out, Eol::Lf);
        assert!(again.block.unwrap().hash_valid);
        let last = again.authors[0].spans.last().unwrap();
        assert_eq!(slice(&again.text, last), " Og skribenten tilføjede dette.");
    }

    #[test]
    fn unavngiven_forfatter_og_laengde_et() {
        let text = "Hej";
        let authors = vec![Authorship {
            author: Author {
                kind: Kind::Human,
                name: String::new(),
                identifier: None,
            },
            spans: vec![Span { start: 1, end: 2 }],
        }];
        let out = write(text, &authors, None, Eol::Lf);
        assert!(out.contains("\n@: 1  \n"), "{out}");
        let p = parse(&out, Eol::Lf);
        assert!(p.block.unwrap().hash_valid);
        assert_eq!(p.authors[0].author.name, "");
    }

    #[test]
    fn identifier_laeses() {
        let a = Author::parse("&AI <ChatGPT>").unwrap();
        assert_eq!(a.kind, Kind::Ai);
        assert_eq!(a.name, "AI");
        assert_eq!(a.identifier.as_deref(), Some("ChatGPT"));
        assert_eq!(a.key(), "&AI <ChatGPT>");
    }

    #[test]
    fn grafemer_og_utf16_paa_danske_tegn_og_emoji() {
        // »é« som e + kombinerende accent er ét grafem, men to UTF-16-enheder. 👍🏽 er ét grafem.
        let text = "Cafe\u{301} 👍🏽 æøå";
        let map = GraphemeMap::new(text);
        assert_eq!(map.len(), 10);
        let span = map.to_utf16(3, 4).unwrap();
        assert_eq!(slice(text, &span), "e\u{301}");
        assert_eq!(map.to_graphemes(span.start, span.end), Some((3, 4)));
        let thumb = map.to_utf16(5, 6).unwrap();
        assert_eq!(slice(text, &thumb), "👍🏽");
    }

    #[test]
    fn crlf_hashes_over_de_oprindelige_bytes() {
        let text = "Linje 1\nLinje 2";
        let authors = vec![Authorship {
            author: Author::parse("@Kim Skribent").unwrap(),
            spans: vec![Span {
                start: 0,
                end: utf16_len(text),
            }],
        }];
        let out = write(text, &authors, None, Eol::Crlf);
        let crlf_hash = &sha256_hex("Linje 1\r\nLinje 2")[..20];
        assert!(out.contains(crlf_hash));
        assert!(out.contains("0,15 SHA-256"), "CRLF er ét grafem: {out}");
        assert!(parse(&out, Eol::Crlf).block.unwrap().hash_valid);
    }

    #[test]
    fn lf_hash_godtages_i_en_crlf_fil() {
        // Som i et worktree: iA hashede med LF, git skrev filen ud med CRLF.
        let p = parse(SPEC, Eol::Crlf);
        assert!(p.block.unwrap().hash_valid);
    }

    #[test]
    fn ugyldig_hash_opdages() {
        let broken = SPEC.replace("portability.", "portability!");
        let p = parse(&broken, Eol::Lf);
        assert!(!p.block.as_ref().unwrap().hash_valid);
        assert_eq!(
            write(&p.text, &p.authors, p.block.as_ref(), Eol::Lf),
            broken,
            "en uændret fil med ugyldig hash rettes ikke i stilhed"
        );
    }

    #[test]
    fn gammel_blok_inde_i_teksten_findes() {
        let inner = "---\nAnnotations: 0,5 SHA-256 0123456789abcdef0123  \n@: 0,5  \n...\n";
        let full = format!("Artikel tekst.\n\n{inner}\n---\nAnnotations: 0,1 SHA-256 0123456789abcdef0123  \n@: 0,1  \n...\n");
        let p = parse(&full, Eol::Lf);
        assert_eq!(p.stale_blocks.len(), 1);
        // Den gamle blok står lige før adskilleren, så dens sidste linjeskift hører til den.
        assert_eq!(slice(&p.text, &p.stale_blocks[0]), inner.trim_end());
    }

    #[test]
    fn fil_uden_blok_roeres_ikke() {
        let text = "# Bare tekst\n\nIngen blok.\n";
        let p = parse(text, Eol::Lf);
        assert!(p.block.is_none());
        assert_eq!(write(&p.text, &p.authors, None, Eol::Lf), text);
    }

    #[test]
    fn setext_overskrift_er_ikke_en_blok() {
        let text = "Titel\n---\nTekst...\n...\n";
        assert!(parse(text, Eol::Lf).block.is_none());
    }

    /// Kriterie 2 og 3 i plan 1 på kopierne i `tests/private/`: alle blokke læses, uændrede filer
    /// skrives ordret tilbage, og `ARTIKEL.md`s gamle blok findes.
    #[test]
    fn rigtige_filer_med_blok() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/private");
        if !root.exists() {
            eprintln!("tests/private findes ikke, springer over");
            return;
        }
        let (mut blocks, mut valid, mut stale) = (0, 0, 0);
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().is_none_or(|e| e != "md") {
                    continue;
                }
                let o = crate::files::open(&path).unwrap();
                let p = parse(&o.text, o.meta.eol);
                if let Some(b) = &p.block {
                    blocks += 1;
                    valid += usize::from(b.hash_valid);
                    stale += p.stale_blocks.len();
                    assert_eq!(
                        write(&p.text, &p.authors, Some(b), o.meta.eol),
                        o.text,
                        "{}",
                        path.display()
                    );
                }
            }
        }
        eprintln!("annotationer: {blocks} filer med blok, {valid} gyldige hashes, {stale} gamle blokke i teksten");
        assert!(blocks > 0 && valid > 0);
    }
}
