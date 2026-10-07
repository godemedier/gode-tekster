// Rene redigeringsberegninger til tastaturgenvejene: (tekst, markering) ind, plan ud.
// Rører aldrig editoren, så de kan testes med node --test.
//
// Kopieret fra Gode Ord `src/lib/editing.ts` (4b7c78c, 4/8-2026) og udvidet med par af forskellige
// tegn (`<u>…</u>`, `{--…--}`), overskriftsniveau og fodnoter. Rettelser i de fælles funktioner
// skal også tilbage til Gode Ord (L-007).

import { hasNumber, nextHeadingNumber } from "./headingNumbers.ts";

export type EditPlan = {
  /** Interval i den nuværende tekst, der skal erstattes. */
  start: number;
  end: number;
  replacement: string;
  /** Markeringen efter erstatningen (absolutte positioner). */
  selStart: number;
  selEnd: number;
};

// \p{L}/\p{N} + /u: JS' \b tæller ikke æøå som ordtegn (L-066).
const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);

/** Udvid en tom markering til ordet omkring markøren (æøå-sikkert). */
export function wordRangeAt(text: string, pos: number): { start: number; end: number } {
  let start = pos;
  let end = pos;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  return { start, end };
}

/**
 * Slå et par tegn til eller fra om markeringen: `**` (fed), `*` (kursiv), `~~`, `<u>`/`</u>`,
 * `{--`/`--}`. En tom markering udvides til ordet. Står markøren i tomrum, indsættes et tomt par
 * med markøren i midten.
 */
export function toggleWrap(text: string, selStart: number, selEnd: number, open: string, close = open): EditPlan {
  let s = selStart;
  let e = selEnd;
  if (s === e) ({ start: s, end: e } = wordRangeAt(text, s));
  const inner = text.slice(s, e);
  // Markeringen indeholder selv tegnene.
  if (inner.length >= open.length + close.length && inner.startsWith(open) && inner.endsWith(close)) {
    const rep = inner.slice(open.length, inner.length - close.length);
    return { start: s, end: e, replacement: rep, selStart: s, selEnd: s + rep.length };
  }
  // Tegnene står lige uden om markeringen.
  if (s - open.length >= 0 && text.slice(s - open.length, s) === open && text.slice(e, e + close.length) === close) {
    return { start: s - open.length, end: e + close.length, replacement: inner, selStart: s - open.length, selEnd: s - open.length + inner.length };
  }
  // Mellemrum i kanten af markeringen bliver uden for tegnene. `~~tekst ~~` er ikke gennemstregning
  // i markdown, og en markering med dobbeltklik eller Shift+Ctrl+→ tager tit mellemrummet med (7/10).
  const lead = inner.length - inner.trimStart().length;
  const trail = inner.length - inner.trimEnd().length;
  if (lead + trail < inner.length) {
    s += lead;
    e -= trail;
  }
  const word = text.slice(s, e);
  const rep = open + word + close;
  return { start: s, end: e, replacement: rep, selStart: s + open.length, selEnd: s + open.length + word.length };
}

function lineSpan(text: string, selStart: number, selEnd: number): { ls: number; le: number } {
  const ls = text.lastIndexOf("\n", Math.max(0, selStart - 1)) + 1;
  let le = text.indexOf("\n", selEnd);
  if (le === -1) le = text.length;
  return { ls, le };
}

/** Lister og citater, der udelukker hinanden: et nyt præfiks erstatter et andet af dem. */
const BLOCK_PREFIX = /^(?:- \[[ xX]\] |[-*+] |\d+\. |> )/;

/**
 * Slå et linjepræfiks til eller fra på alle linjer i markeringen (`- `, `1. `, `- [ ] `, `> `).
 * Har alle ikke-tomme linjer det allerede, fjernes det. Ellers sættes det på og erstatter en
 * anden liste- eller citatform, så `- ` ikke bliver til `1. - `. Nummererede lister tælles op.
 */
export function toggleLinePrefix(text: string, selStart: number, selEnd: number, prefix: string): EditPlan {
  const { ls, le } = lineSpan(text, selStart, selEnd);
  const lines = text.slice(ls, le).split("\n");
  const numbered = prefix === "1. ";
  const has = (l: string) => (numbered ? /^\d+\. /.test(l) : l.startsWith(prefix));
  const allHave = lines.filter((l) => l.trim() !== "").every(has);
  let n = 0;
  const next = lines.map((l) => {
    if (l.trim() === "") return l;
    if (allHave) return l.replace(BLOCK_PREFIX, "");
    n += 1;
    return (numbered ? `${n}. ` : prefix) + l.replace(BLOCK_PREFIX, "");
  });
  const rep = next.join("\n");
  return { start: ls, end: le, replacement: rep, selStart: ls, selEnd: ls + rep.length };
}

/** Sæt overskriftsniveau 1-6 på linjerne, eller fjern det (niveau 0). Samme niveau igen fjerner det. */
export function setHeading(text: string, selStart: number, selEnd: number, level: number): EditPlan {
  const { ls, le } = lineSpan(text, selStart, selEnd);
  const lines = text.slice(ls, le).split("\n");
  const target = level > 0 ? "#".repeat(level) + " " : "";
  const allSame = level > 0 && lines.filter((l) => l.trim() !== "").every((l) => l.startsWith(target) && !l.startsWith(target.trim() + "#"));
  // Én linje til overskrift: fortsæt nummereringen fra overskriften over (headingNumbers.ts).
  const before = text.slice(0, ls).split("\n");
  const number = level > 0 && !allSame && lines.length === 1 ? nextHeadingNumber(before, before.length - 1, level) : null;
  const next = lines.map((l) => {
    if (l.trim() === "") return l;
    const bare = l.replace(/^#{1,6}\s+/, "");
    if (allSame) return bare;
    return target + (number && !hasNumber(bare) ? number : "") + bare;
  });
  const rep = next.join("\n");
  const caret = Math.min(ls + rep.length, Math.max(ls, selEnd + (rep.length - (le - ls))));
  return { start: ls, end: le, replacement: rep, selStart: caret, selEnd: caret };
}

/** Pak markeringen (eller ordet ved markøren) ind som link med markøren klar til adressen. */
export function wrapLink(text: string, selStart: number, selEnd: number): EditPlan {
  let s = selStart;
  let e = selEnd;
  if (s === e) ({ start: s, end: e } = wordRangeAt(text, s));
  const inner = text.slice(s, e);
  const rep = `[${inner}]()`;
  const caret = s + rep.length - 1;
  return { start: s, end: e, replacement: rep, selStart: caret, selEnd: caret };
}

/**
 * Ny fodnote (ADR-0017): næste ledige nummer ved markøren og en definition sidst i teksten, før
 * parkeret tekst. Eksisterende etiketter omnummereres aldrig. Returnerer to ændringer og hvor
 * markøren skal stå (i definitionen, klar til at skrive).
 */
export function insertFootnote(
  text: string,
  pos: number,
  body = "",
): { changes: { from: number; insert: string }[]; label: string; cursor: number } {
  let max = 0;
  for (const m of text.matchAll(/\[\^(\d+)\]/g)) max = Math.max(max, Number(m[1]));
  const label = `[^${max + 1}]`;
  const parked = text.search(/^<!-- gt:parkeret/m);
  const end = parked === -1 ? text.length : parked;
  const before = text.slice(0, end);
  const lead = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const tail = parked === -1 ? "" : "\n\n";
  const definition = `${lead}${label}: ${body}${tail}`;
  const cursor = end + label.length + lead.length + 2 + label.length;
  return { changes: [{ from: pos, insert: label }, { from: end, insert: definition }], label: label.slice(2, -1), cursor };
}
