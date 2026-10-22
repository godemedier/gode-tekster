// Når man skriver hen over en markering, der begynder uden for fed (kursiv, gennemstreget) og slutter
// inde i den, må kun den ene halvdel af tegnparret ikke forsvinde. Så stod `**` alene tilbage, og når
// forslaget blev godtaget, kom stjernerne frem (gæstens side, 21/10). Mærket bliver stående, og det
// skrevne lander på den side, markeringen begyndte, som i Word.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

type Span = { from: number; to: number };
type Edit = Span & { insert: string };
type Mark = Span & { open: boolean };

const PAIRS: Record<string, string> = { Emphasis: "EmphasisMark", StrongEmphasis: "EmphasisMark", Strikethrough: "StrikethroughMark" };

/** Mærkerne inden for `from`–`to`, hvis makker står uden for. */
export function loneMarks(state: EditorState, from: number, to: number): Mark[] {
  const out: Mark[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      const name = PAIRS[node.name];
      if (!name) return;
      const marks = node.node.getChildren(name);
      if (marks.length < 2) return;
      const [open, close] = [marks[0], marks[marks.length - 1]];
      const inside = (m: Span) => m.from >= from && m.to <= to;
      if (inside(open) && !inside(close)) out.push({ from: open.from, to: open.to, open: true });
      if (inside(close) && !inside(open)) out.push({ from: close.from, to: close.to, open: false });
    },
  });
  return out.sort((a, b) => a.from - b.from);
}

/** Erstatningen `edit` delt op uden om de mærker, der ellers ville stå alene. `null`: intet at gøre. */
export function keepMarks(state: EditorState, edit: Edit): Edit[] | null {
  if (edit.to <= edit.from) return null;
  const keep = loneMarks(state, edit.from, edit.to);
  if (!keep.length) return null;
  const doc = state.doc;
  const space = (pos: number) => pos >= 0 && pos < doc.length && /\s/.test(doc.sliceString(pos, pos + 1));
  const out: Edit[] = [];
  const moved: Edit[] = [];
  let at = edit.from;
  for (const [i, k] of keep.entries()) {
    if (k.from < at) continue;
    const text = doc.sliceString(k.from, k.to);
    // Et åbnende mærke foran et mellemrum (`** e**`) eller et lukkende efter et (`**a **`) er ikke
    // formatering længere. Så flyttes mærket hen over mellemrummet.
    let to = edit.to;
    if (k.open && i === keep.length - 1 && space(edit.to)) {
      while (space(to)) to++;
      moved.push({ from: to, to, insert: text });
    } else if (!k.open && i === 0 && !edit.insert && space(edit.from - 1)) {
      let from = edit.from;
      while (space(from - 1)) from--;
      moved.push({ from, to: from, insert: text });
    } else {
      out.push({ from: at, to: k.from, insert: out.length ? "" : edit.insert });
      at = k.to;
      continue;
    }
    // Mærket slettes her og sættes ind på den anden side af mellemrummet.
    out.push({ from: at, to: k.to, insert: out.length ? "" : edit.insert });
    at = k.to;
  }
  out.push({ from: at, to: edit.to, insert: out.length ? "" : edit.insert });
  return [...out, ...moved].filter((e) => e.to > e.from || e.insert);
}
