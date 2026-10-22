// Enter og Backspace i lister og citater (fejljagt 19/10, F1-B8). lang-markdowns egne taster gjorde
// en tæt liste løs ved Enter på et tomt punkt, og man skulle trykke Enter tre gange for at komme ud.
// Som i Word: Enter på et tomt punkt afslutter listen (eller går et niveau op), og Enter på en tom
// citatlinje afslutter citatet. Bindes i stedet for `markdown()`s keymap, med samme prioritet.

import { Prec } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import { escapeDates, leaveListAfterEnter } from "./notLists.ts";

const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** Enter på en citatlinje uden tekst (»> «) lige under citatet: linjen tømmes, og citatet er slut. */
export function exitQuote(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to || !/^\s*>\s*$/.test(line.text) || line.number === 1) return false;
  if (!/^\s*>/.test(state.doc.line(line.number - 1).text)) return false;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: "" }, selection: { anchor: line.from }, userEvent: "input" });
  return true;
}

/** Enter fortsætter listen, men ikke efter »4. maj« eller en replik (notLists.ts). */
function enter(view: EditorView): boolean {
  if (exitQuote(view)) return true;
  const before = view.state;
  if (!continueMarkup(view)) return false;
  leaveListAfterEnter(view, before);
  return true;
}

export const markdownKeys = [
  Prec.high(
    keymap.of([
      { key: "Enter", run: enter },
      { key: "Backspace", run: deleteMarkupBackward },
    ]),
  ),
  escapeDates,
];
