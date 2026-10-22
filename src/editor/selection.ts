// En markering med musen, der ender i starten af en linje, stopper ved slutningen af linjen før
// (4/10). Trippelklik markerer i CodeMirror linjen MED linjeskiftet, og det samme sker, når man
// trækker lidt for langt: markeringen tog et stykke af næste linje med, både på skærmen og ved
// kopiering. Gælder kun markeringer med musen; tastaturet markerer, som man beder det om.
//
// En hel linje markeret med musen (trippelklik) tager heller ikke linjens præfiks (`## `, `- `) eller
// et par om hele teksten (`**…**`) med: det, man skriver, bliver stående som overskrift, punkt eller
// fed, som i Word (fejljagt F1-B10).

import { EditorSelection, EditorState } from "@codemirror/state";

import { LINE_PREFIX } from "./editing.ts";

/** Den rettede markering, eller null, når intet skal rettes. Ren funktion til testene. */
export function trimmed(state: EditorState, anchor: number, head: number): { anchor: number; head: number } | null {
  if (anchor >= head) return null;
  let a = anchor;
  let h = head;
  const line = state.doc.lineAt(h);
  // Slutter i kolonne 0, og markeringen begynder på en tidligere linje: tag linjeskiftet fra.
  if (h === line.from && line.number !== 1 && a < line.from && line.from - 1 > a) h = line.from - 1;
  const whole = state.doc.lineAt(a);
  if (a === whole.from && h === whole.to) {
    const text = whole.text;
    const prefix = LINE_PREFIX.exec(text)?.[0].length ?? 0;
    const rest = text.slice(prefix);
    const pair = /^(\*\*\*|\*\*|\*|__|_|~~)(?=\S)[\s\S]*\S\1$/.exec(rest)?.[1].length ?? 0;
    a = whole.from + prefix + pair;
    h = whole.to - pair;
  }
  return a === anchor && h === head ? null : { anchor: a, head: h };
}

export const trimLineBreakSelection = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || !tr.isUserEvent("select.pointer")) return tr;
  const m = tr.selection.main;
  const fix = trimmed(tr.state, m.anchor, m.head);
  if (!fix) return tr;
  return [tr, { selection: EditorSelection.single(fix.anchor, fix.head), sequential: true }];
});
