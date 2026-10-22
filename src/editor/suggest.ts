// Forslagstilstand (ADR-0060, 20/10): alt, der skrives eller slettes, bliver CriticMarkup-forslag i
// stedet for at ændre teksten. Det er sådan, en gæst retter i en delt tekst, og skribenten kan selv
// slå det til som Spor ændringer i Word.
//
//   skriv »x«                      → {++x++}
//   slet »ord«                     → {~~ord~>~~}
//   skriv over »ord« med »andet«   → {~~ord~>andet~~}
//
// Kernen er en ren funktion: det berørte stykke tekst og de forslag, det rører ved, læses som tegn af
// tre slags (uændret, slettet, nyt). Redigeringen anvendes på tegnene, og stykket skrives ud igen.
// Forslag, der støder op til hinanden, bliver derfor ét, og en sletning, der allerede er foreslået,
// kan ikke slettes igen. Gemt og testet med node --test.

import { ChangeSet, EditorSelection, EditorState, StateEffect, StateField, Transaction, Annotation, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { findNotes, findRevisions } from "./critic.ts";

export type Edit = { from: number; to: number; insert: string };
/** Erstat `from`–`to` i den oprindelige tekst med `insert`. `caret` er markøren i den nye tekst. */
export type Rewrite = Edit & { caret: number };
export type Direction = "back" | "forward" | "insert";

type Kind = "plain" | "old" | "new";
type Char = { ch: string; kind: Kind };

/** Forslag, der rører `from`–`to` (også ved kanten), og stykket, der dækker dem alle. */
function window(doc: string, from: number, to: number) {
  const revisions = findRevisions(doc);
  let a = from;
  let b = to;
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of revisions) {
      if (r.from <= b && r.to >= a && (r.from < a || r.to > b)) {
        a = Math.min(a, r.from);
        b = Math.max(b, r.to);
        grew = true;
      }
    }
  }
  return { a, b, revisions: revisions.filter((r) => r.from >= a && r.to <= b) };
}

/** Stykket som tegn. `index(pos)` er antallet af tegn før positionen; mærkerne tæller ikke. */
function chars(doc: string, a: number, b: number, revisions: ReturnType<typeof findRevisions>) {
  const out: Char[] = [];
  const at = new Map<number, number>();
  let pos = a;
  const plain = (to: number) => {
    for (; pos < to; pos++) {
      at.set(pos, out.length);
      out.push({ ch: doc[pos], kind: "plain" });
    }
  };
  // En position inde i et mærke hører til tegnene ved siden af: åbningen til dem efter, `~>` og
  // lukningen til dem før. Så lander tekst skrevet lige før `++}` inde i forslaget.
  const span = (from: number, to: number, kind: Kind) => {
    for (let p = from; p < to; p++) {
      at.set(p, out.length);
      out.push({ ch: doc[p], kind });
    }
  };
  const marker = (from: number, to: number) => {
    for (let p = from; p < to; p++) at.set(p, out.length);
  };
  for (const r of revisions) {
    plain(r.from);
    const nextEnd = r.nextFrom + r.next.length;
    if (r.kind === "ins") {
      marker(r.from, r.nextFrom);
    } else {
      marker(r.from, r.oldFrom);
      span(r.oldFrom, r.oldFrom + r.old.length, "old");
      marker(r.oldFrom + r.old.length, r.nextFrom);
    }
    span(r.nextFrom, nextEnd, "new");
    marker(nextEnd, r.to);
    pos = r.to;
  }
  plain(b);
  at.set(b, out.length);
  return { out, index: (p: number) => at.get(p) ?? out.length };
}

/** Tegnene skrevet ud som tekst med forslag. `caret` er et indeks i tegnene, svaret en position. */
function serialize(list: Char[], caret: number): { text: string; caret: number } {
  let text = "";
  let caretPos = -1;
  // Mærket om et forslag: hvor tegnene i det står, og hvor det åbner og lukker.
  const where: number[] = [];
  const group: { open: number; close: number; closeEnd: number }[] = [];
  for (let i = 0; i < list.length; ) {
    if (list[i].kind === "plain") {
      where[i] = text.length;
      text += list[i].ch;
      i++;
      continue;
    }
    let j = i;
    while (j < list.length && list[j].kind !== "plain") j++;
    const run = list.slice(i, j);
    const old = run.filter((c) => c.kind === "old");
    const g = { open: text.length, close: 0, closeEnd: 0 };
    const isIns = old.length === 0;
    text += isIns ? "{++" : "{~~";
    // Først de slettede tegn, så de nye. Indeksene i rækkefølge, så markøren kan findes.
    for (let k = i; k < j; k++) if (list[k].kind === "old") ((where[k] = text.length), (text += list[k].ch));
    if (!isIns) text += "~>";
    for (let k = i; k < j; k++) if (list[k].kind === "new") ((where[k] = text.length), (text += list[k].ch));
    g.close = text.length;
    text += isIns ? "++}" : "~~}";
    g.closeEnd = text.length;
    for (let k = i; k < j; k++) group[k] = g;
    i = j;
  }
  const L = list[caret - 1];
  const R = list[caret];
  if (L?.kind === "new") caretPos = where[caret - 1] + 1;
  else if (R?.kind === "new") caretPos = where[caret];
  else if (L?.kind === "old") caretPos = group[caret - 1].closeEnd;
  else if (R?.kind === "old") caretPos = group[caret].open;
  else if (L) caretPos = where[caret - 1] + 1;
  else caretPos = R ? where[caret] : 0;
  return { text, caret: caretPos };
}

/**
 * Redigeringen som forslag. `null`, når den ikke kan laves om (fx midt i et mærke), og så skal den
 * afvises. En sletning, der kun rammer tekst, der allerede er foreslået slettet, går videre til
 * tegnet ved siden af, som Backspace ellers ville have slettet.
 */
export function suggest(doc: string, edit: Edit, dir: Direction): Rewrite | null {
  // Halvdelen af et tegn uden for BMP (emoji) må aldrig ende i et forslag alene.
  const low = (p: number) => p > 0 && p < doc.length && doc.charCodeAt(p) >= 0xdc00 && doc.charCodeAt(p) <= 0xdfff;
  if (low(edit.from)) edit = { ...edit, from: edit.from - 1 };
  if (low(edit.to)) edit = { ...edit, to: edit.to + 1 };
  const { a, b, revisions } = window(doc, edit.from, edit.to);
  const { out, index } = chars(doc, a, b, revisions);
  const i0 = index(edit.from);
  const i1 = Math.max(i0, index(edit.to));
  const middle: Char[] = [];
  let changed = edit.insert !== "";
  for (const c of out.slice(i0, i1)) {
    if (c.kind === "plain") middle.push({ ch: c.ch, kind: "old" }), (changed = true);
    else if (c.kind === "old") middle.push(c);
    else changed = true;
  }
  if (!changed) {
    if (dir === "insert" || edit.insert !== "") return null;
    // Alt i området var allerede slettet: slet tegnet uden for forslaget.
    if (dir === "back") {
      if (a === 0 || a === edit.from) return null;
      return suggest(doc, { from: a - clusterBefore(doc, a), to: a, insert: "" }, dir);
    }
    if (b >= doc.length || b === edit.to) return null;
    return suggest(doc, { from: b, to: b + clusterAfter(doc, b), insert: "" }, dir);
  }
  // Kodeenheder, ikke kodepunkter, så positionerne passer med dokumentets.
  const insertedUnits: Char[] = edit.insert.split("").map((ch) => ({ ch, kind: "new" }));
  const prefix = out.slice(0, i0);
  const list = [...prefix, ...middle, ...insertedUnits, ...out.slice(i1)];
  const caret = dir === "back" && edit.insert === "" ? prefix.length : prefix.length + middle.length + insertedUnits.length;
  const s = serialize(list, caret);
  return { from: a, to: b, insert: s.text, caret: a + s.caret };
}

function clusterBefore(doc: string, pos: number): number {
  const code = doc.charCodeAt(pos - 1);
  return code >= 0xdc00 && code <= 0xdfff && pos >= 2 ? 2 : 1;
}
function clusterAfter(doc: string, pos: number): number {
  const code = doc.charCodeAt(pos);
  return code >= 0xd800 && code <= 0xdbff ? 2 : 1;
}

// --- i editoren --------------------------------------------------------------------------------

export const setSuggesting = StateEffect.define<boolean>();
/** Ændringer, der ikke skal laves om til forslag (godtag, afvis, fletning udefra, gæstens kommentar). */
export const directEdit = Annotation.define<boolean>();

export const suggesting = StateField.define<boolean>({
  create: () => false,
  update(on, tr) {
    for (const e of tr.effects) if (e.is(setSuggesting)) on = e.value;
    return on;
  },
});

const DIRECT = ["undo", "redo", "input.revision", "delete.revision", "input.external", "input.note", "delete.note"];

function direction(tr: Transaction): Direction {
  if (tr.isUserEvent("delete.backward")) return "back";
  if (tr.isUserEvent("delete.forward")) return "forward";
  return "insert";
}

/**
 * En sletning hen over en hel kommentar uden for forslagene: kommentaren slettes direkte, som »Slet«
 * på dens kort, og kun teksten omkring den bliver forslag (21/10). Før lå kommentaren som slettet
 * tekst inde i forslaget og kunne ikke ses eller fjernes. Svaret er teksten uden kommentarerne og
 * redigeringerne flyttet med. En redigering, der kun var kommentaren, falder bort.
 */
export function withoutNotes(doc: string, edits: Edit[]): { doc: string; edits: Edit[]; removals: Edit[] } {
  // Kun en sletning kan rumme en hel kommentar. Et tastetryk slipper for at lede (gennemgang 22/10).
  if (edits.every((e) => e.to === e.from)) return { doc, edits, removals: [] };
  const revisions = findRevisions(doc);
  const removals = findNotes(doc)
    .filter((n) => edits.some((e) => n.from >= e.from && n.to <= e.to) && !revisions.some((r) => n.from < r.to && n.to > r.from))
    .map((n) => ({ from: n.from, to: n.to, insert: "" }));
  if (!removals.length) return { doc, edits, removals };
  const map = (p: number) => p - removals.filter((r) => r.to <= p).reduce((sum, r) => sum + r.to - r.from, 0);
  let out = "";
  let at = 0;
  for (const r of removals) (out += doc.slice(at, r.from)), (at = r.to);
  out += doc.slice(at);
  const moved = edits.map((e) => ({ from: map(e.from), to: map(e.to), insert: e.insert })).filter((e) => e.to > e.from || e.insert);
  return { doc: out, edits: moved, removals };
}

/** Laver en transaktions ændringer om til forslag. `null` betyder: afvis den. */
export function rewriteChanges(doc: string, edits: Edit[], dir: Direction): Rewrite[] | null {
  const out: Rewrite[] = [];
  for (const e of edits) {
    const r = suggest(doc, e, e.insert === "" ? dir : "insert");
    if (!r) return null;
    out.push(r);
  }
  out.sort((x, y) => x.from - y.from);
  for (let i = 1; i < out.length; i++) if (out[i].from < out[i - 1].to) return null;
  // Markørerne i den samlede nye tekst: forskydning fra de stykker, der står før.
  let shift = 0;
  return out.map((r) => {
    const moved = { ...r, caret: r.caret + shift };
    shift += r.insert.length - (r.to - r.from);
    return moved;
  });
}

const filter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.startState.field(suggesting, false)) return tr;
  if (tr.annotation(directEdit) || DIRECT.some((e) => tr.isUserEvent(e))) return tr;
  // En komposition (IME, Gboard) må ikke ændres undervejs. Den laves om, når den er færdig.
  if (tr.isUserEvent("input.type.compose")) return tr;
  const edits: Edit[] = [];
  tr.changes.iterChanges((from, to, _a, _b, text) => edits.push({ from, to, insert: text.toString() }));
  const doc = tr.startState.doc.toString();
  // Det, der skrives inde i en kommentar, er kommentaren selv og ikke et forslag.
  const notes = findNotes(doc);
  if (edits.every((e) => notes.some((n) => e.from >= n.from + n.open && e.to <= n.to - n.close))) return tr;
  // Hele kommentarer i en sletning fjernes først, så resten bliver ét forslag.
  const clean = withoutNotes(doc, edits);
  const rewrites = rewriteChanges(clean.doc, clean.edits, direction(tr));
  if (!rewrites) return [];
  const userEvent = tr.annotation(Transaction.userEvent);
  const removed = ChangeSet.of(clean.removals, doc.length);
  const carets = rewrites.length ? rewrites.map((r) => EditorSelection.cursor(r.caret)) : [EditorSelection.cursor(removed.mapPos(edits[0].from, -1))];
  return {
    changes: removed.compose(ChangeSet.of(rewrites.map(({ from, to, insert }) => ({ from, to, insert })), clean.doc.length)),
    selection: EditorSelection.create(carets),
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    ...(userEvent ? { userEvent } : {}),
  };
});

/** Det område, en komposition har skrevet direkte i, og den tekst, der stod der før. */
type Pending = { from: number; to: number; old: string };
const clearPending = StateEffect.define<null>();

const pending = StateField.define<Pending | null>({
  create: () => null,
  update(p, tr) {
    for (const e of tr.effects) if (e.is(clearPending)) return null;
    if (!tr.docChanged) return p;
    if (!tr.isUserEvent("input.type.compose") || !tr.startState.field(suggesting, false) || tr.annotation(directEdit)) {
      return p && { from: tr.changes.mapPos(p.from, -1), to: tr.changes.mapPos(p.to, 1), old: p.old };
    }
    const doc = tr.startState.doc;
    let next = p;
    tr.changes.iterChanges((from, to) => {
      if (!next) {
        // Inde i et nyt forslag skrives der bare videre.
        const inside = findRevisions(doc.toString()).some((r) => from >= r.nextFrom && to <= r.nextFrom + r.next.length);
        next = inside ? null : { from, to, old: doc.sliceString(from, to) };
        return;
      }
      const old = (from < next.from ? doc.sliceString(from, next.from) : "") + next.old + (to > next.to ? doc.sliceString(next.to, to) : "");
      next = { from: Math.min(from, next.from), to: Math.max(to, next.to), old };
    });
    return next && { from: tr.changes.mapPos(next.from, -1), to: tr.changes.mapPos(next.to, 1), old: next.old };
  },
});

/** Kompositionen laves om til et forslag, når den er færdig. */
export function finishComposition(state: EditorState): { changes: Edit; caret: number } | null {
  const p = state.field(pending, false);
  if (!p) return null;
  const real = state.doc.toString();
  const virtual = real.slice(0, p.from) + p.old + real.slice(p.to);
  const r = suggest(virtual, { from: p.from, to: p.from + p.old.length, insert: real.slice(p.from, p.to) }, "insert");
  if (!r) return null;
  const grow = p.to - p.from - p.old.length;
  return { changes: { from: r.from, to: r.to + grow, insert: r.insert }, caret: r.caret };
}

function finish(view: EditorView): void {
  if (view.composing || !view.state.field(pending, false)) return;
  const done = finishComposition(view.state);
  const head = view.state.selection.main.head;
  const p = view.state.field(pending, false);
  view.dispatch({
    effects: clearPending.of(null),
    annotations: directEdit.of(true),
    ...(done ? { changes: done.changes, selection: p && head === p.to ? { anchor: done.caret } : undefined } : {}),
  });
}

// Kompositionen er færdig: ved `compositionend` (CodeMirror laver ikke altid en opdatering mere) og
// ved næste opdatering uden komposition. `setTimeout`, så CodeMirror har læst den sidste tekst først.
const composer = [
  ViewPlugin.fromClass(
    class {
      update(u: ViewUpdate) {
        if (!u.view.composing && u.state.field(pending, false)) setTimeout(() => finish(u.view));
      }
    },
  ),
  EditorView.domEventHandlers({
    compositionend: (_e, view) => {
      setTimeout(() => finish(view), 20);
    },
  }),
];

/**
 * Hvor en kommentar kan stå: aldrig inde i et forslag eller en anden kommentar, men lige efter. Heller
 * ikke midt i et ord, når en markering slutter dér, men efter ordet (21/10: »enk <!-- … -->elt«).
 */
export function commentPosition(doc: string, pos: number): number {
  const word = /[\p{L}\p{N}]/u;
  for (let moved = true; moved; ) {
    moved = false;
    while (pos > 0 && pos < doc.length && word.test(doc[pos - 1]) && word.test(doc[pos])) {
      pos++;
      moved = true;
    }
    for (const r of [...findRevisions(doc), ...findNotes(doc)]) {
      if (pos > r.from && pos < r.to) {
        pos = r.to;
        moved = true;
      }
    }
  }
  return pos;
}

/**
 * En kommentar til det markerede (eller ved markøren) i forslagstilstanden. Teksten bliver stående,
 * og kommentaren kommer efter den. `cmd.note` gør det markerede til noten, og det ville være en
 * rettelse uden om forslagene.
 */
export function addComment(view: EditorView, text = ""): void {
  const at = commentPosition(view.state.doc.toString(), view.state.selection.main.to);
  // En kommentar må ikke kunne lukke noten før tid.
  const body = text.replace(/\s+/g, " ").replace(/--+>/g, "–>").trim();
  const insert = body ? ` <!-- ${body} -->` : " <!--  -->";
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor: body ? at + insert.length : at + 6 },
    userEvent: "input.note",
    scrollIntoView: true,
  });
  view.focus();
}

/** Ret kommentaren, der står ved `at` (gæstens side). Tom tekst sletter den med mellemrummet foran. */
export function editComment(view: EditorView, at: number, text: string): void {
  const doc = view.state.doc.toString();
  const n = findNotes(doc).find((x) => at >= x.from - 1 && at <= x.to);
  if (!n) return;
  const body = text.replace(/\s+/g, " ").replace(/--+>/g, "–>").trim();
  const from = !body && n.from > 0 && /[ \t]/.test(doc[n.from - 1]) ? n.from - 1 : n.from;
  view.dispatch({ changes: { from, to: n.to, insert: body ? `<!-- ${body} -->` : "" }, userEvent: body ? "input.note" : "delete.note" });
}

/** Forslagstilstanden. Slås til med `setSuggesting`, og gæstens side har den altid på. */
export function suggestMode(on = false): Extension {
  return [suggesting.init(() => on), pending, filter, composer];
}

export const isSuggesting = (view: EditorView): boolean => view.state.field(suggesting, false) ?? false;
