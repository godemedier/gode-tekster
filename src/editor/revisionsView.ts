// Noter og rettelser i editoren (critic.ts). Mærkerne (<!-- -->, {>> <<}, {++ ++}, {~~ ~> ~~}) skjules, til
// markøren står i dem, ligesom resten af live preview. En note vises som en lille dæmpet mærkat.
// En rettelse viser den gamle tekst gennemstreget og den nye understreget, og står markøren i den,
// spørger en boble »Godtag« eller »Afvis«, ét ad gangen.
// Roligt (`setShowRevisions`, gæstens side): teksten står, som den bliver, og en streg i margenen viser,
// hvor der er rettet. Som »Enkel markering« i Word.
// Gæstens side (`setNoteDisplay`, 21/10): en note er ét helt stykke, som markøren ikke kan komme ind
// i, så `<!--` aldrig kommer frem. Et lille tal, når noten står som kort i margenen, ellers mærkaten.

import { EditorState, StateEffect, StateField, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, showTooltip, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";

import { TextMemo } from "./touches.ts";
import { extraHidden } from "./livePreview.ts";
import { noBreakMarks } from "./noBreak.ts";
import { suggesting } from "./suggest.ts";
import { acceptChanges, findNotes, findRevisions, rejectChanges, type Note, type Revision } from "./critic.ts";
import { tr } from "../i18n.ts";

type Found = { notes: Note[]; revisions: Revision[] };
const found = new TextMemo<Found>(
  ["{>>", "<<}", "<!--", "-->", "{++", "++}", "{~~", "~>", "~~}"],
  (s) => ({ notes: findNotes(s), revisions: findRevisions(s) }),
  (f, ch) => ({
    notes: f.notes.map((n) => ({ ...n, from: ch.mapPos(n.from), to: ch.mapPos(n.to) })),
    revisions: f.revisions.map((r) => ({ ...r, from: ch.mapPos(r.from), to: ch.mapPos(r.to), oldFrom: ch.mapPos(r.oldFrom), nextFrom: ch.mapPos(r.nextFrom) })),
  }),
  (f) => [...f.notes, ...f.revisions],
);
const scan = (doc: Text): Found => found.get(doc);

const hide = Decoration.replace({});
const mark = (cls: string) => Decoration.mark({ class: cls });
const changedLine = Decoration.line({ class: "gt-rev-line" });

/** Vis rettelserne (gammel tekst gennemstreget, ny understreget) eller kun en streg i margenen. */
export const setShowRevisions = StateEffect.define<boolean>();
export const showRevisions = StateField.define<boolean>({
  create: () => true,
  update: (on, tr) => tr.effects.reduce((v, e) => (e.is(setShowRevisions) ? e.value : v), on),
});

/** »inline«: mærkerne skjules, til markøren står i noten (programmet). »label« og »number«: gæstens side. */
export type NoteDisplay = "inline" | "label" | "number";
export const setNoteDisplay = StateEffect.define<NoteDisplay>();
const noteDisplay = StateField.define<NoteDisplay>({
  create: () => "inline",
  update: (d, tr) => tr.effects.reduce((v, e) => (e.is(setNoteDisplay) ? e.value : v), d),
});

/** En hel note som mærkat eller tal. Et klik sender `gt-note-open` med notens position. */
class NoteWidget extends WidgetType {
  readonly text: string;
  readonly n: number;
  readonly display: NoteDisplay;
  constructor(text: string, n: number, display: NoteDisplay) {
    super();
    this.text = text;
    this.n = n;
    this.display = display;
  }
  eq(o: NoteWidget): boolean {
    return o.text === this.text && o.n === this.n && o.display === this.display;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.display === "number" ? "sup" : "span");
    el.className = this.display === "number" ? "gt-note-nr" : "gt-note";
    el.textContent = this.display === "number" ? String(this.n) : this.text;
    el.title = this.text;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      el.dispatchEvent(new CustomEvent("gt-note-open", { bubbles: true, detail: view.posAtDOM(el) }));
    });
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function touched(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

export function build(view: EditorView): DecorationSet {
  return Decoration.set(collect(view).all, true);
}

/** Alle dekorationer, og den skjulte tekst for sig, så den kan gøres atomisk i den rolige visning. */
function collect(view: EditorView): { all: Range<Decoration>[]; hidden: Range<Decoration>[] } {
  const { state } = view;
  const { notes, revisions } = scan(state.doc);
  const visible = (from: number, to: number) => view.visibleRanges.some((r) => to >= r.from && from <= r.to);
  const out: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  const display = state.field(noteDisplay, false) ?? "inline";
  for (const [i, n] of notes.entries()) {
    if (!visible(n.from, n.to)) continue;
    // Et plugin må ikke skjule et linjeskift, så en note over flere linjer vises som i programmet. Det
    // samme gør en note inde i et forslag, hvor den gamle tekst måske allerede er skjult.
    const inRevision = revisions.some((r) => n.from >= r.from && n.to <= r.to);
    if (display !== "inline" && !inRevision && state.doc.lineAt(n.from).to >= n.to) {
      // Tallet sidder på ordet foran, så mellemrummet før noten går med.
      const from = display === "number" && n.from > 0 && /[ \t]/.test(state.doc.sliceString(n.from - 1, n.from)) ? n.from - 1 : n.from;
      hidden.push(Decoration.replace({ widget: new NoteWidget(n.text, i + 1, display) }).range(from, n.to));
      continue;
    }
    // På gæstens side kommer tegnene aldrig frem, heller ikke i en note inde i et forslag.
    if (display === "inline" && touched(state, n.from, n.to)) {
      out.push(mark("gt-crit-mark").range(n.from, n.from + n.open), mark("gt-crit-mark").range(n.to - n.close, n.to));
    } else {
      out.push(hide.range(n.from, n.from + n.open), hide.range(n.to - n.close, n.to));
      if (n.to - n.close > n.from + n.open) out.push(mark("gt-note").range(n.from + n.open, n.to - n.close));
    }
  }
  const calm = state.field(showRevisions, false) === false;
  const lines = new Set<number>();
  for (const r of revisions) {
    if (!visible(r.from, r.to)) continue;
    if (calm) {
      // Kun den nye tekst står tilbage. Den gamle og mærkerne skjules, og linjen får en streg.
      const gone = r.kind === "ins" ? [[r.from, r.from + 3]] : [[r.from, r.nextFrom]];
      gone.push([r.to - 3, r.to]);
      // Et plugin må ikke skjule et linjeskift, så skjul stykket linje for linje. Går det over flere
      // linjer, skjuler `acrossLines` det i ét stykke (StateField), ellers stod der tomme linjer.
      for (const [a, b] of gone) {
        if (state.doc.lineAt(a).number !== state.doc.lineAt(b).number) continue;
        for (let at = a; at < b; ) {
          const end = Math.min(b, state.doc.lineAt(at).to);
          if (end > at) hidden.push(hide.range(at, end));
          at = end + 1;
        }
      }
      for (let l = state.doc.lineAt(r.from); ; l = state.doc.line(l.number + 1)) {
        lines.add(l.from);
        if (l.to >= r.to || l.number === state.doc.lines) break;
      }
      continue;
    }
    // I forslagstilstanden står markøren altid i et forslag. Mærkerne bliver skjult, så man ser
    // rettelsen som i Word og ikke `{++…++}`.
    const open = !state.field(suggesting, false) && touched(state, r.from, r.to);
    if (r.kind === "ins") {
      out.push((open ? mark("gt-crit-mark") : hide).range(r.from, r.from + 3));
      if (r.next) out.push(mark("gt-rev-new").range(r.nextFrom, r.nextFrom + r.next.length));
      out.push((open ? mark("gt-crit-mark") : hide).range(r.to - 3, r.to));
    } else {
      out.push((open ? mark("gt-crit-mark") : hide).range(r.from, r.oldFrom));
      if (r.old) out.push(mark("gt-rev-old").range(r.oldFrom, r.oldFrom + r.old.length));
      out.push((open ? mark("gt-crit-mark") : hide).range(r.oldFrom + r.old.length, r.nextFrom));
      if (r.next) out.push(mark("gt-rev-new").range(r.nextFrom, r.nextFrom + r.next.length));
      out.push((open ? mark("gt-crit-mark") : hide).range(r.to - 3, r.to));
    }
  }
  out.push(...hidden, ...[...lines].map((at) => changedLine.range(at)));
  out.push(...noBreakMarks(state.doc, out));
  return { all: out, hidden };
}

const view = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    hidden: DecorationSet;
    constructor(v: EditorView) {
      ({ decorations: this.decorations, hidden: this.hidden } = sets(v));
    }
    update(u: ViewUpdate) {
      found.advance(u);
      const toggled = (f: StateField<boolean>) => u.startState.field(f, false) !== u.state.field(f, false);
      const redisplayed = u.startState.field(noteDisplay, false) !== u.state.field(noteDisplay, false);
      if (u.docChanged || u.selectionSet || u.viewportChanged || toggled(suggesting) || toggled(showRevisions) || redisplayed) {
        ({ decorations: this.decorations, hidden: this.hidden } = sets(u.view));
      }
    }
  },
  { decorations: (v) => v.decorations },
);

function sets(v: EditorView): { decorations: DecorationSet; hidden: DecorationSet } {
  const { all, hidden } = collect(v);
  return { decorations: Decoration.set(all, true), hidden: Decoration.set(hidden, true) };
}

export function acceptRevision(v: EditorView, r: Revision): void {
  v.dispatch({ changes: acceptChanges(r), userEvent: "input.revision" });
}

export function rejectRevision(v: EditorView, r: Revision): void {
  v.dispatch({ changes: rejectChanges(r), userEvent: "delete.revision" });
}

/** Godtag eller afvis alle på én gang (rettelserne overlapper aldrig, så ændringerne kan samles). */
export function resolveAll(v: EditorView, accept: boolean): number {
  const all = findRevisions(v.state.doc.toString());
  if (!all.length) return 0;
  v.dispatch({ changes: all.flatMap(accept ? acceptChanges : rejectChanges), userEvent: accept ? "input.revision" : "delete.revision" });
  return all.length;
}

export function revisionCount(state: EditorState): number {
  return scan(state.doc).revisions.length;
}

function bubble(state: EditorState): readonly Tooltip[] {
  const sel = state.selection.main;
  // Mens man foreslår, står markøren altid i et forslag, og boblen lå over linjen ovenfor (20/10).
  if (!sel.empty || state.field(suggesting, false) || state.field(showRevisions, false) === false) return [];
  const r = scan(state.doc).revisions.find((x) => sel.head > x.from && sel.head < x.to);
  if (!r) return [];
  return [
    {
      pos: r.from,
      above: true,
      arrow: false,
      create: (v) => {
        const dom = document.createElement("div");
        dom.className = "gt-suggest-bubble";
        const what = document.createElement("span");
        what.textContent = r.kind === "ins" ? tr("Indsæt", "Insert") : r.next ? tr("Erstat", "Replace") : tr("Slet", "Delete");
        const yes = document.createElement("button");
        yes.type = "button";
        yes.textContent = tr("Godtag", "Accept");
        const no = document.createElement("button");
        no.type = "button";
        no.textContent = tr("Afvis", "Reject");
        for (const [b, run] of [
          [yes, () => acceptRevision(v, r)],
          [no, () => rejectRevision(v, r)],
        ] as const) {
          b.addEventListener("mousedown", (e) => {
            e.preventDefault();
            run();
          });
        }
        dom.append(what, yes, no);
        return { dom };
      },
    },
  ];
}

const bubbleField = StateField.define<readonly Tooltip[]>({
  create: bubble,
  update: (_v, tr) => {
    found.advanceTr(tr);
    return bubble(tr.state);
  },
  provide: (f) => showTooltip.computeN([f], (s) => s.field(f)),
});

/**
 * Den gamle tekst og mærkerne i et forslag over et afsnitsskift, i den rolige visning. Fra et
 * StateField, fordi kun det må skjule et linjeskift. Før stod der tomme linjer, hvor den slettede
 * tekst havde været (gæstens side, »given … artikel … Scoren er«, 21/10).
 */
export function hiddenAcrossLines(state: EditorState): DecorationSet {
  if (state.field(showRevisions, false) !== false) return Decoration.none;
  const out: Range<Decoration>[] = [];
  for (const r of scan(state.doc).revisions) {
    const gone = r.kind === "ins" ? [[r.from, r.from + 3]] : [[r.from, r.nextFrom]];
    gone.push([r.to - 3, r.to]);
    for (const [a, b] of gone) if (b > a && state.doc.lineAt(a).number !== state.doc.lineAt(b).number) out.push(hide.range(a, b));
  }
  return Decoration.set(out, true);
}

const acrossLines = StateField.define<DecorationSet>({
  create: hiddenAcrossLines,
  update: (v, tr) => (tr.docChanged || tr.startState.field(showRevisions, false) !== tr.state.field(showRevisions, false) ? hiddenAcrossLines(tr.state) : v),
  provide: (f) => EditorView.decorations.from(f),
});

export const revisions = [
  view,
  bubbleField,
  showRevisions,
  noteDisplay,
  acrossLines,
  extraHidden.of((v) => v.plugin(view)?.hidden ?? Decoration.none),
  extraHidden.of((v) => v.state.field(acrossLines, false) ?? Decoration.none),
];

export const revisionsTheme = EditorView.theme({
  ".gt-note": {
    fontFamily: "var(--ui)",
    fontSize: "0.82em",
    color: "var(--note-tekst)",
    backgroundColor: "var(--note-flade)",
    borderRadius: "4px",
    padding: "1px 6px",
  },
  ".gt-note[title]": { cursor: "pointer" },
  // Gæstens side: tallet ud for et kort i margenen.
  ".gt-note-nr": {
    fontFamily: "var(--ui)",
    fontSize: "0.68em",
    fontWeight: "700",
    lineHeight: "1",
    color: "var(--note-tekst)",
    backgroundColor: "var(--note-flade)",
    borderRadius: "8px",
    padding: "1px 5px",
    marginLeft: "1px",
    cursor: "pointer",
  },
  ".gt-crit-mark": { color: "var(--dæmpet)" },
  // Den rolige visning: en tynd streg i margenen ud for et afsnit med rettelser.
  ".cm-line.gt-rev-line": { position: "relative" },
  ".cm-line.gt-rev-line::before": {
    content: '""',
    position: "absolute",
    left: "-14px",
    top: "0.35em",
    bottom: "0.35em",
    width: "3px",
    borderRadius: "2px",
    backgroundColor: "var(--ok)",
    opacity: "0.55",
  },
  ".gt-rev-old": { textDecoration: "line-through", textDecorationColor: "var(--fejl)", color: "var(--svag)" },
  ".gt-rev-new": { textDecoration: "underline", textDecorationColor: "var(--ok)", textDecorationThickness: "2px", textUnderlineOffset: "4px" },
  // Værktøjslinjen gør alle tooltips gennemsigtige (selectionToolbar.ts), så boblen har sin egen flade.
  ".gt-suggest-bubble": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 4px 3px 10px",
    fontFamily: "var(--ui)",
    fontSize: "12px",
    color: "var(--dæmpet)",
    backgroundColor: "var(--kort)",
    border: "1px solid var(--kant)",
    borderRadius: "6px",
    boxShadow: "var(--skygge)",
    transform: "translateY(-6px)",
  },
  ".gt-suggest-bubble button": {
    font: "inherit",
    fontWeight: "600",
    color: "var(--accent)",
    background: "none",
    border: "none",
    borderRadius: "4px",
    padding: "3px 6px",
    cursor: "pointer",
  },
  ".gt-suggest-bubble button:hover": { backgroundColor: "var(--hover)" },
});
