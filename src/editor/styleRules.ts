// Stiltjekkets regler uden CodeMirror, så de kan køre i en worker (styleWorker.ts). Analysen af
// 200 sider tog 340-440 ms på hovedtråden og frøs skrivefladen ved hver pause (målt 2/10).

import { analyzeClarity, type ClarityKind } from "../sprog/clarity.ts";
import { analyzeAiTells } from "../sprog/aitells.ts";

export type Flag = { from: number; to: number; kind: string; message: string; replacement?: string };
type Category = "stryg" | "enklere" | "saetning" | "hus";

const CATEGORY: Partial<Record<ClarityKind, Category>> = {
  floskel: "stryg",
  fyldord: "stryg",
  omstaendeligt: "enklere",
  fremmedord: "enklere",
  "upraecis-maengde": "enklere",
  "ladet-attribution": "enklere",
  "vis-ikke-fortael": "enklere",
  lang: "saetning",
  "meget-lang": "saetning",
  passiv: "saetning",
  nominalisering: "saetning",
  "svagt-anslag": "saetning",
  "tung-optakt": "saetning",
  adverbier: "saetning",
  gentagelse: "saetning",
};

/** Markdown-tegn, kode, links og skjulte blokke bliver til mellemrum, så positionerne passer. */
export function mask(doc: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return doc
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/^```[\s\S]*?^```/gm, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\{>>[\s\S]*?<<\}/g, blank)
    .replace(/\]\([^)\n]*\)/g, blank)
    .replace(/^(#{1,6}\s|>\s?|\s*[-*+]\s(\[[ xX]\]\s)?|\s*\d+[.)]\s)/gm, blank)
    .replace(/^\[\^[^\]\s]+\]:/gm, blank)
    .replace(/\[\^[^\]\s]+\]/g, blank)
    .replace(/(\*\*|__|~~|\{--|--\}|\{\+\+|\+\+\}|\{~~|~>|<\/?u>)/g, blank);
}

export function analyze(doc: string): { flags: Flag[]; lix: number; lixLabel: string } {
  const text = mask(doc);
  const clarity = analyzeClarity(text);
  const flags: Flag[] = [];
  for (const f of clarity.flags) {
    if (f.inQuote || !CATEGORY[f.kind]) continue;
    flags.push({ from: f.offset, to: f.offset + f.length, kind: f.kind, message: f.message, replacement: (f as { replacement?: string }).replacement });
  }
  for (const f of analyzeAiTells(text).flags) {
    if (f.inQuote) continue;
    flags.push({ from: f.offset, to: f.offset + f.length, kind: `hus:${f.kind}`, message: f.message, replacement: f.replacement });
  }
  return { flags, lix: clarity.lix, lixLabel: clarity.lixLabel };
}

export function categoryOf(kind: string): Category {
  return kind.startsWith("hus:") ? "hus" : (CATEGORY[kind as ClarityKind] ?? "saetning");
}
