// »4. maj kom befrielsen.« og replikken »- Hej, sagde hun.« er lister i markdown, og Enter gav
// »5. «/»- « i næste afsnit (fejljagt 19/10, F1-B15 og F2-B8). Det blev besluttet 21/10, at de holdes
// ude af lister. Datoen får en markdown-escape (»4\. maj«, skjult i visningen), som alle andre
// markdownprogrammer også forstår. Replikken får tankestreg (»– Hej«), som er dansk replikstreg.

import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const MONTHS = "januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december";
/** En linje, der begynder med en dato (»4. maj«). Gruppe 1 er alt før punktummet. */
const DATE_LINE = new RegExp(`^((?:\\s*>)*\\s*\\d{1,2})\\. (?:${MONTHS})(?![\\p{L}\\d])`, "u");

const SPEECH = /[,?!…] (?:sagde|siger|spurgte|spørger|svarede|svarer|råbte|råber|hviskede|hvisker|mumlede|mumler|tilføjede|tilføjer|forklarede|forklarer|fortalte|fortæller|lød det)(?![\p{L}])/u;

/** Positionen, hvor en dato-linje skal have sin escape, eller null. */
export function dateEscapeAt(line: string): number | null {
  const m = DATE_LINE.exec(line);
  return m ? m[1].length : null;
}

/**
 * Er linjen en replik skrevet med bindestreg? Den begynder med »- « og stort bogstav eller
 * anførselstegn, og enten har den et »sagde hun« eller lignende, eller replikken før den har tankestreg.
 * `prev` er den nærmeste linje før, der ikke er tom.
 */
export function isReplik(line: string, prev: string | undefined): boolean {
  if (!/^- [»"“'‹\p{Lu}]/u.test(line)) return false;
  return SPEECH.test(line) || (prev !== undefined && /^– \S/.test(prev));
}

/** Replikker med bindestreg får tankestreg, til eksporten. */
export function replikDashes(text: string): string {
  let prev: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const out = isReplik(line, prev) ? `–${line.slice(1)}` : line;
      if (line.trim() !== "") prev = out;
      return out;
    })
    .join("\n");
}

function prevText(state: EditorState, lineNo: number): string | undefined {
  for (let i = lineNo - 1; i >= 1; i--) {
    const t = state.doc.line(i).text;
    if (t.trim() !== "") return t;
  }
  return undefined;
}

const isListMark = (state: EditorState, pos: number) => syntaxTree(state).resolveInner(pos, 1).name === "ListMark";

/**
 * Efter Enter på en dato- eller replik-linje, der var en liste: punktet i den nye linje fjernes, og
 * linjen før holdes ude af listen. Som sit eget trin efter Enter, så Ctrl+Z giver listen tilbage.
 * `before` er tilstanden før Enter.
 */
export function leaveListAfterEnter(view: EditorView, before: EditorState): void {
  const old = before.doc.lineAt(before.selection.main.head);
  if (before.selection.main.head !== old.to) return;
  const escape = dateEscapeAt(old.text);
  const replik = escape === null && isReplik(old.text, prevText(before, old.number));
  if ((escape === null || !isListMark(before, old.from + escape - 1)) && !(replik && isListMark(before, old.from))) return;

  const { state } = view;
  const head = state.selection.main.head;
  const cur = state.doc.lineAt(head);
  const marker = /^\s*(?:\d{1,2}\.|-) $/.exec(state.sliceDoc(cur.from, head));
  if (!marker || cur.number !== old.number + 1) return;
  const at = state.doc.line(old.number).from;
  view.dispatch({
    changes: [escape !== null ? { from: at + escape, insert: "\\" } : { from: at, to: at + 1, insert: "–" }, { from: cur.from, to: head }],
    userEvent: "input.notlist",
    annotations: isolateHistory.of("full"),
  });
}

/**
 * Mens man skriver: når »4. maj« er skrevet færdigt (et mellemrum eller tegn efter måneden), får
 * datoen sin escape. Ctrl+Z giver listen tilbage.
 */
export const escapeDates = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.composing || !/^[^\p{L}\d\\]$/u.test(text)) return false;
  const line = view.state.doc.lineAt(from);
  const escape = dateEscapeAt(view.state.sliceDoc(line.from, from) + text);
  if (escape === null || !isListMark(view.state, line.from + escape - 1)) return false;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" });
  view.dispatch({ changes: { from: line.from + escape, insert: "\\" }, userEvent: "input.notlist", annotations: isolateHistory.of("full") });
  return true;
});
