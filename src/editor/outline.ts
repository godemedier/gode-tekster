// Disposition og omstrukturering (research 2/10: SilverBullet, ghostwriter, Typora, novelWriter):
// Alt+↑/↓ flytter afsnittet ved markøren forbi naboafsnittet. Står markøren i en overskrift, flyttes
// hele sektionen (overskriften og alt under den til næste overskrift på samme eller højere niveau)
// forbi søskendesektionen. Skjulte blokke sidst i teksten (fraklip, noter, Claude) flyttes aldrig.
// Alt+Shift+← og → folder og folder ud under en overskrift (markdown-sprogets egen foldning).

import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { codeFolding, foldCode, unfoldCode } from "@codemirror/language";

import { tr } from "../i18n.ts";
import { codeSpans, commentSpans, maskSpans } from "./textSyntax.ts";

export type Heading = { level: number; text: string; from: number };
type Unit = { from: number; to: number };

export function headings(doc: string): Heading[] {
  const out: Heading[] = [];
  let pos = 0;
  for (const line of maskSpans(doc, [...codeSpans(doc).filter((s) => doc.slice(s.from, s.to).includes("\n")), ...commentSpans(doc)]).split("\n")) {
    const m = /^(#{1,6})\s+(\S.*)$/.exec(line);
    if (m) {
      const text = m[2].trimEnd().replace(/#+$/, "").trimEnd();
      if (text) out.push({ level: m[1].length, text, from: pos });
    }
    pos += line.length + 1;
  }
  return out;
}

/** Overskrifterne i selve teksten, uden dem i fraklip og andre skjulte blokke sidst i filen. */
export function bodyHeadings(doc: string): Heading[] {
  const end = bodyEnd(doc);
  return headings(doc).filter((h) => h.from < end);
}

/** Hvor teksten slutter, før de skjulte blokke (fodnotedefinitioner, fraklip, Claude). */
function bodyEnd(doc: string): number {
  const m = /^(\[\^[^\]\s]+\]:|<!-- gt:(?:parkeret|claude|maal|farve)\b)/m.exec(doc);
  return m ? m.index : doc.length;
}

/** Afsnit: sammenhængende ikke-tomme linjer. Til `end`, så skjulte blokke ikke kommer med. */
function paragraphs(doc: string, end: number): Unit[] {
  const out: Unit[] = [];
  const re = /[^\n]+(?:\n[^\n]+)*/g;
  for (const m of doc.slice(0, end).matchAll(re)) {
    if (m[0].trim()) out.push({ from: m.index ?? 0, to: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** Sektionerne på samme niveau og under samme forælder som overskriften ved `at`. */
function siblings(doc: string, at: Heading, end: number): Unit[] {
  const hs = headings(doc).filter((h) => h.from < end);
  const i = hs.findIndex((h) => h.from === at.from);
  // Forælderens grænser: fra forrige højere overskrift til næste højere.
  const parent = hs.slice(0, i).reverse().find((h) => h.level < at.level);
  const nextParent = hs.slice(i + 1).find((h) => h.level < at.level);
  const start = parent ? parent.from : 0;
  const stop = nextParent ? nextParent.from : end;
  const same = hs.filter((h) => h.level === at.level && h.from >= start && h.from < stop);
  return same.map((h) => {
    const next = hs.find((x) => x.from > h.from && x.level <= at.level && x.from < stop);
    const to = next ? next.from : stop;
    // Uden de tomme linjer i slutningen; de står mellem sektionerne.
    return { from: h.from, to: h.from + doc.slice(h.from, to).trimEnd().length };
  });
}

/** Ændringen, der flytter enheden ved `pos` én plads op eller ned. Null, hvis det ikke kan lade sig gøre. */
export function movePlan(doc: string, pos: number, dir: -1 | 1): { from: number; to: number; insert: string; cursor: number } | null {
  const end = bodyEnd(doc);
  if (pos > end) return null;
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  const heading = headings(doc).find((h) => h.from === lineStart && h.from < end);
  const units = heading ? siblings(doc, heading, end) : paragraphs(doc, end);
  const i = units.findIndex((u) => pos >= u.from && pos <= u.to);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= units.length) return null;
  const [a, b] = dir === -1 ? [units[j], units[i]] : [units[i], units[j]];
  const between = doc.slice(a.to, b.from);
  const insert = doc.slice(b.from, b.to) + between + doc.slice(a.from, a.to);
  // Markøren følger med sin enhed.
  const offset = pos - units[i].from;
  const cursor = dir === -1 ? a.from + offset : a.from + (b.to - b.from) + between.length + offset;
  return { from: a.from, to: b.to, insert, cursor };
}

/** Sektionen under overskriften ved `from`: til næste overskrift på samme eller højere niveau. */
export function sectionAt(doc: string, from: number): Unit | null {
  const end = bodyEnd(doc);
  const hs = headings(doc).filter((h) => h.from < end);
  const h = hs.find((x) => x.from === from);
  if (!h) return null;
  const next = hs.find((x) => x.from > h.from && x.level <= h.level);
  return { from: h.from, to: next ? next.from : end };
}

/**
 * Dispositionen i venstre spalte: træk sektionen ved `src` hen foran overskriften ved `dest`, eller
 * efter dens sektion. Én ændring, der dækker begge steder, så Ctrl+Z fortryder det hele. Null, hvis
 * flytningen ikke ændrer noget eller sektionen slippes inde i sig selv.
 */
export function relocatePlan(doc: string, src: number, dest: number, place: "before" | "after"): { from: number; to: number; insert: string; cursor: number } | null {
  const s = sectionAt(doc, src);
  const d = sectionAt(doc, dest);
  if (!s || !d) return null;
  const at = place === "before" ? d.from : d.to;
  if (at >= s.from && at <= s.to) return null;
  const lo = Math.min(s.from, at);
  const hi = Math.max(s.to, at);
  const region = doc.slice(lo, hi);
  // Mellemrummet før det, der følger efter regionen, bevares, ellers to tomme linjer mellem delene.
  const tail = /\s*$/.exec(region)?.[0] || "\n\n";
  const section = doc.slice(s.from, s.to).trimEnd();
  const middle = (at < s.from ? doc.slice(at, s.from) : doc.slice(s.to, at)).trimEnd();
  const insert = (at < s.from ? `${section}\n\n${middle}` : `${middle}\n\n${section}`) + tail;
  const cursor = at < s.from ? lo : lo + middle.length + 2;
  return { from: lo, to: hi, insert, cursor };
}

function move(dir: -1 | 1) {
  return (view: EditorView): boolean => {
    const plan = movePlan(view.state.doc.toString(), view.state.selection.main.head, dir);
    if (!plan) return false;
    view.dispatch({
      changes: { from: plan.from, to: plan.to, insert: plan.insert },
      selection: { anchor: plan.cursor },
      userEvent: "move.section",
      scrollIntoView: true,
    });
    return true;
  };
}

/** En foldet sektion vises som en lille dæmpet prik-række. */
function placeholder(_view: EditorView, onclick: (e: Event) => void): HTMLElement {
  const s = document.createElement("span");
  s.className = "gt-fold";
  s.textContent = " · · ·";
  s.title = tr("Foldet. Klik eller Alt+Shift+→ for at folde ud", "Folded. Click or press Alt+Shift+→ to unfold");
  s.addEventListener("click", onclick);
  return s;
}

export const outline = [
  codeFolding({ placeholderDOM: placeholder }),
  Prec.high(
    keymap.of([
      { key: "Alt-ArrowUp", run: move(-1) },
      { key: "Alt-ArrowDown", run: move(1) },
      { key: "Alt-Shift-ArrowLeft", run: foldCode },
      { key: "Alt-Shift-ArrowRight", run: unfoldCode },
    ]),
  ),
  EditorView.theme({ ".gt-fold": { color: "var(--svag)", cursor: "pointer", fontFamily: "var(--ui)" } }),
];
