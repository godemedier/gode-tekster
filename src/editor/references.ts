// Kilder og henvisninger i selve filen (ADR-0049). Teksten henviser med Pandocs syntaks:
//
//   [@hansen2024]  [@hansen2024, s. 42]  [jf. @hansen2024; @nielsen2023]  [-@hansen2024] (kun året)
//
// Kilderne står som CSL-JSON, én kilde pr. linje, i én skjult blok sidst i filen:
//
//   <!-- gt:kilder
//   [
//   {"id":"hansen2024","type":"book","author":[{"family":"Hansen","given":"Jens"}],…},
//   {"id":"nielsen2023",…}
//   ]
//   -->
//
// CSL-JSON er Zoteros og Pandocs format, så en kildeliste kan komme ind og ud uden oversættelse.
// `--`, `<` og `>` skrives som \u-escapes i JSON-strengene, så en titel aldrig lukker kommentaren.
// Formateringen er APA 7 (forfatter-år). Rene funktioner, testet med node --test.

import { codeSpans, commentSpans, type TextSpan } from "./textSyntax.ts";

export type Name = { family?: string; given?: string; literal?: string };
export type CslDate = { "date-parts"?: (number | string)[][]; literal?: string; raw?: string };
export type Reference = {
  id: string;
  type: string;
  author?: Name[];
  editor?: Name[];
  issued?: CslDate;
  accessed?: CslDate;
  title?: string;
  "container-title"?: string;
  publisher?: string;
  "publisher-place"?: string;
  edition?: string | number;
  volume?: string | number;
  issue?: string | number;
  page?: string;
  DOI?: string;
  URL?: string;
  [key: string]: unknown;
};

/** Blokken i filen. `broken`: der står en blok, men den kan ikke læses, og så røres den ikke. */
export type ReferenceBlock = { refs: Reference[]; from: number; to: number; broken: boolean };
export type ReferenceChange = { from: number; to?: number; insert: string };
export type Lang = "da" | "en";

const BLOCK = /^<!-- gt:kilder[^\S\n]*\n([\s\S]*?)\n?-->$/;
/** Pandocs nøgler: bogstav, tal eller _ først, derefter også tegnsætning inde i nøglen. */
const KEY = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&+?~/-](?=[\p{L}\p{N}_]))*$/u;

export function findReferences(doc: string): ReferenceBlock | null {
  if (!doc.includes("<!-- gt:kilder")) return null;
  for (const span of commentSpans(doc)) {
    const m = BLOCK.exec(doc.slice(span.from, span.to));
    if (!m) continue;
    const to = span.to + (doc[span.to] === "\n" ? 1 : 0);
    let data: unknown;
    try {
      data = JSON.parse(m[1] || "[]");
    } catch {
      return { refs: [], from: span.from, to, broken: true };
    }
    if (!Array.isArray(data)) return { refs: [], from: span.from, to, broken: true };
    const seen = new Set<string>();
    const refs: Reference[] = [];
    for (const r of data) {
      if (!r || typeof r !== "object" || typeof r.id !== "string" || !KEY.test(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      refs.push({ ...r, type: typeof r.type === "string" ? r.type : "book" });
    }
    return { refs, from: span.from, to, broken: false };
  }
  return null;
}

/** Blokken som tekst. Tom liste giver ingen blok. */
export function referenceBlock(refs: Reference[]): string {
  if (!refs.length) return "";
  const line = (r: Reference) =>
    JSON.stringify(r)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      // `--` findes kun inde i JSON-strenge, hvor - læses som bindestreg igen.
      .replace(/-(?=-)/g, "\\u002d");
  return `<!-- gt:kilder\n[\n${refs.map(line).join(",\n")}\n]\n-->\n`;
}

/** Ændringen, der skriver listen i filen: blokken erstattes, eller en ny lægges sidst. */
export function setReferences(doc: string, refs: Reference[]): ReferenceChange | null {
  const block = findReferences(doc);
  if (block?.broken) return null;
  const text = referenceBlock(refs);
  if (block) {
    // Uden kilder forsvinder blokken helt, også den tomme linje foran.
    const from = !text && doc.slice(0, block.from).endsWith("\n\n") ? block.from - 1 : block.from;
    return { from, to: block.to, insert: text };
  }
  if (!text) return null;
  const lead = doc.length === 0 || doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
  return { from: doc.length, insert: lead + text };
}

/** Tilføj eller ret en kilde (samme id erstattes på sin plads). */
export function upsertReference(doc: string, ref: Reference): ReferenceChange | null {
  const refs = findReferences(doc)?.refs ?? [];
  const i = refs.findIndex((r) => r.id === ref.id);
  return setReferences(doc, i < 0 ? [...refs, ref] : refs.map((r, j) => (j === i ? ref : r)));
}

export function removeReference(doc: string, id: string): ReferenceChange | null {
  const refs = findReferences(doc)?.refs ?? [];
  return setReferences(doc, refs.filter((r) => r.id !== id));
}

/** Et nyt id af første forfatters efternavn og året: »hansen2024«, »hansen2024b« … */
export function newReferenceId(ref: Partial<Reference>, taken: Iterable<string>): string {
  const used = new Set(taken);
  const first = (ref.author ?? ref.editor ?? [])[0];
  const word = (first?.family ?? first?.literal ?? ref.title ?? "kilde").split(/\s+/)[0];
  const ascii = word
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    .normalize("NFD")
    .replace(/[^a-z0-9]/g, "");
  const year = yearOf(ref);
  const base = `${ascii || "kilde"}${/^\d{4}$/.test(year) ? year : ""}`;
  if (!used.has(base)) return base;
  for (let i = 1; ; i++) {
    const id = `${base}${String.fromCharCode(97 + ((i % 26) || 0))}${i >= 26 ? Math.floor(i / 26) : ""}`;
    if (!used.has(id)) return id;
  }
}

// --- henvisninger i teksten ----------------------------------------------------------------------

export type CiteItem = { id: string; prefix: string; locator: string; suppressAuthor: boolean };
export type Citation = { from: number; to: number; items: CiteItem[] };

/** Firkantede klammer med mindst ét @, som ikke er et link, en fodnote eller en definition. */
const BRACKETS = /\[([^[\]\n]*@[^[\]\n]*)\](?![([:])/g;
const ITEM = /^(.*?)(-?)@([\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&+?~/-](?=[\p{L}\p{N}_]))*)(.*)$/su;

function parseItem(raw: string): CiteItem | null {
  const m = ITEM.exec(raw.trim());
  if (!m) return null;
  // Som i Pandoc: @ efter et bogstav er en mailadresse, ikke en henvisning.
  if (m[1] && !/\s$/.test(m[1])) return null;
  return { id: m[3], prefix: m[1].trim(), locator: m[4].replace(/^\s*,\s*/, "").trim(), suppressAuthor: m[2] === "-" };
}

/** Henvisningerne i en tekst. `skip` er områder, der ikke må tolkes (kode, kommentarer). */
export function findCitations(text: string, offset = 0, skip: TextSpan[] = []): Citation[] {
  if (!text.includes("@")) return [];
  const out: Citation[] = [];
  for (const m of text.matchAll(BRACKETS)) {
    const from = offset + (m.index ?? 0);
    const to = from + m[0].length;
    if (skip.some((s) => from < s.to && to > s.from)) continue;
    const items = m[1].split(";").map(parseItem);
    if (items.length && items.every((i): i is CiteItem => i !== null)) out.push({ from, to, items: items as CiteItem[] });
  }
  return out;
}

/** Henvisningerne i hele teksten, uden dem i kode og kommentarer. */
export function citationsIn(doc: string): Citation[] {
  if (!doc.includes("@")) return [];
  return findCitations(doc, 0, [...codeSpans(doc), ...commentSpans(doc)]);
}

/** Hvor mange gange hver kilde er brugt. */
export function citationCounts(doc: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of citationsIn(doc)) for (const i of c.items) counts.set(i.id, (counts.get(i.id) ?? 0) + 1);
  return counts;
}

// --- APA 7 -------------------------------------------------------------------------------------

const WORDS = {
  da: { nd: "u.å.", ed: "Red.", eds: "Red.", edition: "udg.", in: "I", pages: "s.", refs: "Litteratur", retrieved: "Hentet" },
  en: { nd: "n.d.", ed: "Ed.", eds: "Eds.", edition: "ed.", in: "In", pages: "pp.", refs: "References", retrieved: "Retrieved" },
};
const MONTHS = {
  da: ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};

export const bibliographyTitle = (lang: Lang): string => WORDS[lang].refs;

function yearOf(ref: Partial<Reference>): string {
  const d = ref.issued;
  const y = d?.["date-parts"]?.[0]?.[0];
  if (y !== undefined && String(y).trim()) return String(y).trim();
  return (d?.literal ?? d?.raw ?? "").trim();
}

const people = (r: Reference): Name[] => (r.author?.length ? r.author : r.editor ?? []);
const short = (n: Name) => (n.family || n.literal || n.given || "").trim();

/** Kursiv og klammer i en titel må ikke blive til markdown. */
function md(s: string): string {
  return s.replace(/([\\*_[\]`<])/g, "\\$1");
}

/** Punktum efter et led, medmindre det allerede slutter med tegnsætning. */
function dot(s: string): string {
  return /[.?!]\**$/.test(s.trim()) ? s.trim() : `${s.trim()}.`;
}

function pages(p: string): string {
  return p.replace(/(\d)\s*-+\s*(\d)/g, "$1–$2");
}

function initials(given: string): string {
  return given
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part
        .split("-")
        .map((p) => (/^\p{L}\.?$/u.test(p) ? `${p[0].toUpperCase()}.` : `${p[0]?.toUpperCase() ?? ""}.`))
        .join("-"),
    )
    .join(" ");
}

function longName(n: Name): string {
  if (n.literal) return n.literal.trim();
  const g = n.given ? initials(n.given) : "";
  return g ? `${(n.family ?? "").trim()}, ${g}` : (n.family ?? "").trim();
}

/** »Hansen, J., Nielsen, M., & Berg, K.« (APA: op til 20, derefter …). */
function nameList(names: Name[]): string {
  const all = names.map(longName).filter(Boolean);
  if (all.length <= 1) return all.join("");
  if (all.length === 2) return `${all[0]}, & ${all[1]}`;
  if (all.length > 20) return `${all.slice(0, 19).join(", ")}, … ${all[all.length - 1]}`;
  return `${all.slice(0, -1).join(", ")}, & ${all[all.length - 1]}`;
}

/** Forfatterne i en henvisning: »Hansen«, »Hansen & Nielsen«, »Hansen et al.«. */
function shortAuthors(r: Reference): string {
  const names = people(r).map(short).filter(Boolean);
  if (!names.length) return r.title ? shortTitle(r.title) : r.id;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}

function shortTitle(title: string): string {
  const words = title.split(/\s+/);
  return words.length > 4 ? `${words.slice(0, 4).join(" ")} …` : title;
}

/** Bogstaver efter året, når samme forfattere har flere kilder samme år (2024a, 2024b). */
function suffixes(refs: Reference[]): Map<string, string> {
  const groups = new Map<string, Reference[]>();
  for (const r of refs) {
    const k = `${shortAuthors(r)}|${yearOf(r)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    [...group]
      .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "", "da"))
      .forEach((r, i) => out.set(r.id, String.fromCharCode(97 + (i % 26))));
  }
  return out;
}

export type Formatter = {
  /** Henvisningen som tekst: »(Hansen, 2024, s. 42)«. Ukendte kilder giver null. */
  cite: (c: Citation) => string | null;
  /** Én kilde i litteraturlisten, som markdown (titler i kursiv). */
  entry: (r: Reference) => string;
  /** Kildernes rækkefølge i litteraturlisten. */
  sorted: (refs: Reference[]) => Reference[];
};

export function formatter(refs: Reference[], lang: Lang = "da"): Formatter {
  const w = WORDS[lang];
  const byId = new Map(refs.map((r) => [r.id, r]));
  const suffix = suffixes(refs);
  const year = (r: Reference) => `${yearOf(r) || w.nd}${suffix.get(r.id) ?? ""}`;

  const cite = (c: Citation): string | null => {
    if (c.items.some((i) => !byId.has(i.id))) return null;
    const parts = c.items.map((i) => {
      const r = byId.get(i.id) as Reference;
      const core = i.suppressAuthor ? year(r) : `${shortAuthors(r)}, ${year(r)}`;
      return [i.prefix, core].filter(Boolean).join(" ") + (i.locator ? `, ${i.locator}` : "");
    });
    return `(${parts.join("; ")})`;
  };

  /** Året, og for aviser og websider også dag og måned. */
  const date = (r: Reference, full: boolean) => {
    const parts = r.issued?.["date-parts"]?.[0] ?? [];
    const y = year(r);
    if (!full || parts.length < 2) return y;
    const month = MONTHS[lang][Number(parts[1]) - 1];
    if (!month) return y;
    const day = parts[2] ? String(Number(parts[2])) : "";
    if (lang === "da") return day ? `${y}, ${day}. ${month}` : `${y}, ${month}`;
    return day ? `${y}, ${month} ${day}` : `${y}, ${month}`;
  };

  const link = (r: Reference) => {
    const doi = (r.DOI ?? "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return doi ? `https://doi.org/${doi}` : (r.URL ?? "").trim();
  };

  const entry = (r: Reference): string => {
    const type = r.type;
    const full = ["article-newspaper", "article-magazine", "webpage", "post", "post-weblog"].includes(type);
    const authors = r.author?.length ? nameList(r.author) : "";
    const editorsOnly = !authors && r.editor?.length ? `${nameList(r.editor)} (${r.editor.length > 1 ? w.eds : w.ed})` : "";
    const who = authors || editorsOnly;
    const title = (r.title ?? "").trim();
    const container = (r["container-title"] ?? "").trim();
    const italicTitle = !["article-journal", "article-newspaper", "article-magazine", "chapter", "paper-conference", "entry-encyclopedia"].includes(type);
    const t = title ? (italicTitle ? `*${md(title)}*` : md(title)) : "";
    const edition = r.edition && String(r.edition) !== "1" ? ` (${r.edition}. ${w.edition})` : "";
    const out: string[] = [];
    // Uden forfatter står titlen forrest (APA 9.12).
    if (who) out.push(`${dot(who)} (${date(r, full)}).`, t ? dot(t + edition) : "");
    else out.push(t ? dot(t + edition) : "", `(${date(r, full)}).`);

    if (type === "article-journal" || type === "article-magazine") {
      let c = container ? `*${md(container)}*` : "";
      if (r.volume) c += `, *${md(String(r.volume))}*`;
      if (r.issue) c += `(${md(String(r.issue))})`;
      if (r.page) c += `, ${md(pages(r.page))}`;
      if (c) out.push(dot(c));
    } else if (type === "chapter" || type === "paper-conference" || type === "entry-encyclopedia") {
      const eds = r.editor?.length && authors ? `${r.editor.map((n) => (n.literal ? n.literal : `${n.given ? `${initials(n.given)} ` : ""}${n.family ?? ""}`.trim())).join(", ")} (${r.editor.length > 1 ? w.eds : w.ed}), ` : "";
      const pp = r.page ? ` (${w.pages} ${md(pages(r.page))})` : "";
      if (container) out.push(dot(`${w.in} ${md(eds)}*${md(container)}*${pp}`));
      if (r.publisher) out.push(dot(md(r.publisher)));
    } else if (type === "article-newspaper") {
      if (container) out.push(dot(`*${md(container)}*`));
    } else {
      // Bog, rapport, webside og alt andet: udgiveren, medmindre den er forfatteren selv.
      const publisher = (r.publisher ?? container).trim();
      if (publisher && publisher !== authors) out.push(dot(md(publisher)));
    }
    const l = link(r);
    if (l) out.push(l);
    return out.filter(Boolean).join(" ");
  };

  const key = (r: Reference) => (people(r)[0] ? short(people(r)[0]) : (r.title ?? r.id)).toLowerCase();
  const sorted = (list: Reference[]) =>
    [...list].sort((a, b) => key(a).localeCompare(key(b), lang) || yearOf(a).localeCompare(yearOf(b)) || (suffix.get(a.id) ?? "").localeCompare(suffix.get(b.id) ?? ""));

  return { cite, entry, sorted };
}

/** Mærket foran hver post i litteraturlisten, så print og Word kan give den hængende indrykning. */
export const REFERENCE_MARK = "⁤";

/**
 * Teksten til print og Word: henvisningerne formateret, og litteraturlisten med de brugte kilder
 * sidst. Ukendte kilder står urørt, så de kan ses og rettes. `doc` er hele filen (med blokken),
 * `body` er den tekst, der skal trykkes.
 */
export function resolveCitations(doc: string, body: string, lang: Lang = "da"): string {
  const block = findReferences(doc);
  if (!block?.refs.length || !body.includes("@")) return body;
  const f = formatter(block.refs, lang);
  const used = new Set<string>();
  const skip = codeSpans(body);
  const cites = findCitations(body, 0, skip);
  if (!cites.length) return body;
  let out = "";
  let at = 0;
  for (const c of cites) {
    const text = f.cite(c);
    if (text === null) continue;
    for (const i of c.items) used.add(i.id);
    out += body.slice(at, c.from) + text;
    at = c.to;
  }
  out += body.slice(at);
  const list = f.sorted(block.refs.filter((r) => used.has(r.id)));
  if (!list.length) return out;
  const entries = list.map((r) => `${REFERENCE_MARK}${f.entry(r)}`).join("\n\n");
  return `${out.trimEnd()}\n\n## ${bibliographyTitle(lang)}\n\n${entries}\n`;
}
