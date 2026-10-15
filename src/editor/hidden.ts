// Det, der står i filen, men vises i højre spalte i stedet for i teksten (ADR-0008, ADR-0017):
// parkerede blokke (fanen Fraklip), Claudes gemte resultater (fanen Input) og
// fodnotedefinitioner (fanen Fodnoter). Blokke, der krydser
// linjeskift, skal komme fra et StateField (CodeMirror tillader det ikke fra et ViewPlugin).

import { EditorState, StateField, Transaction, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

import { findParked } from "./parked.ts";
import { findClaudeBlocks } from "./claudeBlocks.ts";
import { findGoal } from "./goal.ts";
import { findColor, findStatus } from "./textStatus.ts";
import { FOOTNOTE_DEF } from "./inline.ts";
import { touchesMarkers } from "./touches.ts";
import { structureSpans } from "./structure.ts";
import { commentSpans } from "./textSyntax.ts";
import { findReferences } from "./references.ts";

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc.toString();
  const goal = findGoal(doc);
  const status = findStatus(doc);
  const color = findColor(doc);
  for (const span of commentSpans(doc).filter(s => /^<!-- gt:lyd /.test(doc.slice(s.from, s.to)))) out.push(Decoration.replace({ block: true }).range(span.from, span.to));
  for (const span of structureSpans(doc)) out.push(Decoration.replace({ block: true }).range(span.from, span.to));
  // Kildelisten (ADR-0049) vises i fanen Kilder.
  const sources = findReferences(doc);
  for (const p of [...(status ? [status] : []), ...(sources ? [sources] : []), ...findParked(doc), ...findClaudeBlocks(doc), ...(goal ? [goal] : []), ...(color ? [color] : [])]) {
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
const OWN = ["input.structure", "input.references", "input.goal", "input.status", "input.color", "input.park", "delete.park", "input.import", "input.ai", "delete.claude", "input.note", "input.external", "delete.cleanup", "input.compare", "restore", "undo", "redo"];

/** De skjulte blokke plus linjeskiftet foran dem, som [fra, til, fra, til, …]. */
export function protectedRanges(state: EditorState): number[] {
  const out: number[] = [];
  state.field(hiddenBlocks).between(0, state.doc.length, (from, to) => {
    // Linjeskiftet efter en delmarkør hører også til den: ellers limer Backspace i starten af delen
    // den første linje fast på markøren, og en overskrift dér holder op med at være markdown.
    const opensPart = state.doc.sliceString(from, from + 12) === "<!-- gt:del " && state.doc.sliceString(to, to + 1) === "\n";
    out.push(from > 0 && state.doc.sliceString(from - 1, from) === "\n" ? from - 1 : from, opensPart ? to + 1 : to);
  });
  return out;
}

/**
 * Almindelig redigering kan ikke slette eller ændre en skjult blok (5/10: fraklip forsvandt,
 * når der blev slettet fra bunden af teksten). Resten af ændringen sker stadig, og der kan skrives
 * lige foran en blok. Kun programmets egne handlinger (OWN) og ændringer uden brugerhændelse rører dem.
 */
const protect = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged || !tr.annotation(Transaction.userEvent)) return true;
  // Flyttekommandoer må ikke kopiere mærker, mens changeFilter bevarer originalen.
  // Hele dele flyttes gennem strukturpanelet med deres metadata og forfatterskab.
  if (tr.isUserEvent("move") || tr.isUserEvent("input.drop") || tr.isUserEvent("input.note") || tr.isUserEvent("input.format")) {
    const spans = structureSpans(tr.startState.doc.toString());
    let touches = false;
    tr.changes.iterChanges((from, to, _a, _b, insert) => {
      if (spans.some(s => from < s.to && to > s.from) || /<!-- gt:(?:del|slut|struktur)\b/.test(insert.toString())) touches = true;
    });
    if (touches) return false;
  }
  if (OWN.some((e) => tr.isUserEvent(e))) return true;
  const ranges = protectedRanges(tr.startState);
  return ranges.length ? ranges : true;
});

/** Stykkerne af [from, to] uden for de skjulte blokke, i rækkefølge. Tomme stykker er udeladt. */
export function visibleSpans(state: EditorState, from: number, to: number): { from: number; to: number }[] {
  const ranges = protectedRanges(state);
  const out: { from: number; to: number }[] = [];
  let pos = from;
  for (let i = 0; i < ranges.length; i += 2) {
    const [a, b] = [Math.max(ranges[i], from), Math.min(ranges[i + 1], to)];
    if (a >= b) continue;
    if (a > pos) out.push({ from: pos, to: a });
    pos = b;
  }
  if (to > pos) out.push({ from: pos, to });
  return out;
}

/** Teksten i [from, to] uden de skjulte blokke: det, en kopi eller et træk med musen bærer. */
export function visibleText(state: EditorState, from: number, to: number): string {
  return visibleSpans(state, from, to).map((s) => state.doc.sliceString(s.from, s.to)).join("");
}

/** En kopi eller et klip tager ikke de skjulte blokke med, så de ikke kan sættes ind to gange. */
const cleanCopy = EditorView.clipboardOutputFilter.of((text, state) => {
  const sel = state.selection.main;
  const ranges = protectedRanges(state);
  if (!ranges.some((_, i) => i % 2 === 0 && ranges[i] < sel.to && ranges[i + 1] > sel.from)) return text;
  return visibleText(state, sel.from, sel.to);
});

export const hiddenBlocks = StateField.define<DecorationSet>({
  create: build,
  update: (deco, tr) => {
    if (!tr.docChanged) return deco;
    return touchesMarkers(tr, ["<!--", "-->", "`", "~~~", /^\[\^[^\]\s]+\]:/m]) ? build(tr.state) : deco.map(tr.changes);
  },
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f)), protect, cleanCopy],
});
