// Claudes resultater i selve filen (2/10: »research kan ligge i selve filen ligesom
// fraklip«), som skjulte blokke sidst i teksten:
//
//   <!-- gt:claude id=c1 type=research dato=2026-10-02
//   {"question": "…", "findings": [ … ]}
//   -->
//
// De følger teksten, når den flyttes, kommer med i Versioner og er der igen, når teksten åbnes.
// De skjules i editoren, vises i fanen Input og kommer hverken med i ordtal, print, Word eller
// det, der sendes til Claude (withoutParked fjerner dem, Rust fjerner alle kommentarer).
// Indholdet er JSON, escapet som fraklip, så en kommentar i et citat aldrig lukker blokken.

import { appendParked, escapeParked, unescapeParked } from "./parked.ts";
import { todayIso } from "./dates.ts";

export type ClaudeKind = "faktatjek" | "research";
export type ClaudeBlock = { id: string; kind: ClaudeKind; date: string; data: unknown; from: number; to: number };

export const CLAUDE_BLOCK = /<!-- gt:claude id=(\S+) type=(\S+) dato=(\S+)[^\n]*\n([\s\S]*?)\n?-->\n?/g;

export function findClaudeBlocks(doc: string): ClaudeBlock[] {
  const out: ClaudeBlock[] = [];
  for (const m of doc.matchAll(CLAUDE_BLOCK)) {
    if (m[2] !== "faktatjek" && m[2] !== "research") continue;
    let data: unknown = null;
    try {
      data = JSON.parse(unescapeParked(m[4]));
    } catch {
      continue; // En blok, der ikke kan læses, vises ikke, men bliver i filen.
    }
    const from = m.index ?? 0;
    out.push({ id: m[1], kind: m[2], date: m[3], data, from, to: from + m[0].length });
  }
  return out;
}

function nextId(doc: string): string {
  let max = 0;
  for (const b of findClaudeBlocks(doc)) max = Math.max(max, Number(b.id.replace(/^c/, "")) || 0);
  return `c${max + 1}`;
}

export function claudeBlock(id: string, kind: ClaudeKind, date: string, data: unknown): string {
  return `<!-- gt:claude id=${id} type=${kind} dato=${date}\n${escapeParked(JSON.stringify(data))}\n-->\n`;
}

/**
 * Ændringerne, der gemmer et resultat. Et nyt faktatjek erstatter det forrige (det er teksten
 * som helhed, der er tjekket). Research lægges ved siden af de tidligere.
 */
export function saveChanges(doc: string, kind: ClaudeKind, data: unknown, date = todayIso()): { from: number; to?: number; insert: string }[] {
  const changes: { from: number; to?: number; insert: string }[] = [];
  let rest = doc;
  if (kind === "faktatjek") {
    for (const old of findClaudeBlocks(doc).filter((b) => b.kind === "faktatjek").reverse()) {
      changes.push({ from: old.from, to: old.to, insert: "" });
      rest = rest.slice(0, old.from) + rest.slice(old.to);
    }
  }
  const block = claudeBlock(nextId(doc), kind, date, data);
  changes.push({ from: doc.length, insert: appendParked(rest, block).insert });
  return changes;
}
