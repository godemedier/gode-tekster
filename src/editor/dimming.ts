// Dæmpet tekst {--…--} (ADR-0008) efter testrunden 2/10: »Skær« dæmper alle sine forslag på
// én gang uden at spørge, en dæmpning kan klikkes væk, og al dæmpet tekst kan flyttes til fraklip.
// Rene funktioner, der returnerer ændringer i dokumentets koordinater.

import { findDimmed } from "./inline.ts";
import { parkChanges } from "./parked.ts";

export type Change = { from: number; to?: number; insert: string };
export type Dimmed = { from: number; to: number; body: string };

/** Hvor teksten slutter, før de skjulte blokke sidst i filen (fraklip, Claude, fodnoter). */
function bodyEnd(doc: string): number {
  const m = /^(\[\^[^\]\s]+\]:|<!-- gt:)/m.exec(doc);
  return m ? m.index : doc.length;
}

/** Al dæmpet tekst i selve teksten, med markørerne. */
export function dimmedInBody(doc: string): Dimmed[] {
  const end = bodyEnd(doc);
  return findDimmed(doc)
    .filter((d) => d.close.to <= end)
    .map((d) => ({ from: d.open.from, to: d.close.to, body: doc.slice(d.body.from, d.body.to) }));
}

/**
 * »Skær«: hvert uddrag, Claude foreslår, dæmpes. Uddrag, der ikke findes ordret, overlapper et
 * andet eller allerede er dæmpet, springes over. Returnerer ændringerne og hvor mange ord.
 */
export function cutChanges(doc: string, cuts: { quote: string }[]): { changes: Change[]; count: number; words: number } {
  const end = bodyEnd(doc);
  const taken: { from: number; to: number }[] = dimmedInBody(doc);
  const placed: { from: number; to: number }[] = [];
  for (const c of cuts) {
    const q = c.quote;
    if (!q.trim()) continue;
    let at = doc.indexOf(q);
    const clash = (a: number) => [...taken, ...placed].some((s) => a < s.to && a + q.length > s.from);
    while (at !== -1 && at + q.length <= end && clash(at)) at = doc.indexOf(q, at + 1);
    if (at === -1 || at + q.length > end) continue;
    placed.push({ from: at, to: at + q.length });
  }
  placed.sort((a, b) => a.from - b.from);
  const changes = placed.flatMap((p) => [
    { from: p.from, insert: "{--" },
    { from: p.to, insert: "--}" },
  ]);
  const words = placed.reduce((n, p) => n + (doc.slice(p.from, p.to).match(/[\p{L}\p{N}]+/gu)?.length ?? 0), 0);
  return { changes, count: placed.length, words };
}

/** »Fjern dæmpning«: markørerne væk, teksten bliver. */
export function undimChanges(d: { from: number; to: number }): Change[] {
  return [
    { from: d.from, to: d.from + 3, insert: "" },
    { from: d.to - 3, to: d.to, insert: "" },
  ];
}

/**
 * Det, der skal fjernes sammen med et dæmpet stykke, så der ikke står to mellemrum eller en tom
 * linje for meget tilbage: et mellemrum foran (eller bagved, først i en linje), eller et helt afsnit
 * med dets tomme linje.
 */
function removalRange(doc: string, d: { from: number; to: number }): { from: number; to: number } {
  const lineStart = doc.lastIndexOf("\n", d.from - 1) + 1;
  const nl = doc.indexOf("\n", d.to);
  const lineEnd = nl === -1 ? doc.length : nl;
  if (doc.slice(lineStart, d.from).trim() === "" && doc.slice(d.to, lineEnd).trim() === "") {
    // Et helt afsnit: tag linjeskiftene efter med, så afsnittene ikke rykker sammen.
    let to = lineEnd;
    while (doc[to] === "\n" && to < doc.length && to - lineEnd < 2) to++;
    return { from: lineStart, to };
  }
  if (doc[d.from - 1] === " " && /[\s.,;:!?»«)]/.test(doc[d.to] ?? "")) return { from: d.from - 1, to: d.to };
  if (doc[d.to] === " ") return { from: d.from, to: d.to + 1 };
  return d;
}

/** »Til fraklip« for ét stykke eller »Flyt al dæmpet tekst hertil«: ud af teksten, ind i fraklip. */
export function parkDimmedChanges(doc: string, list: Dimmed[], date?: string): Change[] {
  if (!list.length) return [];
  const removals: Change[] = list.map((d) => ({ ...removalRange(doc, d), insert: "" }));
  const append = parkChanges(doc, list.map((d) => d.body), undefined, date);
  return [...removals, ...append];
}
