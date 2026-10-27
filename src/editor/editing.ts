// Rene redigeringsberegninger til tastaturgenvejene: (tekst, markering) ind, plan ud.
// Rører aldrig editoren, så de kan testes med node --test.
// Par af forskellige tegn (`<u>…</u>`, `{--…--}`), overskriftsniveau og fodnoter er med.

import { hasNumber, nextHeadingNumber } from "./headingNumbers.ts";
import { findTagLine } from "./textStatus.ts";

export type EditPlan = {
  /** Interval i den nuværende tekst, der skal erstattes. */
  start: number;
  end: number;
  replacement: string;
  /** Markeringen efter erstatningen (absolutte positioner). */
  selStart: number;
  selEnd: number;
};

// \p{L}/\p{N} + /u: JS' \b tæller ikke æøå som ordtegn.
const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);

/** Bindestreg og apostrof inde i et ord hører til ordet: »e-mail« og »rock'n'roll« er ét ord til Ctrl+B. */
const joinsWord = (text: string, i: number) => /['’-]/.test(text[i] ?? "") && isWordChar(text[i - 1] ?? "") && isWordChar(text[i + 1] ?? "");

/** Udvid en tom markering til ordet omkring markøren (æøå-sikkert). */
export function wordRangeAt(text: string, pos: number): { start: number; end: number } {
  let start = pos;
  let end = pos;
  while (start > 0 && (isWordChar(text[start - 1]) || joinsWord(text, start - 1))) start--;
  while (end < text.length && (isWordChar(text[end]) || joinsWord(text, end))) end++;
  return { start, end };
}

/**
 * Slå et par tegn til eller fra om markeringen: `**` (fed), `*` (kursiv), `~~`, `<u>`/`</u>`,
 * `{--`/`--}`. En tom markering udvides til ordet. Står markøren i tomrum, indsættes et tomt par
 * med markøren i midten.
 */
export function toggleWrap(text: string, selStart: number, selEnd: number, open: string, close = open): EditPlan {
  // Flere linjer, eller en markering der starter i listetegnet: linje for linje (14/10). Ét par om
  // det hele gav `*- a\n- b*`, så første punkt ikke længere var et listepunkt.
  if (selStart !== selEnd) {
    const ls = selStart === 0 ? 0 : text.lastIndexOf("\n", selStart - 1) + 1;
    const prefix = LINE_PREFIX.exec(text.slice(ls, text.indexOf("\n", ls) === -1 ? text.length : text.indexOf("\n", ls)))![0].length;
    if (text.slice(selStart, selEnd).replace(/\n$/, "").includes("\n") || selStart < ls + prefix) {
      return toggleWrapLines(text, selStart, selEnd, open, close);
    }
  }
  let s = selStart;
  let e = selEnd;
  if (s === e) {
    ({ start: s, end: e } = wordRangeAt(text, s));
    // Lige efter eller før et ord med tegn om (»**ord**¦«): samme tegn gør intet, så det næste, der
    // skrives, står uden for. Før kom et nyt tomt par op ad det gamle: `**ord****` (F1-B5).
    if (s === e) {
      const edge = markedWordAt(text, s, open, close);
      if (edge === "same") return { start: s, end: s, replacement: "", selStart: s, selEnd: s };
      if (edge) ({ start: s, end: e } = edge);
    }
  }
  const inner = text.slice(s, e);
  // Markeringen indeholder selv tegnene. For `*` skal løbet være ulige: `**ord**` er fed, ikke kursiv.
  if (inner.length >= open.length + close.length && inner.startsWith(open) && inner.endsWith(close) && runFits(inner, 0, open, true) && runFits(inner, inner.length, close, false)) {
    const rep = inner.slice(open.length, inner.length - close.length);
    return { start: s, end: e, replacement: rep, selStart: s, selEnd: s + rep.length };
  }
  // Tegnene står lige uden om markeringen. Ctrl+I på et fedt ord gav kursiv i stedet for fed og kursiv (F1-B4).
  if (s - open.length >= 0 && text.slice(s - open.length, s) === open && text.slice(e, e + close.length) === close && runFits(text, s, open, false) && runFits(text, e, close, true)) {
    return { start: s - open.length, end: e + close.length, replacement: inner, selStart: s - open.length, selEnd: s - open.length + inner.length };
  }
  // Markeringen skærer et par over (»**fe⟦dt** o⟧rd«): parret udvides til hele markeringen (F1-B5).
  const across = acrossPair(text, s, e, open, close);
  if (across) return across;
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

/** Antal ens tegn i træk fra `pos`, bagud eller fremad. */
function runLength(text: string, pos: number, ch: string, forward: boolean): number {
  let n = 0;
  if (forward) while (text[pos + n] === ch) n++;
  else while (pos - n - 1 >= 0 && text[pos - n - 1] === ch) n++;
  return n;
}

/**
 * Passer tegnløbet ved `pos` til tegnene? `*` (kursiv) kun i et løb på 1 eller 3, `**` i et løb på 2
 * eller 3. Tegn, der ikke er gentagelser af ét tegn (`<u>`), passer altid.
 */
function runFits(text: string, pos: number, mark: string, forward: boolean): boolean {
  const ch = mark[0];
  if (![...mark].every((c) => c === ch)) return true;
  const n = runLength(text, pos, ch, forward);
  return mark.length === 1 ? n % 2 === 1 : n >= mark.length && n <= mark.length + 1;
}

/**
 * Markøren lige efter eller før et ord med tegn om. »same«: tegnene er de samme, og der skal intet
 * ske. Ellers ordet (uden tegn), så de nye tegn lægges om det: Ctrl+I efter `**ord**` giver `***ord***`.
 */
function markedWordAt(text: string, pos: number, open: string, close: string): { start: number; end: number } | "same" | null {
  const ch = close[0];
  if (![...open, ...close].every((c) => c === ch)) return null;
  const after = runLength(text, pos, ch, false);
  if (after > 0 && pos - after > 0 && isWordChar(text[pos - after - 1])) {
    if (runFits(text, pos, close, false)) return "same";
    return wordRangeAt(text, pos - after - 1);
  }
  const before = runLength(text, pos, ch, true);
  if (before > 0 && pos + before < text.length && isWordChar(text[pos + before])) {
    if (runFits(text, pos, open, true)) return "same";
    return wordRangeAt(text, pos + before + 1);
  }
  return null;
}

/**
 * En markering med præcis ét af tegnene indeni, hvor parret begynder før den eller slutter efter
 * den: tegnet inde i markeringen flyttes ud til dens kant, så det hele kommer med i parret.
 */
function acrossPair(text: string, s: number, e: number, open: string, close: string): EditPlan | null {
  if (open !== close || open.length < 2) return null;
  const inner = text.slice(s, e);
  const at = inner.indexOf(open);
  if (at < 0 || inner.indexOf(open, at + open.length) >= 0) return null;
  const before = text.slice(0, s).split(open).length - 1;
  const rest = inner.slice(0, at) + inner.slice(at + open.length);
  // Ulige antal før markeringen: tegnet indeni lukker et par, der er åbnet før. Ellers åbner det et.
  const replacement = before % 2 === 1 ? rest + close : open + rest;
  const selStart = before % 2 === 1 ? s : s + open.length;
  return { start: s, end: e, replacement, selStart, selEnd: selStart + rest.length };
}

/** Det, tegnene skal stå efter på en linje: indrykning, overskrift, citat, listetegn og afkrydsning. */
export const LINE_PREFIX = /^[ \t]*(?:(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)*/;

/**
 * `toggleWrap` over flere linjer: hver linjes markerede del får sit eget par efter linjens præfiks.
 * Tomme linjer springes over. Har alle dele tegnene i forvejen, fjernes de. Ellers får de dele, der
 * mangler dem, tegnene.
 */
function toggleWrapLines(text: string, selStart: number, selEnd: number, open: string, close: string): EditPlan {
  // En markering, der slutter i starten af en linje (tredobbeltklik), tager ikke den linje med.
  const end = selEnd > selStart && text[selEnd - 1] === "\n" ? selEnd - 1 : selEnd;
  const { ls, le } = lineSpan(text, selStart, end);
  // a og b er den markerede del i linjen (-1: intet markeret). wrapped: tegnene står inden for
  // delen, lige uden om den, eller ikke.
  type Part = { line: string; a: number; b: number; wrapped: "inde" | "ude" | null };
  const parts: Part[] = [];
  let off = ls;
  for (const line of text.slice(ls, le).split("\n")) {
    const cs = LINE_PREFIX.exec(line)![0].length;
    let a = Math.max(cs, selStart - off);
    let b = Math.min(line.length, end - off);
    const seg = a < b ? line.slice(a, b) : "";
    if (seg.trim() === "") {
      parts.push({ line, a: -1, b: -1, wrapped: null });
    } else {
      a += seg.length - seg.trimStart().length;
      b -= seg.length - seg.trimEnd().length;
      const inner = line.slice(a, b);
      const wrapped =
        inner.length >= open.length + close.length && inner.startsWith(open) && inner.endsWith(close)
          ? "inde"
          : line.slice(a - open.length, a) === open && a - open.length >= cs && line.slice(b, b + close.length) === close
            ? "ude"
            : null;
      parts.push({ line, a, b, wrapped });
    }
    off += line.length + 1;
  }
  const marked = parts.filter((p) => p.a >= 0);
  const remove = marked.length > 0 && marked.every((p) => p.wrapped !== null);
  const rep = parts
    .map((p) => {
      if (p.a < 0) return p.line;
      const inner = p.line.slice(p.a, p.b);
      if (remove && p.wrapped === "inde") return p.line.slice(0, p.a) + inner.slice(open.length, inner.length - close.length) + p.line.slice(p.b);
      if (remove) return p.line.slice(0, p.a - open.length) + inner + p.line.slice(p.b + close.length);
      if (p.wrapped) return p.line;
      return p.line.slice(0, p.a) + open + inner + close + p.line.slice(p.b);
    })
    .join("\n");
  return { start: ls, end: le, replacement: rep, selStart: ls, selEnd: ls + rep.length };
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
  const end = Math.min(parked === -1 ? text.length : parked, findTagLine(text)?.from ?? text.length);
  const before = text.slice(0, end);
  const lead = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const tail = end === text.length ? "" : "\n\n";
  const definition = `${lead}${label}: ${body}${tail}`;
  const cursor = end + label.length + lead.length + 2 + label.length;
  return { changes: [{ from: pos, insert: label }, { from: end, insert: definition }], label: label.slice(2, -1), cursor };
}
