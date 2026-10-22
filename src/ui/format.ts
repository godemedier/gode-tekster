// Rene hjælpefunktioner til biblioteket: tid som i iA og søgning i filnavne til hurtigåbningen.

import { isEnglish, tr } from "../i18n.ts";

/** »14.12« i dag, »i går«, ellers »30.09.2026«. På engelsk »14:12«, »yesterday«, »30/09/2026«. */
export function formatTime(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const en = isEnglish();
  if (sameDay(d, now)) return `${pad(d.getHours())}${en ? ":" : "."}${pad(d.getMinutes())}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return tr("i går", "yesterday");
  const sep = en ? "/" : ".";
  return `${pad(d.getDate())}${sep}${pad(d.getMonth() + 1)}${sep}${d.getFullYear()}`;
}

/**
 * Point for et filnavn mod en søgning: alle tegn skal findes i rækkefølge. Sammenhængende tegn og
 * start af ord giver flere point. -1 betyder intet fund. Store og små bogstaver er ligegyldige.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    run = found === ti ? run + 1 : 1;
    score += run * 2;
    if (found === 0 || /[\s\-_./]/.test(t[found - 1] ?? "")) score += 3;
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 10;
  if (t.includes(q)) score += 6;
  return score;
}
