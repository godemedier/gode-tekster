// Bogstav- og romertalslister på skrivefladen (5/10): »a.«, »a)«, »A.«, »i.« får samme lette
// indrykning som markdowns egne lister, og Enter fortsætter med næste bogstav. En tom linje med
// kun markøren afslutter listen, som i Word. Reglerne for, hvad der er en liste, står i fancyLists.ts.

import { Prec, RangeSetBuilder, type EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { MarkdownConfig } from "@lezer/markdown";
import { fancyRun, isSetextUnderline, marker, parseItem, type FancyItem } from "./fancyLists.ts";
import { hasNumber, nextHeadingNumber } from "./headingNumbers.ts";

/**
 * En bogstavliste er et almindeligt afsnit for markdown, så en linje med kun »-« lige under den gjorde
 * hele listen til en overskrift (setext), fed og stor, mens man skrev (optagelse 5/10). Her slutter
 * afsnittet før understregningen, når det er en liste, så »-« bliver et tomt punkt. render.ts gør det samme.
 */
export const fancyListBlocks: MarkdownConfig = {
  parseBlock: [{ name: "FancyListEnd", endLeaf: (_cx, line, leaf) => isSetextUnderline(line.text) && fancyRun(leaf.content.split("\n")) !== null }],
};

const itemLine = Decoration.line({ class: "gt-li" });
const markerMark = Decoration.mark({ class: "gt-ol-mark" });

/** Den sammenhængende række af punkt-lignende linjer omkring linje `n` (1-baseret). */
function runAround(state: EditorState, n: number): { first: number; items: FancyItem[] } | null {
  const doc = state.doc;
  const looks = (k: number) => k >= 1 && k <= doc.lines && parseItem(doc.line(k).text, "a") !== null;
  if (!looks(n) && !parseItem(doc.line(n).text)) return null;
  let first = n;
  while (looks(first - 1)) first--;
  let last = n;
  while (looks(last + 1)) last++;
  const lines: string[] = [];
  for (let k = first; k <= last; k++) lines.push(doc.line(k).text);
  // Den længste gyldige liste, der starter i rækken.
  for (let end = lines.length; end >= 2; end--) {
    const items = fancyRun(lines.slice(0, end));
    if (items) return { first, items };
  }
  return null;
}

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    let n = doc.lineAt(from).number;
    const endLine = doc.lineAt(to).number;
    while (n <= endLine) {
      const run = parseItem(doc.line(n).text) ? runAround(view.state, n) : null;
      if (!run) {
        n++;
        continue;
      }
      run.items.forEach((it, k) => {
        const l = doc.line(run.first + k);
        if (l.number < n) return;
        b.add(l.from, l.from, itemLine);
        const start = l.from + (l.text.length - l.text.trimStart().length);
        b.add(start, l.from + it.markerEnd, markerMark);
      });
      n = Math.max(n + 1, run.first + run.items.length);
    }
  }
  return b.finish();
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Enter i slutningen af et punkt: næste bogstav. Første punkt (»a. …«) fortsætter kun med små
 * bogstaver og romertal, så »A. P. Møller købte …« + Enter ikke bliver til »B. «.
 */
function continueList(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const l = state.doc.lineAt(sel.head);
  if (sel.head !== l.to) return false;
  const run = runAround(state, l.number);
  let it = run ? run.items[l.number - run.first] : undefined;
  if (!it) {
    const single = parseItem(l.text);
    if (!single || single.index !== 0 || single.type === "A" || single.type === "I") return false;
    it = single;
  }
  const indent = l.text.slice(0, l.text.length - l.text.trimStart().length);
  if (!it.text.trim()) {
    // Tomt punkt: listen slutter, og markøren forsvinder.
    view.dispatch({ changes: { from: l.from, to: l.to, insert: "" }, userEvent: "input" });
    return true;
  }
  const next = `\n${indent}${marker(it.type, it.index + 1, it.delim)} `;
  view.dispatch({ changes: { from: sel.head, insert: next }, selection: { anchor: sel.head + next.length }, scrollIntoView: true, userEvent: "input" });
  return true;
}

export const fancyListSupport = [
  plugin,
  Prec.high(keymap.of([{ key: "Enter", run: continueList }])),
  EditorView.baseTheme({ ".gt-ol-mark": { color: "var(--svag)" } }),
];

/** »## « skrevet i starten af en linje: sæt det næste nummer ind, hvis rækken over har et. */
export const headingNumberInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== " " || from !== to) return false;
  const line = view.state.doc.lineAt(from);
  const before = line.text.slice(0, from - line.from);
  if (!/^#{1,6}$/.test(before) || hasNumber(line.text.slice(from - line.from).trimStart())) return false;
  const lines: string[] = [];
  for (let n = 1; n < line.number; n++) lines.push(view.state.doc.line(n).text);
  const prefix = nextHeadingNumber(lines, lines.length, before.length);
  if (!prefix) return false;
  view.dispatch({
    changes: { from, insert: ` ${prefix}` },
    selection: { anchor: from + 1 + prefix.length },
    userEvent: "input.type",
  });
  return true;
});
