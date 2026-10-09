// Længdemål for en tekst (7/10, STRATEGI: »Mål kan være et loft«): højst, mindst eller cirka et
// antal anslag, ord eller normalsider, eventuelt med en frist. Målet følger teksten og står som én
// skjult linje i filen, som fraklip og Claudes resultater (ADR-0003):
//
//   <!-- gt:maal type=hoejst antal=7400 enhed=anslag frist=2026-10-10 -->
//
// Den vises ikke i editoren (hidden.ts), tæller ikke med (parked.ts withoutParked) og ses ikke i
// iA Writer, der skjuler HTML-kommentarer.

import type { Count } from "./count.ts";

export type GoalKind = "hoejst" | "mindst" | "cirka";
export type GoalUnit = "anslag" | "ord" | "sider";
export type Goal = { kind: GoalKind; n: number; unit: GoalUnit; deadline: string | null };

export const GOAL_LINE = /<!-- gt:maal ([^\n]*?)-->\n?/g;

/** Målet i teksten, eller null. Står der flere, gælder det sidste. */
export function findGoal(doc: string): (Goal & { from: number; to: number }) | null {
  let found: (Goal & { from: number; to: number }) | null = null;
  for (const m of doc.matchAll(GOAL_LINE)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)=(\S+)/g)].map((a) => [a[1], a[2]]));
    const kind = attrs.type as GoalKind;
    const unit = attrs.enhed as GoalUnit;
    const n = Number(attrs.antal);
    if (!["hoejst", "mindst", "cirka"].includes(kind) || !["anslag", "ord", "sider"].includes(unit) || !(n > 0)) continue;
    // ÅÅÅÅ-MM-DD, eventuelt med klokkeslæt: ÅÅÅÅ-MM-DDTHH:MM (9/10).
    const deadline = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(attrs.frist ?? "") ? attrs.frist : null;
    const from = m.index ?? 0;
    found = { kind, n, unit, deadline, from, to: from + m[0].length };
  }
  return found;
}

export function goalLine(g: Goal): string {
  return `<!-- gt:maal type=${g.kind} antal=${g.n} enhed=${g.unit}${g.deadline ? ` frist=${g.deadline}` : ""} -->\n`;
}

/** Ændringen, der sætter, skifter eller fjerner målet. Et nyt mål lægges sidst i teksten. */
export function goalChange(doc: string, g: Goal | null): { from: number; to: number; insert: string } {
  const old = findGoal(doc);
  const insert = g ? goalLine(g) : "";
  if (old) return { from: old.from, to: old.to, insert };
  const sep = doc.length === 0 || doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
  return { from: doc.length, to: doc.length, insert: g ? sep + insert : "" };
}

export type GoalState = "under" | "naer" | "ok" | "over";

/**
 * Hvor langt teksten er fra målet. Højst: over loftet er »over«, de sidste 5 procent før er »naer«.
 * Mindst: nået er »ok«. Cirka: inden for 10 procent er »ok«.
 */
export function progress(c: Count, g: Goal): { value: number; ratio: number; state: GoalState } {
  const value = g.unit === "anslag" ? c.chars : g.unit === "ord" ? c.words : c.pages;
  const ratio = value / g.n;
  let state: GoalState;
  if (g.kind === "hoejst") state = ratio > 1 ? "over" : ratio >= 0.95 ? "naer" : "ok";
  else if (g.kind === "mindst") state = ratio >= 1 ? "ok" : "under";
  else state = ratio < 0.9 ? "under" : ratio > 1.1 ? "over" : "ok";
  return { value, ratio, state };
}

/** Hele dage til fristen fra i dag (lokal tid). Negativ, når fristen er overskredet. */
/** Klokkeslættet i fristen som »14.00«, eller null, når fristen kun er en dag. */
export function deadlineClock(deadline: string): string | null {
  const t = /T(\d{2}):(\d{2})$/.exec(deadline);
  return t ? `${t[1]}.${t[2]}` : null;
}

/** Er fristen med klokkeslæt overskredet nu? En frist uden klokkeslæt gælder hele dagen. */
export function pastClock(deadline: string, now = new Date()): boolean {
  const t = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(deadline);
  if (!t) return false;
  const [y, m, d, h, min] = t.slice(1).map(Number);
  return now.getTime() >= new Date(y, m - 1, d, h, min).getTime();
}

export function daysLeft(deadline: string, now = new Date()): number {
  const [y, m, d] = deadline.slice(0, 10).split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}
