// Byggeklodserne til omformninger (research 3.3). En omformning er en kæde på højst 8 linjer med
// én klods pr. linje: `replace "pct." "procent" word`. Tekster står i anførselstegn, valg er bare
// ord. Der findes ingen regulære udtryk og ingen kode, kun de faste klodser her.
//
// Det, klodserne aldrig rører: programmets skjulte blokke (`<!-- gt:… -->`), fodnotedefinitioner,
// noter (`<!-- … -->`, `{>> … <<}`), mærkerne om dæmpet tekst (`{--`, `--}`), fodnotehenvisninger
// og rettelser, der ikke er taget stilling til. De skjulte blokke deler teksten i stykker, og kæden
// kører på hvert stykke for sig. Resten byttes ud med pladsholdere, mens en klods arbejder, og
// sættes ordret tilbage bagefter. Rene funktioner, testet med node --test.

import { tr, type Lang } from "../i18n.ts";
import { toTable } from "../editor/parked.ts";
import type { ChainResult, CommandError, Step } from "./types.ts";

export const MAX_STEPS = 8;

type Spec = {
  name: string;
  /** Vink til formularen om argumenterne. */
  args: string;
  da: string;
  en: string;
  /** Antal tekster i anførselstegn, der skal stå først. */
  texts: number;
  /** De bare ord, klodsen kender. */
  options: string[];
  /** Mindst og højst antal valg. */
  min: number;
  max: number;
};

const spec = (name: string, args: string, da: string, en: string, texts = 0, options: string[] = [], min = 0, max = options.length): Spec => ({ name, args, da, en, texts, options, min, max });

/** Alle klodser i den rækkefølge, formularen viser dem. `texts` og `options` er de samme regler, som `parseChain` håndhæver. */
export const BLOCKS: Spec[] = [
  spec("wrap", `"…" "…"`, "Sæt tekst før og efter", "Put text before and after", 2),
  spec("prefix-lines", `"…"`, "Sæt tekst først på hver linje", "Put text at the start of each line", 1),
  spec("suffix-lines", `"…"`, "Sæt tekst sidst på hver linje", "Put text at the end of each line", 1),
  spec("replace", `"…" "…" [word] [case]`, "Erstat tekst", "Replace text", 2, ["word", "case"]),
  spec("quotes", "[da|en] [around]", "Ret citationstegn", "Fix quotation marks", 0, ["da", "en", "around"]),
  spec("tidy", "", "Ryd op i mellemrum", "Tidy up spaces"),
  spec("ellipsis", "", "Tre punktummer bliver til …", "Three full stops become …"),
  spec("join-lines", "", "Saml linjer til afsnit", "Join lines into paragraphs"),
  spec("split-sentences", "", "Én sætning pr. linje", "One sentence per line"),
  spec("sort", "[desc]", "Sorter linjer", "Sort lines", 0, ["desc"]),
  spec("unique", "", "Fjern ens linjer", "Remove duplicate lines"),
  spec("reverse", "", "Vend rækkefølgen", "Reverse the order"),
  spec("number", "", "Nummerer linjer", "Number the lines"),
  spec("case", "upper|lower|sentence", "Store eller små bogstaver", "Upper or lower case", 0, ["upper", "lower", "sentence"], 1, 1),
  spec("list", "bullets|numbered|tasks|none", "Lav til liste", "Make a list", 0, ["bullets", "numbered", "tasks", "none"], 1, 1),
  spec("table", "", "Lav til tabel", "Make a table"),
  spec("heading", "0-4", "Sæt overskriftsniveau", "Set heading level", 0, ["0", "1", "2", "3", "4"], 1, 1),
  spec("strip", "format|links", "Fjern formatering eller links", "Remove formatting or links", 0, ["format", "links"], 1, 2),
  spec("dim", "", "Dæmp", "Dim"),
  spec("note", "", "Lav til note til mig selv", "Make a note to yourself"),
  spec("clip", "", "Flyt til fraklip", "Move to Clippings"),
  spec("footnote", "", "Lav til fodnote", "Make a footnote"),
];

/** De to klodser, editoren selv udfører. De må kun stå sidst. */
const FINAL = ["clip", "footnote"];
const quoted = (s: string) => tr(`»${s}«`, `“${s}”`);

type Token = { text: string; quoted: boolean };

/** En linje delt i ord og tekster i anførselstegn. `\"`, `\\`, `\n` og `\t` kan stå i en tekst. */
function tokenizeLine(line: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " " || line[i] === "\t") {
      i += 1;
      continue;
    }
    if (line[i] === '"') {
      let text = "";
      i += 1;
      let closed = false;
      while (i < line.length) {
        const ch = line[i];
        if (ch === "\\" && i + 1 < line.length) {
          const next = line[i + 1];
          text += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i += 1;
          break;
        }
        text += ch;
        i += 1;
      }
      if (!closed) return null;
      out.push({ text, quoted: true });
      continue;
    }
    let end = i;
    while (end < line.length && line[end] !== " " && line[end] !== "\t" && line[end] !== '"') end += 1;
    out.push({ text: line.slice(i, end), quoted: false });
    i = end;
  }
  return out;
}

function checkArgs(s: Spec, args: Token[]): string | null {
  const name = quoted(s.name);
  const texts = args.slice(0, s.texts);
  if (texts.length < s.texts || texts.some((t) => !t.quoted)) {
    return s.texts === 1 ? tr(`${name} skal have én tekst i anførselstegn.`, `${name} needs one text in double quotes.`) : tr(`${name} skal have to tekster i anførselstegn.`, `${name} needs two texts in double quotes.`);
  }
  const options = args.slice(s.texts);
  const choose = tr(`Vælg mellem: ${s.options.join(", ")}.`, `Choose from: ${s.options.join(", ")}.`);
  for (const o of options) {
    if (s.options.length === 0) return tr(`${name} tager ingen argumenter.`, `${name} takes no arguments.`);
    if (o.quoted || !s.options.includes(o.text)) return tr(`${name} kender ikke ${quoted(o.text)}. ${choose}`, `${name} does not know ${quoted(o.text)}. ${choose}`);
  }
  const words = options.map((o) => o.text);
  if (new Set(words).size !== words.length || words.length > s.max || (words.includes("da") && words.includes("en"))) {
    return tr(`${name} har fået for mange valg. ${choose}`, `${name} has too many options. ${choose}`);
  }
  if (words.length < s.min) return tr(`${name} mangler et valg. ${choose}`, `${name} needs an option. ${choose}`);
  if (s.name === "replace" && texts[0].text === "") return tr(`${name} kan ikke lede efter en tom tekst.`, `${name} cannot search for an empty text.`);
  return null;
}

/**
 * Læs en kæde. Tomme linjer springes over, og `line` er linjen i kroppen (1 = første). Fejl: en
 * klods, der ikke findes, forkerte argumenter, flere end 8 trin, og `clip` eller `footnote` et
 * andet sted end sidst. Kun trin uden fejl kommer med i `steps`.
 */
export function parseChain(body: string): { steps: Step[]; errors: CommandError[] } {
  const steps: Step[] = [];
  const errors: CommandError[] = [];
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let count = 0;
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === "") return;
    count += 1;
    if (count === MAX_STEPS + 1) errors.push({ line, message: tr(`En omformning kan højst have ${MAX_STEPS} trin.`, `A transform can have at most ${MAX_STEPS} steps.`) });
    if (count > MAX_STEPS) return;
    const tokens = tokenizeLine(raw);
    if (!tokens) {
      errors.push({ line, message: tr("Et anførselstegn mangler sin afslutning.", "A double quote is never closed.") });
      return;
    }
    const [head, ...args] = tokens;
    const s = head.quoted ? undefined : BLOCKS.find((b) => b.name === head.text);
    if (!s) {
      errors.push({ line, message: tr(`Klodsen ${quoted(head.text.slice(0, 30))} findes ikke.`, `There is no block called ${quoted(head.text.slice(0, 30))}.`) });
      return;
    }
    const wrong = checkArgs(s, args);
    if (wrong) {
      errors.push({ line, message: wrong });
      return;
    }
    steps.push({ block: s.name, args: args.map((a) => a.text), line });
  });
  // Regnet på linjerne, ikke på de godkendte trin: en fejl længere nede må ikke skjule denne.
  const filled = lines.map((l, i) => ({ name: l.trim().split(/\s+/)[0], line: i + 1 })).filter((l) => l.name !== "");
  filled.forEach((l, i) => {
    if (FINAL.includes(l.name) && i < filled.length - 1) errors.push({ line: l.line, message: tr(`${quoted(l.name)} skal stå sidst i kæden.`, `${quoted(l.name)} has to be the last step.`) });
  });
  return { steps, errors: errors.sort((a, b) => a.line - b.line) };
}

/** Linjen til filen for ét trin: tekster i anførselstegn, valg som bare ord. Det omvendte af `parseChain`. */
export function formatStep(block: string, args: string[]): string {
  const texts = BLOCKS.find((b) => b.name === block)?.texts ?? 0;
  const escape = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
  return [block, ...args.map((a, i) => (i < texts ? escape(a) : a))].join(" ");
}

// --- det, klodserne ikke rører -----------------------------------------------------------------

export type SpanKind = "hidden" | "note" | "dim-open" | "dim-close" | "inline" | "code" | "target" | "tag";
export type Span = { from: number; to: number; kind: SpanKind };

const RAW: Partial<Record<SpanKind, RegExp[]>> = {
  code: [/```[\s\S]*?```/g, /`[^`\n]+`/g],
  // Adressen i et link, og en adresse, der står for sig selv.
  target: [/(?<=\])\([^)\n]*\)/g, /https?:\/\/[^\s<>)\]]+/g],
  tag: [/<\/?[a-zA-Z][^<>\n]*>/g],
};

/**
 * De steder i teksten, en kommando skal lade være, i rækkefølge og uden overlap. Altid: skjulte
 * blokke og fodnotedefinitioner (`hidden`), noter (`note`), mærkerne om dæmpet tekst (`dim-open`
 * og `dim-close`, altid i par) og fodnotehenvisninger og rettelser (`inline`). `extra` tilføjer
 * kode, linkadresser og HTML-mærker for de klodser, der ikke skal ind i dem.
 */
export function protectedSpans(text: string, extra: SpanKind[] = []): Span[] {
  const out: Span[] = [];
  const free = (from: number, to: number) => !out.some((s) => from < s.to && to > s.from);
  const add = (re: RegExp, kind: SpanKind) => {
    for (const m of text.matchAll(re)) {
      const from = m.index ?? 0;
      if (m[0].length > 0 && free(from, from + m[0].length)) out.push({ from, to: from + m[0].length, kind });
    }
  };
  add(/<!-- gt:[\s\S]*?-->/g, "hidden");
  add(/^\[\^[^\]\s]+\]:.*$/gm, "hidden");
  add(/<!--[\s\S]*?-->/g, "note");
  add(/\{>>[\s\S]*?<<\}/g, "note");
  for (const m of text.matchAll(/\{--[\s\S]*?--\}/g)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    // Kun et helt par. Et mærke, der er slugt af en note, tager det andet med sig.
    if (m[0].length >= 6 && free(from, from + 3) && free(to - 3, to)) out.push({ from, to: from + 3, kind: "dim-open" }, { from: to - 3, to, kind: "dim-close" });
  }
  add(/\{\+\+[\s\S]*?\+\+\}/g, "inline");
  add(/\{~~[\s\S]*?~~\}/g, "inline");
  add(/\[\^[^\]\s]+\]/g, "inline");
  for (const kind of extra) for (const re of RAW[kind] ?? []) add(re, kind);
  return out.sort((a, b) => a.from - b.from);
}

// Pladsholderne ligger i Unicodes private område, så ingen klods kan ramme dem ved et uheld:
// de er ikke bogstaver, ikke tegnsætning og ikke blanktegn.
const OPEN = "";
const CLOSE = "";
const DIGIT = 0xe010;
const HOLDER = /([-]+)/g;
const holder = (i: number) => OPEN + [...String(i)].map((d) => String.fromCharCode(DIGIT + Number(d))).join("") + CLOSE;
const holderIndex = (digits: string) => Number([...digits].map((d) => d.charCodeAt(0) - DIGIT).join(""));

type Masked = { text: string; spans: Span[]; originals: string[] };

function mask(text: string, extra: SpanKind[]): Masked {
  const spans = protectedSpans(text, extra);
  const originals: string[] = [];
  let out = "";
  let at = 0;
  spans.forEach((s, i) => {
    out += text.slice(at, s.from) + holder(i);
    originals.push(text.slice(s.from, s.to));
    at = s.to;
  });
  return { text: out + text.slice(at), spans, originals };
}

function unmask(text: string, m: Masked): string {
  return text.replace(HOLDER, (_, digits: string) => m.originals[holderIndex(digits)] ?? "");
}

/** Kør `fn` på teksten med det beskyttede byttet ud, og sæt det ordret tilbage. */
function shielded(text: string, extra: SpanKind[], fn: (masked: string) => string): string {
  const m = mask(text, extra);
  return unmask(fn(m.text), m);
}

// --- klodserne ---------------------------------------------------------------------------------

const LIST_PREFIX = /^(\s*)(?:- \[[ xX]\] |[-*+] |\d+[.)] )/;
/** Linjer, der ikke er løbende tekst: overskrift, punkt, citat, tabel og kodehegn. */
const STRUCTURAL = /^\s*(?:#{1,6} |[-*+] |\d+[.)] |> ?|\||```)/;
const QUOTE_CHARS = `"“”„‟»«`;
const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

const mapLines = (text: string, fn: (line: string, n: number) => string): string => {
  let n = 0;
  return text
    .split("\n")
    .map((l) => (l.trim() === "" ? l : fn(l, n++)))
    .join("\n");
};

function listify(text: string, form: string): string {
  return mapLines(text, (l, n) => {
    const indent = /^\s*/.exec(l)?.[0] ?? "";
    const rest = l.replace(LIST_PREFIX, "$1").slice(indent.length);
    const prefix = form === "bullets" ? "- " : form === "numbered" ? `${n + 1}. ` : form === "tasks" ? "- [ ] " : "";
    return indent + prefix + rest;
  });
}

/** Fast tekst, aldrig et mønster. Uden `case` skelnes der ikke mellem store og små bogstaver. */
export function replaceText(text: string, from: string, to: string, word: boolean, matchCase: boolean): string {
  if (from === "") return text;
  const needle = matchCase ? from : from.toLowerCase();
  let out = "";
  let i = 0;
  while (i < text.length) {
    const window = text.slice(i, i + from.length);
    const hit = (matchCase ? window : window.toLowerCase()) === needle;
    // Hele ord: der må ikke stå et bogstav eller tal klos op ad træffet (æøå tæller som bogstaver, L-066).
    const whole = !word || ((!isWord(from[0]) || !isWord(text[i - 1])) && (!isWord(from[from.length - 1]) || !isWord(text[i + from.length])));
    if (hit && whole) {
      out += to;
      i += from.length;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

type Marks = { open: string; close: string; innerOpen: string; innerClose: string };
const MARKS: Record<Lang, Marks> = {
  da: { open: "»", close: "«", innerOpen: "›", innerClose: "‹" },
  en: { open: "“", close: "”", innerOpen: "‘", innerClose: "’" },
};

/** Par alle dobbelte citationstegn. Et tegn åbner, når det står efter et blanktegn og foran tekst. */
function pairQuotes(text: string, open: string, close: string): string {
  let isOpen = false;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!QUOTE_CHARS.includes(ch)) {
      out += ch;
      continue;
    }
    const prev = text[i - 1];
    const next = text[i + 1];
    const before = prev === undefined || /[\s(\[{–—/-]/.test(prev);
    const after = next === undefined || /\s/.test(next);
    const opens: boolean = before && !after ? true : !before && after ? false : !isOpen;
    out += opens ? open : close;
    isOpen = opens;
  }
  return out;
}

/** Anførselstegnene fra Indstillinger (main.ts). Gælder, når kæden ikke selv siger `da` eller `en`. */
const STYLE_MARKS: Record<"guillemets" | "curly" | "low", Marks> = {
  guillemets: MARKS.da,
  curly: { open: "”", close: "”", innerOpen: "’", innerClose: "’" },
  low: { open: "„", close: "“", innerOpen: "‚", innerClose: "‘" },
};
let styleMarks: Marks | null = null;
export function setTransformQuotes(style: keyof typeof STYLE_MARKS | null): void {
  styleMarks = style ? STYLE_MARKS[style] : null;
}

function quotes(text: string, args: string[], lang: Lang): string {
  const m = args.includes("da") ? MARKS.da : args.includes("en") ? MARKS.en : lang === "da" && styleMarks ? styleMarks : MARKS[lang];
  if (!args.includes("around")) return pairQuotes(text, m.open, m.close);
  // Om det hele: står der allerede tegn yderst, byttes de, så der ikke kommer to lag.
  let inner = text.trimStart();
  const lead = text.slice(0, text.length - inner.length);
  if (inner.length >= 2 && QUOTE_CHARS.includes(inner[0]) && QUOTE_CHARS.includes(inner[inner.length - 1])) inner = inner.slice(1, -1);
  return lead + m.open + pairQuotes(inner, m.innerOpen, m.innerClose) + m.close;
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((l) => {
      // Indrykningen er markdown (lister i lister) og bliver stående.
      const indent = /^[ \t]*/.exec(l)?.[0] ?? "";
      const rest = l
        .slice(indent.length)
        .replace(/ {2,}/g, " ")
        .replace(/(?<=[\p{L}\p{N}»«"”’)\]]) ([,.;:!?])(?=\s|$|[»«"”’])/gu, "$1")
        // »tekst ,som«: kommaet er sat i den forkerte side af mellemrummet.
        .replace(/(?<=\p{L}) ,(?=\p{L})/gu, ", ")
        .trimEnd();
      return rest === "" ? "" : indent + rest;
    })
    .join("\n");
}

function joinLines(text: string): string {
  const out: string[] = [];
  let canJoin = false;
  for (const line of text.split("\n")) {
    const blank = line.trim() === "";
    const structural = STRUCTURAL.test(line);
    if (canJoin && !blank && !structural) out[out.length - 1] = `${out[out.length - 1].trimEnd()} ${line.trimStart()}`;
    else out.push(line);
    canJoin = !blank && !structural;
  }
  return out.join("\n");
}

/** Forkortelser, der ikke slutter en sætning, selv om næste ord har stort begyndelsesbogstav. */
const ABBREVIATIONS = ["bl.a.", "f.eks.", "ca.", "kr.", "mio.", "mia.", "pct.", "nr.", "evt.", "dvs.", "jf.", "inkl.", "ekskl.", "tlf.", "kl.", "dr.", "hr.", "fr.", "prof.", "mr.", "mrs.", "ms.", "st.", "vs.", "no.", "e.g.", "i.e."];

/**
 * Står punktummet ved `at` efter en forkortelse, et enkelt bogstav eller et lille tal? Tallet er
 * en dato (»5. oktober«), når `ordinals` er sat, og ellers kun et listenummer først på linjen.
 */
function dotIsNotAnEnd(text: string, at: number, ordinals: boolean): boolean {
  if (text[at] !== ".") return false;
  let start = at;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  const token = text.slice(start, at + 1).toLowerCase().replace(/^[»«"“”‘’(\[]+/, "");
  const lineStart = text.slice(text.lastIndexOf("\n", start - 1) + 1, start).trim() === "";
  return ABBREVIATIONS.includes(token) || /^\p{L}\.$/u.test(token) || (/^\d{1,2}\.$/.test(token) && (ordinals || lineStart));
}

function splitSentences(text: string): string {
  return text.replace(/([.!?…])([»«"”’)\]]*)[ \t]+(?=[\p{Lu}\d»"“‘(\[])/gu, (all, _end: string, tail: string, offset: number) => (dotIsNotAnEnd(text, offset, false) ? all : `${text[offset]}${tail}\n`));
}

function sentenceCase(text: string): string {
  const lower = text.toLowerCase();
  return lower.replace(/(^|\n|[.!?…][»«"”’)\]]*\s+)((?:[ \t]*(?:#{1,6} |[-*+] (?:\[[ x]\] )?|\d+[.)] |> ))*[ \t]*[»«"“”‘’›‹(\[]*)(\p{L})/gu, (all, lead: string, mid: string, letter: string, offset: number) => {
    if (lead[0] === "." && !lead.includes("\n") && dotIsNotAnEnd(lower, offset, true)) return all;
    return lead + mid + letter.toUpperCase();
  });
}

function stripLinks(text: string): string {
  return text.replace(/(?<!!)\[([^\]\n]*)\]\([^)\n]*\)/g, "$1").replace(/<(https?:\/\/[^\s<>]+)>/g, "$1");
}

function stripFormat(text: string): string {
  return text
    .replace(/<\/?u>/gi, "")
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}])/gu, "$1")
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}])/gu, "$1")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

/** Læg `open` og `close` om hvert stykke mellem de frosne områder. Blanktegn yderst bliver uden for. */
function wrapPieces(text: string, frozen: { from: number; to: number }[], open: string, close: string, clean: (s: string) => string): string {
  let out = "";
  let at = 0;
  const piece = (s: string) => {
    const core = s.trim();
    if (core === "") return s;
    const lead = s.length - s.trimStart().length;
    return s.slice(0, lead) + open + clean(core) + close + s.slice(lead + core.length);
  };
  for (const f of frozen) {
    out += piece(text.slice(at, f.from)) + text.slice(f.from, f.to);
    at = f.to;
  }
  return out + piece(text.slice(at));
}

/** Dæmp. Det, der allerede er dæmpet, står urørt, så mærkerne aldrig kommer til at ligge inden i hinanden. */
function dim(text: string): string {
  const spans = protectedSpans(text);
  const opens = spans.filter((s) => s.kind === "dim-open");
  const closes = spans.filter((s) => s.kind === "dim-close");
  const frozen = opens.map((o, i) => ({ from: o.from, to: closes[i].to }));
  return wrapPieces(text, frozen, "{--", "--}", (s) => s);
}

/** Lav til note. Noter, der allerede står der, bliver stående som deres egne. */
function note(text: string): string {
  const frozen = protectedSpans(text).filter((s) => s.kind === "note");
  // En pil i teksten må ikke lukke noten før tid.
  return wrapPieces(text, frozen, "<!-- ", " -->", (s) => s.replaceAll("-->", "-- >"));
}

/** Kode, adresser og HTML-mærker er ikke prosa: de klodser, der retter i sproget, går uden om dem. */
const PROSE: SpanKind[] = ["code", "target", "tag"];

function applyStep(step: Step, text: string, lang: Lang): string {
  const a = step.args;
  switch (step.block) {
    case "wrap":
      return (a[0] ?? "") + text + (a[1] ?? "");
    case "prefix-lines":
      return mapLines(text, (l) => (a[0] ?? "") + l);
    case "suffix-lines":
      return mapLines(text, (l) => l + (a[0] ?? ""));
    case "replace":
      return shielded(text, [], (t) => replaceText(t, a[0] ?? "", a[1] ?? "", a.includes("word", 2), a.includes("case", 2)));
    case "quotes":
      return shielded(text, PROSE, (t) => quotes(t, a, lang));
    case "tidy":
      return shielded(text, PROSE, tidy);
    case "ellipsis":
      return shielded(text, PROSE, (t) => t.replace(/(?<!\.)\.\.\.(?!\.)/g, "…"));
    case "join-lines":
      return shielded(text, ["code"], joinLines);
    case "split-sentences":
      return shielded(text, PROSE, splitSentences);
    case "sort": {
      const collator = new Intl.Collator(lang === "en" ? "en" : "da", { numeric: true });
      const lines = text.split("\n").filter((l) => l.trim() !== "");
      lines.sort((x, y) => collator.compare(x, y));
      return (a.includes("desc") ? lines.reverse() : lines).join("\n");
    }
    case "unique": {
      const seen = new Set<string>();
      return text
        .split("\n")
        .filter((l) => {
          const key = l.trim();
          if (key === "") return true;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .join("\n");
    }
    case "reverse":
      return text.split("\n").reverse().join("\n");
    case "number":
      return listify(text, "numbered");
    case "case":
      if (a[0] === "upper") return shielded(text, PROSE, (t) => t.toUpperCase());
      if (a[0] === "lower") return shielded(text, PROSE, (t) => t.toLowerCase());
      return shielded(text, PROSE, sentenceCase);
    case "list":
      return listify(text, a[0] ?? "bullets");
    case "table":
      return shielded(text, [], toTable);
    case "heading": {
      const marks = "#".repeat(Math.min(4, Math.max(0, Number(a[0]) || 0)));
      return mapLines(text, (l) => (marks ? `${marks} ` : "") + l.replace(/^\s*#{1,6}\s+/, ""));
    }
    case "strip": {
      // Links først, mens adresserne kan ses. Bagefter skjules de adresser, der er tilbage, så en
      // understreg i en webadresse ikke bliver læst som kursiv.
      const unlinked = a.includes("links") ? shielded(text, ["code"], stripLinks) : text;
      return a.includes("format") ? shielded(unlinked, ["target"], stripFormat) : unlinked;
    }
    case "dim":
      return dim(text);
    case "note":
      return note(text);
    default:
      return text;
  }
}

/** Kør kæden på ét stykke uden skjulte blokke. Tomme linjer og blanktegn yderst hører ikke til stykket. */
function applyToPiece(steps: Step[], piece: string, lang: Lang): string {
  const lead = /^(?:[ \t]*\n)*/.exec(piece)?.[0] ?? "";
  const rest = piece.slice(lead.length);
  const core = rest.trimEnd();
  const tail = rest.slice(core.length);
  return lead + steps.reduce((t, s) => applyStep(s, t, lang), core) + tail;
}

/**
 * Kør kæden på teksten. `text` er det, der skal stå i stedet for området. Slutter kæden med `clip`
 * eller `footnote`, står det i `then`, og editoren udfører det selv på den nye tekst.
 *
 * Skjulte blokke og fodnotedefinitioner kommer ordret og på samme plads ud igen. Kæden kører på
 * hvert stykke mellem dem for sig. Et stykke, der kun er blanktegn, springes over, medmindre det er
 * hele teksten: så kan `quotes around` give et tomt par citationstegn.
 */
export function applyChain(steps: Step[], text: string, lang: Lang): ChainResult {
  const last = steps[steps.length - 1];
  const then = last && (last.block === "clip" || last.block === "footnote") ? last.block : null;
  const work = steps.filter((s) => !FINAL.includes(s.block));
  // Står pladsholdernes egne tegn i teksten i forvejen, kan intet beskyttes sikkert. Så røres den ikke.
  if (work.length === 0 || text.includes(OPEN) || text.includes(CLOSE)) return { text, then };
  const hidden = protectedSpans(text).filter((s) => s.kind === "hidden");
  if (hidden.length === 0) return { text: applyToPiece(work, text, lang), then };
  let out = "";
  let at = 0;
  const piece = (s: string) => (s.trim() === "" ? s : applyToPiece(work, s, lang));
  for (const h of hidden) {
    out += piece(text.slice(at, h.from)) + text.slice(h.from, h.to);
    at = h.to;
  }
  return { text: out + piece(text.slice(at)), then };
}
