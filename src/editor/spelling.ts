// Stavekontrollens røde bølgestreger (ADR-0063). WebView2's egen stavekontrol er slået fra i
// skrivefladen (setup.ts), fordi den bruger Windows' ordbog, der ikke kender »skriveprogram« og
// godkender »skrivedrogram«. Her tegnes stregerne selv, og Rust svarer med Hunspell og da_DK
// (spelling.rs `spell_check_words`). Fanen Sprog og højreklik bruger samme ordbog.
//
// Kun de synlige linjer, og kun ord, der ikke er slået op før: svaret gemmes pr. ord, så et
// tastetryk tegner stregerne med det samme fra hukommelsen. Nye ord slås op 300 ms efter sidste
// tastetryk. Ordet, man er i gang med at skrive, får ingen streg, før man er færdig med det.
// Ingen streger i kode, links, adresser, skjulte blokke, #tags, tal og ord som »OneDrive« og »GPL«.

import { StateEffect, type EditorState, type Range as DecoRange } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { hiddenBlocks, protectedRanges } from "./hidden.ts";

/** Et ord, som stavekontrollen ser det. `check` er det, Rust spørges om: med et punktum efter, hvis
 * der står et (»kr.«, »bl.a.«). Stregen går kun under `from`-`to`, uden punktummet. */
export type SpellToken = { from: number; to: number; word: string; check: string };

const WORD = /[\p{L}\p{M}]+(?:['’.-][\p{L}\p{M}]+)*/gu;
const NUMBER = /\p{N}/u;
const UPPER = /\p{Lu}/u;
const EDGE_PUNCT = /^[()[\]{}<>"'«»“”‘’,;:!?*]+|[()[\]{}<>"'«»“”‘’,;:!?*]+$/g;

/** Stort bogstav inde i et led: »OneDrive«, »iPhone«, »GPL«. »Nord-Korea« er i orden. */
function innerCapital(word: string): boolean {
  return word.split("-").some((part) => [...part].slice(1).some((c) => UPPER.test(c)));
}

/** »godemedier.dk«, »dr.dk«. Ikke »f.eks« eller »bl.a« (et led på ét bogstav). */
function isDomain(s: string): boolean {
  const parts = s.split(".");
  const last = parts[parts.length - 1];
  return parts.length >= 2 && parts.every((p) => /^[A-Za-z0-9-]+$/.test(p)) && parts[0].length >= 2 && /^[a-z]{2,6}$/.test(last);
}

/** Står ordet i en adresse, en sti, en mail eller et domæne? */
function inAddress(text: string, start: number, end: number): boolean {
  let a = start;
  while (a > 0 && !/\s/.test(text[a - 1])) a--;
  let b = end;
  while (b < text.length && !/\s/.test(text[b])) b++;
  const chunk = text.slice(a, b).replace(EDGE_PUNCT, "");
  return chunk.includes("://") || chunk.includes("@") || chunk.includes("\\") || chunk.startsWith("www.") || (chunk.includes("/") && chunk.includes(".")) || isDomain(chunk.replace(/\.+$/, ""));
}

/**
 * Ordene i en tekst, som stavekontrollen skal se på. Samme regler som Rust (spelling.rs `tokens`),
 * så stregerne og fanen Sprog er enige. `offset` lægges til positionerne.
 */
export function spellTokens(text: string, offset = 0): SpellToken[] {
  const out: SpellToken[] = [];
  for (const m of text.matchAll(WORD)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const word = m[0];
    const before = start > 0 ? text[start - 1] : "";
    const after = text[end] ?? "";
    const length = [...word].length;
    if (NUMBER.test(before) || "#@_".includes(before || " ")) continue;
    if (NUMBER.test(after) || "_@".includes(after || " ")) continue;
    if (length < 2 || length > 60 || innerCapital(word) || inAddress(text, start, end)) continue;
    out.push({ from: offset + start, to: offset + end, word, check: after === "." ? `${word}.` : word });
  }
  return out;
}

/** Markdown, hvor ord ikke er tekst: kode, links, billeder, adresser og HTML. */
const SKIP_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "CodeText", "Link", "Image", "Autolink", "URL", "LinkReference", "HTMLTag", "HTMLBlock", "Comment", "CommentBlock", "ProcessingInstruction", "HeaderMark"]);
const FOOTNOTE_REF = /\[\^[^\]\s]+\]/g;

/** De ord i `ranges`, der skal stavekontrolleres: uden kode, links, skjulte blokke og fodnotehenvisninger. */
export function spellCandidates(state: EditorState, ranges: readonly { from: number; to: number }[]): SpellToken[] {
  const skip: number[] = state.field(hiddenBlocks, false) ? protectedRanges(state) : [];
  // Træet i tilstanden kan slutte før intervallet, og så fik en kodeblok længere nede røde streger
  // (testen fejlede på en travl maskine 22/10). Som i slashMenu.ts: parse lidt videre, hvis det kan nås.
  const end = Math.max(0, ...ranges.map((r) => r.to));
  const tree = ensureSyntaxTree(state, end, 20) ?? syntaxTree(state);
  const out: SpellToken[] = [];
  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (n) => {
        if (!SKIP_NODES.has(n.name)) return;
        skip.push(n.from, n.to);
        return false;
      },
    });
    const text = state.sliceDoc(from, to);
    for (const m of text.matchAll(FOOTNOTE_REF)) skip.push(from + (m.index ?? 0), from + (m.index ?? 0) + m[0].length);
    for (const t of spellTokens(text, from)) {
      let hidden = false;
      for (let i = 0; i < skip.length && !hidden; i += 2) hidden = t.from < skip[i + 1] && t.to > skip[i];
      if (!hidden) out.push(t);
    }
  }
  return out;
}

// --- svarene fra Rust ------------------------------------------------------------------------------

/** Ord → rigtigt? Fælles for alle editorer i vinduet. */
const known = new Map<string, boolean>();
const pending = new Set<string>();
const views = new Set<EditorView>();
const redraw = StateEffect.define<null>();

function redrawAll(): void {
  for (const v of views) v.dispatch({ effects: redraw.of(null) });
}

async function lookUp(words: string[]): Promise<void> {
  const todo = [...new Set(words)].filter((w) => !known.has(w) && !pending.has(w)).slice(0, 5000);
  if (!todo.length) return;
  for (const w of todo) pending.add(w);
  try {
    const ok = await invoke<boolean[]>("spell_check_words", { words: todo });
    if (known.size > 200_000) known.clear();
    todo.forEach((w, i) => known.set(w, ok[i] ?? true));
  } catch {
    // Uden stavekontrol ingen streger, hellere end streger under alt.
    for (const w of todo) known.set(w, true);
  } finally {
    for (const w of todo) pending.delete(w);
  }
  redrawAll();
}

/**
 * »Tilføj til ordbog« (højreklik eller fanen Sprog, i et hvilket som helst vindue): Rust sender
 * `spell-added`. Ordet mister stregen med det samme, og de andre forkerte ord slås op igen, for
 * samme ord med punktum eller stort begyndelsesbogstav kan også være blevet rigtigt.
 */
let listening = false;
function listenForAdded(): void {
  if (listening) return;
  listening = true;
  void listen<string>("spell-added", (e) => {
    const word = e.payload;
    known.set(word, true);
    known.set(`${word}.`, true);
    const wrong = [...known].filter(([, ok]) => !ok).map(([w]) => w);
    redrawAll();
    if (!wrong.length) return;
    void invoke<boolean[]>("spell_check_words", { words: wrong })
      .then((ok) => {
        wrong.forEach((w, i) => known.set(w, ok[i] ?? true));
        redrawAll();
      })
      .catch(() => {});
  }).catch(() => {
    listening = false;
  });
}

// --- stregerne -------------------------------------------------------------------------------------

const mark = Decoration.mark({ class: "gt-spell" });

/** Stregerne i en tabelcelle: cellerne er almindelige HTML-felter, så CodeMirror tegner ikke i dem. */
function paintCells(view: EditorView, unknown: Set<string>): void {
  if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) return;
  const ranges: globalThis.Range[] = [];
  for (const cell of view.contentDOM.querySelectorAll<HTMLElement>(".gt-tablebox th, .gt-tablebox td")) {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement?.closest("code, a, [data-href]")) continue;
      for (const t of spellTokens(n.textContent ?? "")) {
        const ok = known.get(t.check);
        if (ok === undefined) unknown.add(t.check);
        if (ok !== false) continue;
        const r = document.createRange();
        r.setStart(n, t.from);
        r.setEnd(n, t.to);
        ranges.push(r);
      }
    }
  }
  if (ranges.length) CSS.highlights.set("gt-spell", new Highlight(...ranges));
  else CSS.highlights.delete("gt-spell");
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    view: EditorView;
    timer: number | undefined;
    /** Slutningen af ordet, man skriver på lige nu. */
    typingAt: number | null = null;
    unknown = new Set<string>();

    constructor(view: EditorView) {
      this.view = view;
      views.add(view);
      listenForAdded();
      this.build();
      this.schedule(0);
    }

    update(u: ViewUpdate) {
      if (u.docChanged) this.typingAt = u.transactions.some((t) => t.isUserEvent("input.type")) ? u.state.selection.main.head : null;
      else if (u.selectionSet) this.typingAt = null;
      const again = u.transactions.some((t) => t.effects.some((e) => e.is(redraw)));
      if (u.docChanged || u.viewportChanged || u.selectionSet || again || syntaxTree(u.state) !== syntaxTree(u.startState)) {
        this.build();
        // Nye ord slås op, når man holder en pause. Ved rulning og efter et svar med det samme.
        this.schedule(u.docChanged ? 300 : 0);
      }
    }

    build() {
      const out: DecoRange<Decoration>[] = [];
      const typing = this.typingAt;
      for (const t of spellCandidates(this.view.state, this.view.visibleRanges)) {
        if (typing !== null && t.from <= typing && typing <= t.to) continue;
        const ok = known.get(t.check);
        if (ok === undefined) this.unknown.add(t.check);
        else if (!ok) out.push(mark.range(t.from, t.to));
      }
      this.decorations = Decoration.set(out, true);
    }

    schedule(ms: number) {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        paintCells(this.view, this.unknown);
        const words = [...this.unknown];
        this.unknown.clear();
        void lookUp(words);
      }, ms);
    }

    destroy() {
      window.clearTimeout(this.timer);
      views.delete(this.view);
    }
  },
  {
    decorations: (v) => v.decorations,
    // Tabelcellerne: et tastetryk i en celle ændrer ikke teksten med det samme.
    eventHandlers: {
      input() {
        this.schedule(300);
      },
    },
  },
);

export const spelling = [plugin];

// Som stregen i fanen Sprog (styles.css `.lp-spell-word`) og grammatikkens blå i stiltjekket.
export const spellingTheme = EditorView.theme({
  ".gt-spell": { textDecoration: "underline wavy var(--fejl)", textDecorationThickness: "1px", textUnderlineOffset: "4px", textDecorationSkipInk: "none" },
  "& ::highlight(gt-spell)": { textDecoration: "underline wavy var(--fejl)", textDecorationThickness: "1px" },
});
