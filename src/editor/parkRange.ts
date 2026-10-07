// Hvad der kommer med, når tekst flyttes til fraklip (5/10). Mærkerne for noter, dæmpning
// og formatering er skjult på skrivefladen, så en markering med musen endte tit lige før et usynligt
// »-->«. Så fik fraklippet en halv note, og teksten beholdt resten. Her udvides området til hele ord
// og hele konstruktioner, og et afsnit stopper altid før de skjulte blokke (hidden.ts).

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import { protectedRanges } from "./hidden.ts";

export type Span = { from: number; to: number };

/** Konstruktioner, der skal med hele: noter, dæmpning, rettelser, fodnotehenvisninger. */
const CONSTRUCTS = [
  /<!--(?!\s*gt:)[\s\S]*?-->/g,
  /\{>>[\s\S]*?<<\}/g,
  /\{--[\s\S]*?--\}/g,
  /\{\+\+[\s\S]*?\+\+\}/g,
  /\{~~[\s\S]*?~~\}/g,
  /\[\^[^\]\s]+\]/g,
];
/** Markdowns egne, fra syntakstræet. */
const WHOLE = new Set(["Emphasis", "StrongEmphasis", "Strikethrough", "InlineCode", "Link", "Image", "Autolink"]);
const WORD = /[\p{L}\p{N}'’-]/u;

/** Hvor langt en konstruktion højst kan række ud over markeringen, når der ledes. */
const REACH = 4000;

/** Området udvidet til hele ord og hele konstruktioner. Rører aldrig en skjult blok. */
export function expandParkRange(state: EditorState, span: Span): Span {
  const { doc } = state;
  let { from, to } = span;
  const ch = (pos: number) => doc.sliceString(pos, pos + 1);
  while (from > 0 && WORD.test(ch(from - 1)) && WORD.test(ch(from))) from--;
  while (to < doc.length && WORD.test(ch(to - 1)) && WORD.test(ch(to))) to++;
  for (let round = 0; round < 5; round++) {
    let changed = false;
    const a = Math.max(0, from - REACH);
    const text = doc.sliceString(a, Math.min(doc.length, to + REACH));
    for (const re of CONSTRUCTS) {
      for (const m of text.matchAll(re)) {
        const s = a + (m.index ?? 0);
        const e = s + m[0].length;
        if (s < from && e > from) [from, changed] = [s, true];
        if (s < to && e > to) [to, changed] = [e, true];
      }
    }
    syntaxTree(state).iterate({
      from,
      to,
      enter: (n) => {
        if (!WHOLE.has(n.name)) return;
        if (n.from < from && n.to > from) [from, changed] = [n.from, true];
        if (n.from < to && n.to > to) [to, changed] = [n.to, true];
      },
    });
    if (!changed) break;
  }
  return clampToText(state, { from, to });
}

/** Afsnittet ved `pos`: linjerne mellem to tomme linjer, og aldrig ind i en skjult blok. */
export function paragraphAt(state: EditorState, pos: number): Span | null {
  const { doc } = state;
  const blank = (n: number) => doc.line(n).text.trim() === "";
  let first = doc.lineAt(pos).number;
  if (blank(first)) return null;
  let last = first;
  while (first > 1 && !blank(first - 1)) first--;
  while (last < doc.lines && !blank(last + 1)) last++;
  const span = clampToText(state, { from: doc.line(first).from, to: doc.line(last).to }, pos);
  return span.to > span.from && doc.sliceString(span.from, span.to).trim() ? span : null;
}

/** Skær området til, så det ikke går ind i en skjult blok (fraklip, Input, fodnotedefinitioner). */
function clampToText(state: EditorState, span: Span, around = span.from): Span {
  let { from, to } = span;
  const r = protectedRanges(state);
  for (let i = 0; i < r.length; i += 2) {
    const [a, b] = [r[i], r[i + 1]];
    if (b <= around && b > from) from = b;
    if (a >= around && a < to) to = a;
  }
  // Uden linjeskiftet foran blokken (det hører til blokken) og uden tomme linjer i kanterne.
  while (to > from && /\s/.test(state.doc.sliceString(to - 1, to))) to--;
  while (from < to && /\n/.test(state.doc.sliceString(from, from + 1))) from++;
  return { from, to };
}
