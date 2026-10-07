// En markering med musen, der ender i starten af en linje, stopper ved slutningen af linjen før
// (4/10). Trippelklik markerer i CodeMirror linjen MED linjeskiftet, og det samme sker, når man
// trækker lidt for langt: markeringen tog et stykke af næste linje med, både på skærmen og ved
// kopiering. Gælder kun markeringer med musen; tastaturet markerer, som man beder det om.

import { EditorSelection, EditorState } from "@codemirror/state";

/** Den rettede markering, eller null, når intet skal rettes. Ren funktion til testene. */
export function trimmed(state: EditorState, anchor: number, head: number): { anchor: number; head: number } | null {
  if (anchor === head) return null;
  const end = Math.max(anchor, head);
  const start = Math.min(anchor, head);
  const line = state.doc.lineAt(end);
  // Slutter i kolonne 0, og markeringen begynder på en tidligere linje: tag linjeskiftet fra.
  if (end !== line.from || line.number === 1 || start >= line.from) return null;
  const prevEnd = line.from - 1;
  if (prevEnd <= start) return null;
  return anchor > head ? { anchor: prevEnd, head } : { anchor, head: prevEnd };
}

export const trimLineBreakSelection = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || !tr.isUserEvent("select.pointer")) return tr;
  const m = tr.selection.main;
  const fix = trimmed(tr.state, m.anchor, m.head);
  if (!fix) return tr;
  return [tr, { selection: EditorSelection.single(fix.anchor, fix.head), sequential: true }];
});
