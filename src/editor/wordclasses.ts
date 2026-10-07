// Ordklasser på dansk (plan 2-9 del D, som iA's »Syntax Highlight«): navneord, udsagnsord,
// tillægsord, biord og bindeord får hver sin farve. Opslag i et leksikon bygget af træbanken
// UD Danish-DDT (scripts/ordklasser.mjs). Ukendte sammensætninger får sidste leds ordklasse
// (»forsvars|chef« er et navneord), og ellers gætter endelserne. Leksikonet hentes først, når
// ordklasserne slås til, så opstarten ikke betaler for det.

import { StateEffect, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

export type WordClass = "n" | "v" | "a" | "d" | "c";
export type Lexicon = Map<string, WordClass>;

export function buildLexicon(data: Record<string, unknown>): Lexicon {
  const lex: Lexicon = new Map();
  for (const k of ["n", "v", "a", "d", "c"] as WordClass[]) {
    const words = data[k];
    if (Array.isArray(words)) for (const w of words) lex.set(String(w), k);
  }
  return lex;
}

const NOUN_END = /(hed|heden|heder|hederne|else|elsen|elser|tion|tionen|tioner|ning|ningen|ninger|skab|skabet|dom|dommen|isme|ist|isten|ister)$/;
const ADJ_END = /(lig|lige|isk|iske|som|somme|bar|bare|agtig|agtige)$/;

/** Navneordsbøjning, længste først: »revisionerne« → »revision«. */
const NOUN_INFLECTION = ["ernes", "erne", "enes", "ene", "ens", "ets", "en", "et", "er", "es", "s"];

function lookup(w: string, lex: Lexicon): WordClass | null {
  const hit = lex.get(w);
  if (hit) return hit;
  for (const end of NOUN_INFLECTION) {
    if (w.length - end.length >= 3 && w.endsWith(end) && lex.get(w.slice(0, -end.length)) === "n") return "n";
  }
  return null;
}

export function classify(word: string, lex: Lexicon): WordClass | null {
  const w = word.toLowerCase();
  const hit = lookup(w, lex);
  if (hit) return hit;
  if (w.length < 6) return null;
  // Sammensætning: længste kendte sidste led på mindst fire bogstaver, kun navne- og tillægsord.
  for (let i = 2; i <= w.length - 4; i++) {
    const tail = lookup(w.slice(i), lex);
    if (tail === "n" || tail === "a") return tail;
  }
  if (NOUN_END.test(w)) return "n";
  if (ADJ_END.test(w)) return "a";
  return null;
}

// --- visning -----------------------------------------------------------------------------------

let lexicon: Lexicon | null = null;
let enabled = false;
const refresh = StateEffect.define<null>();

const marks: Record<WordClass, Decoration> = {
  n: Decoration.mark({ class: "gt-wc-n" }),
  v: Decoration.mark({ class: "gt-wc-v" }),
  a: Decoration.mark({ class: "gt-wc-a" }),
  d: Decoration.mark({ class: "gt-wc-d" }),
  c: Decoration.mark({ class: "gt-wc-c" }),
};

/** Ordklasser, der ikke skal farves (5/10: vælg hvilke i fanen Sprog). */
let hidden = new Set<string>();
export function setHiddenWordClasses(view: EditorView, classes: string[]): void {
  const next = new Set(classes);
  if (next.size === hidden.size && [...next].every((c) => hidden.has(c))) return;
  hidden = next;
  view.dispatch({ effects: refresh.of(null) });
}

/** Slå til og fra. Første gang hentes leksikonet. */
export async function setWordClasses(view: EditorView, on: boolean): Promise<void> {
  enabled = on;
  if (on && !lexicon) {
    const data = (await import("../assets/ordklasser.json")).default as Record<string, unknown>;
    lexicon = buildLexicon(data);
  }
  view.dispatch({ effects: refresh.of(null) });
}

/** Ordklasserne talt i hele teksten, til fanen Sprog. Henter leksikonet, hvis det ikke er hentet. */
export async function wordClassCounts(text: string): Promise<Record<WordClass, number>> {
  if (!lexicon) lexicon = buildLexicon((await import("../assets/ordklasser.json")).default as Record<string, unknown>);
  const counts: Record<WordClass, number> = { n: 0, v: 0, a: 0, d: 0, c: 0 };
  for (const m of text.matchAll(/[\p{L}][\p{L}-]*/gu)) {
    const c = cached(m[0]);
    if (c) counts[c]++;
  }
  return counts;
}

/** Opslag pr. ordform, så sammensætninger ikke deles op igen ved hvert tastetryk. */
const memo = new Map<string, WordClass | null>();
function cached(word: string): WordClass | null {
  let c = memo.get(word);
  if (c === undefined && lexicon) {
    c = classify(word, lexicon);
    if (memo.size > 50_000) memo.clear();
    memo.set(word, c);
  }
  return c ?? null;
}

function build(view: EditorView): DecorationSet {
  if (!enabled || !lexicon) return Decoration.none;
  const out: Range<Decoration>[] = [];
  const re = /[\p{L}][\p{L}-]*/gu;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (const m of text.matchAll(re)) {
      const c = cached(m[0]);
      if (c && !hidden.has(c)) out.push(marks[c].range(from + (m.index ?? 0), from + (m.index ?? 0) + m[0].length));
    }
  }
  return Decoration.set(out, true);
}

export const wordClasses = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      const r = u.transactions.some((t) => t.effects.some((e) => e.is(refresh)));
      if (r || (enabled && (u.docChanged || u.viewportChanged))) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// Farverne er dæmpede, så teksten stadig kan læses som tekst.
export const wordClassTheme = EditorView.theme({
  ".gt-wc-n": { color: "var(--wc-n)" },
  ".gt-wc-v": { color: "var(--wc-v)" },
  ".gt-wc-a": { color: "var(--wc-a)" },
  ".gt-wc-d": { color: "var(--wc-d)" },
  ".gt-wc-c": { color: "var(--wc-c)" },
});
