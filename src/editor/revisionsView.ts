// Noter og rettelser i editoren (critic.ts). Mærkerne (<!-- -->, {>> <<}, {++ ++}, {~~ ~> ~~}) skjules, til
// markøren står i dem, ligesom resten af live preview. En note vises som en lille dæmpet mærkat.
// En rettelse viser den gamle tekst gennemstreget og den nye understreget, og står markøren i den,
// spørger en boble »Godtag« eller »Afvis«, ét ad gangen.

import { EditorState, StateField, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, showTooltip, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";

import { TextMemo } from "./touches.ts";
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

function touched(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const { notes, revisions } = scan(state.doc);
  const visible = (from: number, to: number) => view.visibleRanges.some((r) => to >= r.from && from <= r.to);
  const out: Range<Decoration>[] = [];
  for (const n of notes) {
    if (!visible(n.from, n.to)) continue;
    if (touched(state, n.from, n.to)) {
      out.push(mark("gt-crit-mark").range(n.from, n.from + n.open), mark("gt-crit-mark").range(n.to - n.close, n.to));
    } else {
      out.push(hide.range(n.from, n.from + n.open), mark("gt-note").range(n.from + n.open, n.to - n.close), hide.range(n.to - n.close, n.to));
    }
  }
  for (const r of revisions) {
    if (!visible(r.from, r.to)) continue;
    const open = touched(state, r.from, r.to);
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
  return Decoration.set(out, true);
}

const view = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) {
      this.decorations = build(v);
    }
    update(u: ViewUpdate) {
      found.advance(u);
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

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
  if (!sel.empty) return [];
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
  update: (_v, tr) => bubble(tr.state),
  provide: (f) => showTooltip.computeN([f], (s) => s.field(f)),
});

export const revisions = [view, bubbleField];

export const revisionsTheme = EditorView.theme({
  ".gt-note": {
    fontFamily: "var(--ui)",
    fontSize: "0.82em",
    color: "var(--note-tekst)",
    backgroundColor: "var(--note-flade)",
    borderRadius: "4px",
    padding: "1px 6px",
  },
  ".gt-crit-mark": { color: "var(--dæmpet)" },
  ".gt-rev-old": { textDecoration: "line-through", textDecorationColor: "var(--fejl)", color: "var(--svag)" },
  ".gt-rev-new": { textDecoration: "underline", textDecorationColor: "var(--ok)", textDecorationThickness: "2px", textUnderlineOffset: "4px" },
});
