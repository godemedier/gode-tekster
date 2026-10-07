// Kørslen af en »/«-kommando (plan 2026-10-05, research 3.4 og 3.10). Det skrevne »/navn« fjernes,
// og resultatet sættes ind i samme transaktion, så ét Ctrl+Z bringer alt tilbage. En skabelon sætter
// tekst ind og tænder markørstoppene, en omformning skriver om i markeringen eller afsnittet, og tjek
// og AI skriver intet: de fjerner kun det skrevne og viser svaret i højre spalte.
//
// Hvad der skal ske, regnes ud i planCommand, som kun bruger en EditorState og derfor kan testes med
// node --test. runCommand udfører planen i editoren. De skjulte blokke (hidden.ts) og noter til mig
// selv røres aldrig: en omformning deles ved blokkene, klodserne går selv uden om noterne (blocks.ts),
// og tjek og AI får begge dele som blanktegn, så positionerne stadig passer.

import { EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension, type Transaction, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";

import { count } from "../editor/count.ts";
import { insertFootnote } from "../editor/editing.ts";
import { focusTable } from "../editor/tables.ts";
import { protectedRanges } from "../editor/hidden.ts";
import { paragraphAt, type Span } from "../editor/parkRange.ts";
import { parkChanges } from "../editor/parked.ts";
import { currentLang, tr } from "../i18n.ts";
import { errorText } from "../ui/banner.ts";
import { applyChain, parseChain } from "./blocks.ts";
import { runCheck } from "./checks.ts";
import { expandTemplate } from "./fields.ts";
import { validateCommand } from "./model.ts";
import type { Command, CommandHooks, CommandResult, Expanded, FieldContext } from "./types.ts";

// --- markørstop (Tab-felter) -----------------------------------------------------------------------
//
// Egen lille maskine i stedet for autocompletes snippet(): den kræver flere markører på én gang
// (allowMultipleSelections) for at udfylde samme nummer samlet, og det ville give Ctrl+klik en ny
// betydning på skrivefladen, hvor Ctrl+klik åbner links. Her har feltet ét aktivt stop, og et filter
// skriver det samme i de andre stop med samme nummer i samme transaktion.

export type StopRange = { index: number; from: number; to: number };
/** `active` er pladsen i `ranges`. `end` er der, markøren ender efter sidste stop. */
export type Stops = { ranges: StopRange[]; active: number; end: number };

export const setStops = StateEffect.define<Stops | null>();

/** Stoppene efter en transaktion. Ren, så den kan testes uden en editor. */
export function nextStops(value: Stops | null, tr: Transaction): Stops | null {
  for (const e of tr.effects) if (e.is(setStops)) return e.value;
  if (!value) return null;
  let next = value;
  if (tr.docChanged) {
    if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return null;
    const group = value.ranges[value.active].index;
    const own = value.ranges.filter((r) => r.index === group);
    // En ændring uden for det aktive stop: skribenten er gået videre, eller teksten er ændret udefra.
    let inside = true;
    tr.changes.iterChangedRanges((a, b) => {
      if (!own.some((r) => a >= r.from && b <= r.to)) inside = false;
    });
    if (!inside) return null;
    next = {
      // Det aktive stop vokser med det, der skrives i kanten. De andre gør ikke.
      ranges: value.ranges.map((r) => {
        if (r.index === group) return { index: r.index, from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) };
        const from = tr.changes.mapPos(r.from, 1);
        return { index: r.index, from, to: Math.max(from, tr.changes.mapPos(r.to, -1)) };
      }),
      active: value.active,
      end: tr.changes.mapPos(value.end, 1),
    };
  }
  if (tr.docChanged || tr.selection) {
    const { from, to } = tr.state.selection.main;
    const act = next.ranges[next.active];
    if (from >= act.from && to <= act.to) return next;
    const i = next.ranges.findIndex((r) => from >= r.from && to <= r.to);
    // Markøren er flyttet ud af felterne: de slukkes.
    if (i < 0) return null;
    next = { ...next, active: i };
  }
  return next;
}

const stopMark = Decoration.mark({ class: "gt-stop" });
const activeStopMark = Decoration.mark({ class: "gt-stop gt-stop-active" });

export const stopField = StateField.define<Stops | null>({
  create: () => null,
  update: nextStops,
  provide: (f) =>
    EditorView.decorations.from(f, (v) => {
      if (!v) return Decoration.none;
      const group = v.ranges[v.active].index;
      const marks = v.ranges.filter((r) => r.to > r.from).map((r) => (r.index === group ? activeStopMark : stopMark).range(r.from, r.to));
      return Decoration.set(marks, true);
    }),
});

/**
 * Samme nummer udfyldes samlet: det, der skrives i det aktive stop, skrives også i de andre stop
 * med samme nummer, i samme transaktion og dermed samme fortryd-trin.
 */
const mirrorStops = EditorState.transactionFilter.of((tr) => {
  const v = tr.startState.field(stopField, false);
  if (!v || !tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete"))) return tr;
  const act = v.ranges[v.active];
  const mirrors = v.ranges.filter((r) => r !== act && r.index === act.index);
  if (!mirrors.length) return tr;
  let inside = true;
  tr.changes.iterChangedRanges((a, b) => {
    if (a < act.from || b > act.to) inside = false;
  });
  if (!inside) return tr;
  const text = tr.newDoc.sliceString(tr.changes.mapPos(act.from, -1), tr.changes.mapPos(act.to, 1));
  const changes = mirrors.map((m) => {
    const from = tr.changes.mapPos(m.from, 1);
    return { from, to: Math.max(from, tr.changes.mapPos(m.to, -1)), insert: text };
  });
  return [tr, { changes, sequential: true }];
});

/** Tab og Shift+Tab: næste eller forrige nummer. Efter det sidste ender markøren på sin plads. */
function moveStop(dir: 1 | -1): (view: EditorView) => boolean {
  return (view) => {
    const v = view.state.field(stopField, false);
    if (!v) return false;
    const indexes = [...new Set(v.ranges.map((r) => r.index))].sort((a, b) => a - b);
    const target = indexes[indexes.indexOf(v.ranges[v.active].index) + dir];
    if (target === undefined) {
      if (dir > 0) view.dispatch({ selection: { anchor: v.end }, effects: setStops.of(null), scrollIntoView: true });
      return true;
    }
    const i = v.ranges.findIndex((r) => r.index === target);
    const r = v.ranges[i];
    view.dispatch({ selection: EditorSelection.range(r.from, r.to), effects: setStops.of({ ...v, active: i }), scrollIntoView: true });
    return true;
  };
}

/** Esc forlader felterne. Teksten bliver stående. */
function leaveStops(view: EditorView): boolean {
  if (!view.state.field(stopField, false)) return false;
  view.dispatch({ effects: setStops.of(null) });
  return true;
}

const stopTheme = EditorView.baseTheme({
  ".gt-stop": { borderBottom: "1px dotted var(--kant-hover, #bdbdbd)" },
  ".gt-stop-active": { borderBottom: "1px solid var(--blå, #1aa3ff)" },
});

/**
 * Markørstoppene: feltet, spejlingen og tasterne. Prec.highest, fordi Tab ellers rykker ind
 * (shortcuts.ts). Tasterne slipper igennem, når ingen felter er tændt.
 */
export function tabStops(): Extension {
  return [
    stopField,
    mirrorStops,
    stopTheme,
    Prec.highest(
      keymap.of([
        { key: "Tab", run: moveStop(1), shift: moveStop(-1) },
        { key: "Escape", run: leaveStops },
      ]),
    ),
  ];
}

/** Stoppene fra en udfoldet skabelon, flyttet til dokumentets koordinater. Null uden stop. */
function stopsFor(ex: Expanded, base: number): Stops | null {
  if (!ex.stops.length) return null;
  const ranges = ex.stops.map((s) => ({ index: s.index, from: base + s.from, to: base + s.to })).sort((a, b) => a.from - b.from);
  const lowest = Math.min(...ranges.map((r) => r.index));
  return { ranges, active: ranges.findIndex((r) => r.index === lowest), end: base + (ex.cursor ?? ex.text.length) };
}

// --- området, en kommando virker på ----------------------------------------------------------------

/** Noter til mig selv. Programmets egne blokke (`gt:`) er skjulte og håndteres af hidden.ts. */
const NOTE = /<!--(?!\s*gt:)[\s\S]*?-->/g;
/** `{{markering}}` eller `{{selection}}` i en skabelon (ikke `\{{`). */
const SELECTION_FIELD = /(?<!\\)\{\{\s*(?:markering|selection)\s*\}\}/;

/** Området uden de skjulte blokke, som stykker uden blanktegn i kanterne. Tomme stykker udgår. */
export function visibleSegments(state: EditorState, span: Span): Span[] {
  const hidden = protectedRanges(state);
  const pieces: Span[] = [];
  let pos = span.from;
  for (let i = 0; i < hidden.length; i += 2) {
    const [a, b] = [hidden[i], hidden[i + 1]];
    if (b <= pos || a >= span.to) continue;
    if (a > pos) pieces.push({ from: pos, to: a });
    pos = Math.max(pos, b);
  }
  if (pos < span.to) pieces.push({ from: pos, to: span.to });
  const out: Span[] = [];
  for (const p of pieces) {
    const text = state.sliceDoc(p.from, p.to);
    const from = p.from + (text.length - text.trimStart().length);
    const to = p.to - (text.length - text.trimEnd().length);
    if (to > from) out.push({ from, to });
  }
  return out;
}

/**
 * Teksten i området, som tjek og AI skal se den: skjulte blokke og noter er blanktegn. Længden er
 * den samme, så en position i svaret plus `span.from` er en position i dokumentet.
 */
export function readableSlice(state: EditorState, span: Span): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  let text = state.sliceDoc(span.from, span.to);
  const hidden = protectedRanges(state);
  for (let i = 0; i < hidden.length; i += 2) {
    const a = Math.max(hidden[i], span.from) - span.from;
    const b = Math.min(hidden[i + 1], span.to) - span.from;
    if (b > a) text = text.slice(0, a) + blank(text.slice(a, b)) + text.slice(b);
  }
  return text.replace(NOTE, blank);
}

/**
 * Det skrevne »/navn«, der skal væk. Står det sidst på linjen efter et enkelt mellemrum, som kun
 * blev skrevet for at åbne menuen, tages mellemrummet med.
 */
function typedRange(state: EditorState, replace: Span): Span {
  const line = state.doc.lineAt(replace.from);
  const before = state.sliceDoc(Math.max(line.from, replace.from - 2), replace.from);
  return replace.to === line.to && /\S $/.test(before) ? { from: replace.from - 1, to: replace.to } : replace;
}

/** Markeringen, ellers hele teksten (`scope: document`), ellers afsnittet ved markøren. */
function scopeOf(state: EditorState, command: Command): Span | null {
  const sel = state.selection.main;
  if (!sel.empty) return { from: sel.from, to: sel.to };
  if (command.scope === "document") return { from: 0, to: state.doc.length };
  return paragraphAt(state, sel.head);
}

// --- planen ------------------------------------------------------------------------------------------

export type Plan = {
  /** Kommandoen blev kørt (tæller som brugt). */
  ran: boolean;
  /** Ændringen i teksten. Altid én transaktion. */
  spec?: TransactionSpec;
  /** En fejl eller en kort kvittering til beskedlinjen. */
  notice?: string;
  /** Tjekkets fund, med positioner i dokumentet efter `spec`. */
  result?: CommandResult;
  /** Teksten til en AI-kommando og dens plads i dokumentet efter `spec`. */
  ai?: { text: string; offset: number };
  /** Skabelonen skal blive til en ny tekst. */
  newFile?: Expanded;
  /** Højre spalte skal vise det, der blev flyttet: fraklip, eller fodnoten med den etiket. */
  moved?: { to: "clip" } | { to: "footnote"; label: string };
  /** En ny tabel begynder her: dens første celle skal have fokus (tables.ts). */
  table?: number;
};

type FileContext = ReturnType<CommandHooks["fileContext"]>;

const removeTyped = (span: Span): TransactionSpec => ({ changes: { from: span.from, to: span.to, insert: "" }, userEvent: "delete.command" });

const NOTHING_HERE = (): string => tr("Stil markøren i et afsnit, eller marker tekst først.", "Put the cursor in a paragraph, or select text first.");

function planTemplate(state: EditorState, command: Command, file: FileContext, replace: Span | undefined, now: Date): Plan {
  const sel = state.selection.main;
  const doc = state.doc.toString();
  // Tallene om teksten fryses ved indsættelsen, uden det skrevne »/navn«.
  const c = count(replace ? doc.slice(0, replace.from) + doc.slice(replace.to) : doc);
  const ctx: FieldContext = {
    now,
    lang: currentLang(),
    name: file.name,
    filename: file.filename,
    title: file.title,
    selection: state.sliceDoc(sel.from, sel.to),
    words: c.words,
    characters: c.chars,
    readingMinutes: c.minutes,
  };
  const ex = expandTemplate(command.body, ctx);
  if (command.newfile) return { ran: true, spec: replace ? removeTyped(replace) : undefined, newFile: ex };
  // En markering erstattes kun, når skabelonen selv bruger den. Ellers sættes der ind efter den.
  const usesSelection = !sel.empty && SELECTION_FIELD.test(command.body);
  const range = replace ?? (usesSelection ? { from: sel.from, to: sel.to } : { from: sel.to, to: sel.to });
  const stops = stopsFor(ex, range.from);
  const first = stops?.ranges[stops.active];
  return {
    ran: true,
    spec: {
      changes: { from: range.from, to: range.to, insert: ex.text },
      selection: first ? EditorSelection.range(first.from, first.to) : { anchor: range.from + (ex.cursor ?? ex.text.length) },
      effects: setStops.of(stops),
      userEvent: "input.command",
      scrollIntoView: true,
    },
  };
}

/** En tom tabel med tre kolonner og én række. Cellerne udfyldes i tabellen (tables.ts). */
export const EMPTY_TABLE = "|  |  |  |\n|---|---|---|\n|  |  |  |";

/**
 * /tabel uden markering: en tom tabel, hvor det skrevne stod. Den skal stå på sine egne linjer med
 * en tom linje imellem, ellers læser markdown den ikke som en tabel.
 */
function planEmptyTable(state: EditorState, replace: Span | undefined): Plan {
  const at = replace ?? { from: state.selection.main.head, to: state.selection.main.head };
  const line = state.doc.lineAt(at.from);
  const before = state.sliceDoc(line.from, at.from);
  const after = state.sliceDoc(at.to, line.to);
  const prevLine = line.number > 1 ? state.doc.line(line.number - 1).text : "";
  const nextLine = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : "";
  const lead = before.trim() !== "" ? "\n\n" : prevLine.trim() !== "" ? "\n" : "";
  const tail = after.trim() !== "" ? "\n\n" : nextLine.trim() !== "" ? "\n" : "";
  // Hele linjen skrives om: teksten før og efter det skrevne bliver stående på hver sin side af tabellen.
  const insert = before.trimEnd() + lead + EMPTY_TABLE + tail + after.trimStart();
  const tableAt = line.from + before.trimEnd().length + lead.length;
  return {
    ran: true,
    spec: { changes: { from: line.from, to: line.to, insert }, selection: { anchor: tableAt }, userEvent: "input.command", scrollIntoView: true },
    table: tableAt,
  };
}

function planTransform(state: EditorState, command: Command, replace: Span | undefined): Plan {
  const { steps, errors } = parseChain(command.body);
  if (errors.length) return { ran: false, notice: cannotRun(command, errors[0].message) };
  if (steps.length === 1 && steps[0].block === "table" && state.selection.main.empty) return planEmptyTable(state, replace);
  const typed = replace ? typedRange(state, replace) : null;
  const sel = state.selection.main;
  const hull = scopeOf(state, command);
  const segments = hull ? visibleSegments(state, hull) : [];
  const doc = state.doc.toString();

  // Hvert stykke for sig, uden det skrevne »/navn«.
  const pieces: Piece[] = [];
  let then: "clip" | "footnote" | null = null;
  for (const seg of segments) {
    const before = doc.slice(seg.from, seg.to);
    const inSeg = typed !== null && typed.from >= seg.from && typed.to <= seg.to;
    const input = inSeg ? doc.slice(seg.from, typed.from) + doc.slice(typed.to, seg.to) : before;
    if (!input.trim()) {
      // Stykket var kun det skrevne »/navn«: det skal bare væk.
      pieces.push({ ...seg, before, after: input, content: false });
      continue;
    }
    // Noter, fodnotehenvisninger og mærkerne om dæmpet tekst beskytter klodserne selv (blocks.ts).
    const result = applyChain(steps, input, currentLang());
    const after = result.text;
    then = result.then;
    pieces.push({ ...seg, before, after, content: true });
  }
  const covered = typed !== null && pieces.some((p) => typed.from >= p.from && typed.to <= p.to);
  const extra: Change[] = typed && !covered ? [{ from: typed.from, to: typed.to, insert: "" }] : [];
  if (!pieces.some((p) => p.content)) return { ran: false, spec: typed ? removeTyped(typed) : undefined, notice: NOTHING_HERE() };

  if (then === "clip") return planClip(state, pieces, extra);
  if (then === "footnote") return planFootnote(state, pieces, extra);

  const changes: Change[] = [...pieces.filter((p) => p.after !== p.before).map((p) => ({ from: p.from, to: p.to, insert: p.after })), ...extra];
  if (!changes.length) return { ran: true, notice: tr("Der var intet at ændre.", "There was nothing to change.") };
  const set = state.changes(changes);
  const last = pieces[pieces.length - 1];
  return {
    ran: true,
    spec: {
      changes: set,
      // En markering bliver stående om resultatet. Ellers ender markøren efter det.
      selection: !sel.empty && pieces.length === 1 ? EditorSelection.range(set.mapPos(last.from, -1), set.mapPos(last.to, 1)) : { anchor: set.mapPos(last.to, 1) },
      userEvent: "input.command",
      scrollIntoView: true,
    },
    notice: sel.empty && command.scope === "document" ? tr("Hele teksten er omformet. Ctrl+Z fortryder.", "The whole text was transformed. Ctrl+Z undoes it.") : undefined,
  };
}

type Change = { from: number; to?: number; insert: string };
/** Et stykke af området før og efter kæden. `content`: der var tekst at omforme. */
type Piece = Span & { before: string; after: string; content: boolean };

/** Dokumentet uden stykkerne, og en funktion, der flytter en position derfra tilbage til dokumentet. */
function without(doc: string, pieces: Span[]): { text: string; back: (pos: number) => number } {
  let text = "";
  let pos = 0;
  for (const p of pieces) {
    text += doc.slice(pos, p.from);
    pos = p.to;
  }
  text += doc.slice(pos);
  const back = (at: number): number => {
    let shift = 0;
    for (const p of pieces) {
      if (at > p.from - shift) shift += p.to - p.from;
      else break;
    }
    return at + shift;
  };
  return { text, back };
}

/** `clip` sidst i kæden: resultatet flyttes til Fraklip, som Ctrl+Alt+X gør (shortcuts.ts). */
function planClip(state: EditorState, pieces: Piece[], extra: Change[]): Plan {
  const doc = state.doc.toString();
  const text = pieces.map((p) => p.after.trim()).filter(Boolean).join("\n\n");
  if (!text) return { ran: false, notice: NOTHING_HERE() };
  const appended = parkChanges(without(doc, pieces).text, [text]);
  const set = state.changes([...pieces.map((p) => ({ from: p.from, to: p.to, insert: "" })), ...extra, { from: doc.length, insert: appended[appended.length - 1].insert }]);
  return {
    ran: true,
    spec: {
      changes: set,
      selection: { anchor: set.mapPos(pieces[0].from, -1) },
      // Blokken skrives sidst i teksten, hvor de skjulte blokke står: det må kun programmets egne hændelser.
      userEvent: "delete.park",
    },
    moved: { to: "clip" },
  };
}

/** `footnote` sidst i kæden: resultatet bliver en fodnote, hvor det stod (editing.ts insertFootnote). */
function planFootnote(state: EditorState, pieces: Piece[], extra: Change[]): Plan {
  const doc = state.doc.toString();
  const body = pieces.map((p) => p.after).join(" ").replace(/\s*\n\s*/g, " ").trim();
  const first = pieces.find((p) => p.content);
  if (!first || !body) return { ran: false, notice: NOTHING_HERE() };
  const rest = without(doc, pieces);
  const removedBefore = pieces.filter((p) => p.to <= first.from).reduce((n, p) => n + (p.to - p.from), 0);
  const note = insertFootnote(rest.text, first.from - removedBefore, body);
  const [ref, definition] = note.changes;
  const at = rest.back(definition.from);
  const changes: Change[] = [];
  if (at >= first.from && at <= first.to) {
    // Teksten stod sidst: henvisning og definition lander samme sted.
    changes.push({ from: first.from, to: first.to, insert: ref.insert + definition.insert });
  } else {
    changes.push({ from: first.from, to: first.to, insert: ref.insert }, { from: at, insert: definition.insert });
  }
  for (const p of pieces) if (p !== first) changes.push({ from: p.from, to: p.to, insert: "" });
  const set = state.changes([...changes, ...extra]);
  return {
    ran: true,
    spec: {
      changes: set,
      selection: { anchor: set.mapPos(first.from, -1) + ref.insert.length },
      // Definitionen er en skjult linje, og den kan stå lige foran fraklippet (hidden.ts).
      userEvent: "input.note",
    },
    moved: { to: "footnote", label: note.label },
  };
}

/** Tjek og AI: det skrevne fjernes først, og resten regnes på teksten, som den står derefter. */
function planReading(state: EditorState, command: Command, replace: Span | undefined): Plan {
  const spec = replace ? removeTyped(typedRange(state, replace)) : undefined;
  const after = spec ? state.update(spec).state : state;
  // Uden markering og uden afsnit ved markøren ses der på hele teksten. Der skrives intet.
  const span = scopeOf(after, command) ?? { from: 0, to: after.doc.length };
  const text = readableSlice(after, span);
  if (!text.trim()) return { ran: false, spec, notice: tr("Der er ingen tekst at se på.", "There is no text to look at.") };
  if (command.kind === "ai") return { ran: true, spec, ai: { text: text.trimEnd(), offset: span.from } };
  const findings = runCheck(command, text, currentLang())
    // Et fund i en skjult blok eller en note er ikke et fund i teksten.
    .filter((f) => text.slice(f.from, f.to).trim() !== "" || f.to === f.from)
    .map((f) => ({ ...f, from: f.from + span.from, to: f.to + span.from }));
  return {
    ran: true,
    spec,
    result: { kind: "findings", title: `/${command.name}`, findings, note: findings.length ? undefined : tr("Ingen fund.", "Nothing found.") },
  };
}

function cannotRun(command: Command, reason: string): string {
  return tr(`/${command.name} kan ikke køres: ${reason}`, `/${command.name} can't run: ${reason}`);
}

/**
 * Hvad kommandoen skal gøre ved teksten. `replace` er det skrevne »/navn«. En kommando med fejl
 * køres ikke, og det skrevne bliver stående, så fejlen kan ses i sammenhæng.
 */
export function planCommand(state: EditorState, command: Command, file: FileContext, replace?: Span, now = new Date()): Plan {
  const errors = validateCommand(command);
  if (errors.length) return { ran: false, notice: cannotRun(command, errors[0].message) };
  try {
    if (command.kind === "template") return planTemplate(state, command, file, replace, now);
    if (command.kind === "transform") return planTransform(state, command, replace);
    return planReading(state, command, replace);
  } catch (e) {
    return { ran: false, notice: cannotRun(command, errorText(e)) };
  }
}

/** Den nye tekst er åbnet i samme editor: tænd skabelonens stop der. */
function startStopsInNewFile(view: EditorView, ex: Expanded): void {
  if (view.state.field(stopField, false) === undefined || view.state.sliceDoc(0, ex.text.length) !== ex.text) return;
  const stops = stopsFor(ex, 0);
  const first = stops?.ranges[stops.active];
  if (first) view.dispatch({ selection: EditorSelection.range(first.from, first.to), effects: setStops.of(stops), scrollIntoView: true });
  else if (ex.cursor !== null) view.dispatch({ selection: { anchor: ex.cursor }, scrollIntoView: true });
}

/**
 * Kør en kommando i editoren. Det skrevne »/navn« (`replace`) fjernes, og resultatet sættes ind i
 * samme transaktion. Svarer sandt, når kommandoen blev kørt.
 */
export function runCommand(view: EditorView, command: Command, hooks: CommandHooks, replace?: { from: number; to: number }): boolean {
  const plan = planCommand(view.state, command, hooks.fileContext(), replace);
  if (plan.spec) view.dispatch(plan.spec);
  if (plan.notice) hooks.notify(plan.notice);
  if (plan.moved?.to === "clip") window.dispatchEvent(new Event("gt-parked"));
  if (plan.moved?.to === "footnote") window.dispatchEvent(new CustomEvent("gt-note", { detail: plan.moved.label }));
  if (plan.table !== undefined) focusTable(view, plan.table);
  if (plan.result) hooks.showResult(plan.result);
  if (plan.ai) hooks.runAi(command, plan.ai.text, plan.ai.offset);
  if (plan.newFile) {
    const ex = plan.newFile;
    hooks.newFile(ex.text).then(
      () => startStopsInNewFile(view, ex),
      (e) => hooks.notify(errorText(e)),
    );
  }
  return plan.ran;
}
