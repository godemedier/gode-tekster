// Kommandoerne til formatering, delt af tastaturgenvejene og menuen ved markering. Genvejene
// følger Word og Google Docs (2/10): Ctrl+B/I/U, Ctrl+K, Ctrl+1-4, Ctrl+Shift+7/8/9,
// Ctrl+Alt+F (fodnote), Ctrl+Alt+X (fraklip, som Highland). Prec.high, fordi CodeMirrors standard
// bruger Ctrl+I og Ctrl+U til andet.

import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { indentLess, indentMore, insertTab } from "@codemirror/commands";

import { insertFootnote, setHeading, toggleLinePrefix, toggleWrap, wrapLink, type EditPlan } from "./editing.ts";
import { clearFormatting, parkChanges, toTable } from "./parked.ts";
import { pickImage } from "./insertImage.ts";
import { expandParkRange, paragraphAt } from "./parkRange.ts";

type Planner = (text: string, from: number, to: number) => EditPlan;
export type Command = (view: EditorView) => boolean;

/** Udfører en plan som én transaktion. Tegnene tæller som skribentens egne (forfatterskab: input). */
function run(planner: Planner): Command {
  return (view) => {
    const { state } = view;
    const sel = state.selection.main;
    const plan = planner(state.doc.toString(), sel.from, sel.to);
    view.dispatch({
      changes: { from: plan.start, to: plan.end, insert: plan.replacement },
      selection: EditorSelection.range(plan.selStart, plan.selEnd),
      userEvent: "input.format",
      scrollIntoView: true,
    });
    view.focus();
    return true;
  };
}

/** Erstat markeringen med en omformet udgave (tabel, uden formatering). */
function transformSelection(fn: (s: string) => string): Command {
  return (view) => {
    const sel = view.state.selection.main;
    if (sel.empty) return false;
    const next = fn(view.state.sliceDoc(sel.from, sel.to));
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: next },
      selection: EditorSelection.range(sel.from, sel.from + next.length),
      userEvent: "input.format",
    });
    view.focus();
    return true;
  };
}


export const cmd = {
  bold: run((t, f, e) => toggleWrap(t, f, e, "**")),
  italic: run((t, f, e) => toggleWrap(t, f, e, "*")),
  underline: run((t, f, e) => toggleWrap(t, f, e, "<u>", "</u>")),
  strike: run((t, f, e) => toggleWrap(t, f, e, "~~")),
  dim: run((t, f, e) => toggleWrap(t, f, e, "{--", "--}")),
  link: run(wrapLink),
  heading: (level: number) => run((t, f, e) => setHeading(t, f, e, level)),
  bullets: run((t, f, e) => toggleLinePrefix(t, f, e, "- ")),
  numbered: run((t, f, e) => toggleLinePrefix(t, f, e, "1. ")),
  tasks: run((t, f, e) => toggleLinePrefix(t, f, e, "- [ ] ")),
  quote: run((t, f, e) => toggleLinePrefix(t, f, e, "> ")),
  table: transformSelection(toTable),
  clear: transformSelection(clearFormatting),

  /** Ctrl+Alt+F: ny fodnote. Fanen Fodnoter åbner med noten klar til at skrive (ADR-0017). */
  footnote(view: EditorView): boolean {
    const { changes, label } = insertFootnote(view.state.doc.toString(), view.state.selection.main.head);
    view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
    window.dispatchEvent(new CustomEvent("gt-note", { detail: label }));
    return true;
  },

  /** Ctrl+Alt+N: note til mig selv <!-- … --> (critic.ts, 5/10). Markeret tekst bliver noten. */
  note(view: EditorView): boolean {
    const { from, to } = view.state.selection.main;
    const text = view.state.sliceDoc(from, to).replace(/-->/g, "-- >");
    const insert = `<!-- ${text} -->`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + 5 + text.length },
      userEvent: "input.note",
      scrollIntoView: true,
    });
    return true;
  },

  /** Ctrl+Alt+X: flyt markeringen (eller afsnittet ved markøren) til fraklip (ADR-0008). */
  park(view: EditorView): boolean {
    const { state } = view;
    const sel = state.selection.main;
    // Intet markeret: hele afsnittet ved markøren. Ellers markeringen med hele ord og hele noter,
    // og aldrig ind i de skjulte blokke (parkRange.ts).
    const span = sel.empty ? paragraphAt(state, sel.head) : expandParkRange(state, sel);
    if (!span) return false;
    const { from, to } = span;
    const text = state.sliceDoc(from, to).trim();
    if (!text) return false;
    view.dispatch({
      changes: parkChanges(state.doc.toString(), [text], { from, to }),
      selection: { anchor: from },
      userEvent: "delete.park",
    });
    window.dispatchEvent(new Event("gt-parked"));
    return true;
  },
};

/**
 * Tab rykker ind (2/10: før flyttede Tab fokus ud af teksten). I en liste eller over flere
 * linjer rykkes hele linjen ind, så punktet bliver et underpunkt; ellers et tabulatortegn ved
 * markøren som i Word og iA. Shift+Tab rykker ud. Esc og så Tab flytter stadig fokus videre.
 */
function tab(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  const list = /^\s*([-*+]|\d+[.)])\s/.test(line.text);
  const lines = state.doc.lineAt(sel.from).number !== state.doc.lineAt(sel.to).number;
  return list || lines ? indentMore(view) : insertTab(view);
}

/** Ctrl+S gemmer med det samme. Programmet gemmer selv, men vanen skal ikke straffes. */
function saveNow(): boolean {
  window.dispatchEvent(new Event("gt-save-now"));
  return true;
}

export function shortcuts(): Extension {
  return Prec.high(
    keymap.of([
      { key: "Mod-b", run: cmd.bold },
      { key: "Mod-i", run: cmd.italic },
      { key: "Mod-u", run: cmd.underline },
      { key: "Alt-Shift-5", run: cmd.strike },
      { key: "Mod-Shift-x", run: cmd.strike },
      { key: "Mod-Shift-d", run: cmd.dim },
      { key: "Mod-k", run: cmd.link },
      { key: "Mod-0", run: cmd.heading(0) },
      { key: "Mod-1", run: cmd.heading(1) },
      { key: "Mod-2", run: cmd.heading(2) },
      { key: "Mod-3", run: cmd.heading(3) },
      { key: "Mod-4", run: cmd.heading(4) },
      { key: "Mod-Shift-8", run: cmd.bullets },
  // Words egen genvej til punktliste.
  { key: "Mod-Shift-l", run: cmd.bullets },
      { key: "Mod-Shift-7", run: cmd.numbered },
      { key: "Mod-Shift-9", run: cmd.tasks },
      { key: "Mod-Shift-q", run: cmd.quote },
      { key: "Mod-Alt-f", run: cmd.footnote },
      { key: "Mod-Alt-x", run: cmd.park },
      { key: "Mod-Alt-i", run: pickImage },
      { key: "Mod-Alt-n", run: cmd.note },
      { key: "Mod-s", run: saveNow, preventDefault: true },
      { key: "Tab", run: tab, shift: indentLess, preventDefault: true },
    ]),
  );
}
