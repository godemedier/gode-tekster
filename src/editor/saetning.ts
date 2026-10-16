// Sætningsbygning (stiltjek fase 3, 16/10). Forskningen peger på det, der får læseren til at vente
// på udsagnsordet, frem for sætningens længde alene (Wengelin 2015, docs/research/2026-10-12-stiltjek-forskning.md):
//
//   indskud   et langt indskud mellem grundled og udsagnsled: »Rapporten, som …, viser«
//   kloevning »Det er X, der …« i stedet for at sige X først
//
// Uden fuld sætningsanalyse: udsagnsordet findes som i grammar.ts (bøjet form fra ordklasselisten).
// Er man i tvivl, markeres intet. Vises kun med »Alle forslag«, til de er målt (ADR-0051).
//
// Målebænken 16/10 (20 stikprøver hver): forvægt ramte rigtigt i 2 af 20 og er taget ud. Den kræver
// en sætningsanalyse, der kan finde udsagnsordet, og den eneste danske (UDPipe) er CC BY-NC-SA.
// Kløvning og indskud ramte også 2 af 20 og er strammet i to runder: kløvning kun, når det
// fremhævede led er et navn (»Det er især X, der« er idiomatisk), indskud fra 15 ord (12-13 ord var
// som regel lette at læse) og ikke ved en afgrænsende relativsætning (»De, der …«), hvor
// grundleddet ikke kan stå alene.

import { inQuote, quoteRanges } from "../sprog/quotes.ts";
import type { Flag } from "./styleRules.ts";

/** Ord i et indskud mellem grundled og udsagnsled. Fra cirka 15 ord var fundene næsten altid nyttige (målebænken 16/10). */
const INDSKUD = 15;

const MODALS = new Set(["kan", "kunne", "skal", "skulle", "vil", "ville", "må", "måtte", "bør", "burde"]);
const PAST = new Set(["var", "blev", "fik", "gik", "kom", "stod", "lå", "tog", "gav", "sagde", "havde", "gjorde", "vidste", "er", "har", "bliver", "får", "går", "gør", "ved", "ser", "står"]);
/** Sætninger, der begynder med en ledsætning, et forholdsord eller et biord, har ikke grundled først. */
const NOT_SUBJECT_START = new Set([
  "når", "hvis", "fordi", "selvom", "mens", "da", "skønt", "medmindre", "eftersom", "idet", "efter", "før", "inden", "siden",
  "hvor", "hvad", "hvem", "hvorfor", "hvordan", "hvilken", "hvilket", "at", "om", "men", "og", "eller", "for", "så", "derfor",
  "i", "på", "til", "med", "af", "fra", "ved", "under", "over", "mod", "gennem", "uden", "hos", "trods", "ifølge", "blandt",
  "særligt", "særlig", "især", "fuldstændig", "ligesom", "også", "netop", "kun", "ikke", "allerede", "desuden", "derudover",
  "samtidig", "alligevel", "dog", "endelig", "først", "nu", "her", "der", "som", "tilsvarende", "ligeledes", "dernæst", "herefter",
]);
/** Grundled, der kræver relativsætningen: »De, der …«, »Alle, som …«. */
const NEEDS_RELATIVE = new Set(["de", "den", "det", "dem", "alle", "mange", "nogle", "folk", "personer", "ingen", "enhver"]);
const RELATIVE = new Set(["som", "der", "hvis", "hvor", "hvilket", "hvilken", "hvilke"]);

type Word = { text: string; low: string; from: number; to: number };

export function saetningFlags(text: string, verbs: ReadonlySet<string>, nouns: ReadonlySet<string>): Flag[] {
  const quotes = quoteRanges(text);
  const out: Flag[] = [];
  // »lærer« og »ejer« er oftest navneord, når de også står som navneord i listen. Datid på -te
  // (»ansatte«) er oftest tillægsord, så kun de faste former i PAST.
  const finite = (w: Word) =>
    MODALS.has(w.low) || PAST.has(w.low) || (verbs.has(w.low) && !nouns.has(w.low) && (w.low.endsWith("r") || w.low.endsWith("ede")));

  for (const s of sentences(text)) {
    if (inQuote(s.from, quotes) || s.words.length < 5) continue;
    const ws = s.words;
    const gap = (i: number) => text.slice(ws[i - 1].to, ws[i].from);
    const first = ws[0];

    // Kløvning: »Det er/var X, der/som …« forrest, hvor X er et navn. »Det er folk, der …« og »Det er en illustration, som …« peger tilbage på
    // sætningen før og er ikke kløvning (målebænken 16/10).
    if (first.low === "det" && (ws[1].low === "er" || ws[1].low === "var")) {
      const x0 = ws[2];
      if (x0.text[0] !== x0.low[0]) {
        for (let i = 3; i <= Math.min(8, ws.length - 2); i++) {
          if ((ws[i].low === "der" || ws[i].low === "som") && !finite(ws[i - 1])) {
            if (/^,?\s+$/.test(gap(i)) && ws.slice(2, i).every((_, k) => k === 0 || /^\s+$/.test(gap(k + 2)))) {
              const x = text.slice(x0.from, ws[i - 1].to);
              out.push({ from: first.from, to: ws[i].to, kind: "kloevning", message: `Sig det, sætningen handler om, først: »${x} …« i stedet for »Det ${ws[1].low} ${x}, ${ws[i].low} …«.` });
            }
            break;
          }
        }
      }
    }
    if (NOT_SUBJECT_START.has(first.low)) continue;

    // Indskud: grundled (1-5 ord), komma, mindst INDSKUD ord der begynder med som/der/…, komma, udsagnsord.
    const c1 = ws.findIndex((_, i) => i > 0 && gap(i).includes(","));
    if (c1 < 1 || c1 > 5 || ws.slice(0, c1).some(finite) || !RELATIVE.has(ws[c1].low)) continue;
    // Afgrænsende relativsætning: grundleddet er et stedord eller et navneord i ubestemt flertal.
    if (NEEDS_RELATIVE.has(first.low) || (c1 === 1 && first.low.endsWith("er") && nouns.has(first.low))) continue;
    const c2 = ws.findIndex((_, i) => i > c1 && gap(i).includes(","));
    if (c2 > 0 && c2 - c1 >= INDSKUD && finite(ws[c2]) && !/[–—()]/.test(text.slice(ws[c1].from, ws[c2].from))) {
      out.push({
        from: ws[c1].from,
        to: ws[c2 - 1].to,
        kind: "indskud",
        message: `Indskud på ${c2 - c1} ord mellem grundled og udsagnsled. Læseren venter på »${ws[c2].text}«. Prøv at gøre indskuddet til sin egen sætning.`,
      });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Sætninger med ord og positioner. Punktum efter en forkortelse eller et tal deler ikke (som clarity.ts). */
function sentences(text: string): { from: number; words: Word[] }[] {
  const out: { from: number; words: Word[] }[] = [];
  let cur: Word[] = [];
  const re = /\p{L}[\p{L}\p{M}\p{N}]*(?:[-­']\p{L}[\p{L}\p{M}]*)*|\d[\d.,]*|[.!?]+(?=\s+[\p{Lu}\d»"”„]|\s*$)|\n/gu;
  for (const m of text.matchAll(re)) {
    const t = m[0];
    if (t === "\n" || /^[.!?]+$/.test(t)) {
      if (cur.length) out.push({ from: cur[0].from, words: cur });
      cur = [];
      continue;
    }
    cur.push({ text: t, low: t.normalize("NFC").toLowerCase(), from: m.index, to: m.index + t.length });
  }
  if (cur.length) out.push({ from: cur[0].from, words: cur });
  return out;
}
