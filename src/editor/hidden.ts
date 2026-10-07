// Det, der står i filen, men vises i højre spalte i stedet for i teksten (ADR-0008, ADR-0017):
// parkerede blokke (fanen Fraklip), Claudes gemte resultater (fanen Input) og
// fodnotedefinitioner (fanen Fodnoter). Blokke, der krydser
// linjeskift, skal komme fra et StateField (CodeMirror tillader det ikke fra et ViewPlugin).

import { EditorState, StateField, Transaction, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

import { findParked } from "./parked.ts";
import { findClaudeBlocks } from "./claudeBlocks.ts";
import { FOOTNOTE_DEF } from "./inline.ts";
import { touchesMarkers } from "./touches.ts";

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc.toString();
  for (const p of [...findParked(doc), ...findClaudeBlocks(doc)]) {
    // Blokken uden sit sidste linjeskift, så linjen efter står urørt.
    const end = doc[p.to - 1] === "\n" ? p.to - 1 : p.to;
    if (end > p.from) out.push(Decoration.replace({ block: true }).range(p.from, end));
  }
  for (let i = 1; i <= state.doc.lines; i++) {
    const l = state.doc.line(i);
    if (FOOTNOTE_DEF.test(l.text) && l.to > l.from) out.push(Decoration.replace({ block: true }).range(l.from, l.to));
  }
  return Decoration.set(out, true);
}

/**
 * Programmets egne ændringer af blokkene: fanerne Fraklip, Input og Fodnoter, import, ekstern
 * ændring, oprydning, gendannelse af en version, og fortryd/gentag.
 */
const OWN = ["input.park", "delete.park", "input.import", "input.ai", "delete.claude", "input.note", "input.external", "delete.cleanup", "input.compare", "restore", "undo", "redo"];

/** De skjulte blokke plus linjeskiftet foran dem, som [fra, til, fra, til, …]. */
export function protectedRanges(state: EditorState): number[] {
  const out: number[] = [];
  state.field(hiddenBlocks).between(0, state.doc.length, (from, to) => {
    out.push(from > 0 && state.doc.sliceString(from - 1, from) === "\n" ? from - 1 : from, to);
  });
  return out;
}

/**
 * Almindelig redigering kan ikke slette eller ændre en skjult blok (5/10: fraklip forsvandt,
 * når der blev slettet fra bunden af teksten). Resten af ændringen sker stadig, og der kan skrives
 * lige foran en blok. Kun programmets egne handlinger (OWN) og ændringer uden brugerhændelse rører dem.
 */
const protect = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged || !tr.annotation(Transaction.userEvent) || OWN.some((e) => tr.isUserEvent(e))) return true;
  const ranges = protectedRanges(tr.startState);
  return ranges.length ? ranges : true;
});

/** En kopi eller et klip tager ikke de skjulte blokke med, så de ikke kan sættes ind to gange. */
const cleanCopy = EditorView.clipboardOutputFilter.of((text, state) => {
  const sel = state.selection.main;
  const ranges = protectedRanges(state);
  if (!ranges.some((_, i) => i % 2 === 0 && ranges[i] < sel.to && ranges[i + 1] > sel.from)) return text;
  let out = "";
  let pos = sel.from;
  for (let i = 0; i < ranges.length; i += 2) {
    const [a, b] = [Math.max(ranges[i], sel.from), Math.min(ranges[i + 1], sel.to)];
    if (a >= b) continue;
    out += state.doc.sliceString(pos, a);
    pos = b;
  }
  return out + state.doc.sliceString(pos, sel.to);
});

export const hiddenBlocks = StateField.define<DecorationSet>({
  create: build,
  update: (deco, tr) => {
    if (!tr.docChanged) return deco;
    return touchesMarkers(tr, ["<!--", "-->", /^\[\^[^\]\s]+\]:/m]) ? build(tr.state) : deco.map(tr.changes);
  },
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f)), protect, cleanCopy],
});
