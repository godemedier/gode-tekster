// Stiltjekkets regler uden CodeMirror, så de kan køre i en worker (styleWorker.ts). Analysen af
// 200 sider tog 340-440 ms på hovedtråden og frøs skrivefladen ved hver pause (målt 2/10).

import { analyzeClarity, type ClarityKind } from "../sprog/clarity.ts";
import { analyzeAiTells } from "../sprog/aitells.ts";
import { grammarFlags, type Agreement } from "./grammar.ts";
import { retskrivningFlags } from "./retskrivning.ts";
import { papirordFlags } from "./papirord.ts";
import { saetningFlags } from "./saetning.ts";

export type Flag = { from: number; to: number; kind: string; message: string; replacement?: string };
export type Category = "stryg" | "enklere" | "saetning" | "hus" | "grammatik";

/**
 * Passiv og navneordsstil er et mål for hele teksten, ikke et fund pr. sætning (fase 1, 13/10).
 * Forskningen støtter dem kun svagt (Balling 2013/2018), og målebænken fandt 10-15 % nyttige fund
 * for passiv. En passiv sætning er sjældent forkert. Mange er et tegn på tung tekst.
 */
export type Density = { sentences: number; passive: number; nominal: number };

const CATEGORY: Partial<Record<ClarityKind | "papirord" | "papirord-2" | "omkring" | "indskud" | "kloevning", Category>> = {
  floskel: "stryg",
  fyldord: "stryg",
  omstaendeligt: "enklere",
  fremmedord: "enklere",
  "upraecis-maengde": "enklere",
  "ladet-attribution": "enklere",
  // Fase 2-3 (16/10): papirord.ts og saetning.ts. Retskrivningens »ro:« hører til grammatikken.
  papirord: "enklere",
  "papirord-2": "enklere",
  omkring: "enklere",
  indskud: "saetning",
  kloevning: "saetning",
  "vis-ikke-fortael": "enklere",
  lang: "saetning",
  "meget-lang": "saetning",
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

/** Ordlisterne til grammatikken (grammar.ts). Uden dem springes grammatikken over. */
export type GrammarWords = { verbs: ReadonlySet<string>; nouns: ReadonlySet<string>; adjectives: ReadonlySet<string>; adverbs: ReadonlySet<string>; agree: Agreement };

/**
 * Forklaringerne uden tankestreger (9/10, SKRIVESTIL): »Svagt anslag – start hellere …« bliver
 * »Svagt anslag: start hellere …«. Reglerne er Gode Ords, så rettelsen hører også hjemme dér.
 */
export function plainMessage(message: string): string {
  return message.replace(/\s+[–—]\s+/, ": ").replace(/\s+[–—]\s+/g, ", ");
}

/**
 * Reglerne, der vises som standard. Målt 12/10 på 1.774 redigerede fagbladsartikler med en
 * redaktørs vurdering af stikprøver (scripts/stiltjek-maal.mjs, docs/research/2026-10-12-stiltjek-plan.md):
 * kun regler, hvor mindst 70 % af fundene var nyttige. Resten vises kun med »Alle forslag«
 * (indstillingen strictStyle). En ny regel er uden for listen, til den er målt. Floskel og vag kilde
 * fik 65 % (13 af 20), men kun 2-3 af 20 var forkerte, resten var tvivl. Taget med 12/10.
 */
const STANDARD = new Set([
  "floskel", "hus:vag-kilde", "hus:semikolon", "hus:tusindtal", "hus:title-case", "hus:emoji-punkt", "hus:fed-punkt",
  // Fase 2-3, målt 16/10 (ADR-0059): retskrivning 100 %, papirord 95 %, »omkring« 88 %.
  "ro:to-ord", "ro:forkortelse", "ro:tal", "ro:forveksling", "papirord", "omkring",
]);
export const isStandard = (kind: string): boolean => kind.startsWith("grammatik:") || STANDARD.has(kind);

export function analyze(doc: string, words?: GrammarWords, comma?: string, strict = false): { flags: Flag[]; lix: number; lixLabel: string; density: Density } {
  const text = mask(doc);
  const clarity = analyzeClarity(text);
  const flags: Flag[] = [];
  // Højst ét passiv- og ét navneordsfund pr. sætning (clarity.ts), så tallene er sætninger.
  const density: Density = { sentences: clarity.sentences, passive: 0, nominal: 0 };
  for (const f of clarity.flags) {
    if (f.inQuote) continue;
    if (f.kind === "passiv") density.passive++;
    if (f.kind === "nominalisering") density.nominal++;
    if (!CATEGORY[f.kind]) continue;
    flags.push({ from: f.offset, to: f.offset + f.length, kind: f.kind, message: plainMessage(f.message), replacement: (f as { replacement?: string }).replacement });
  }
  // Syv vendinger står både som floskel og som AI-ord (»kaste lys over«). Ét fund pr. sted.
  const taken = new Set(flags.map((f) => `${f.from}:${f.to}`));
  for (const f of analyzeAiTells(text).flags) {
    if (f.inQuote || taken.has(`${f.offset}:${f.offset + f.length}`)) continue;
    flags.push({ from: f.offset, to: f.offset + f.length, kind: `hus:${f.kind}`, message: plainMessage(f.message), replacement: f.replacement });
  }
  flags.push(...retskrivningFlags(text), ...papirordFlags(text));
  if (words) flags.push(...grammarFlags(text, words.verbs, words.agree, words.adjectives, words.nouns, comma, words.adverbs));
  if (words) flags.push(...saetningFlags(text, words.verbs, words.nouns));
  return { flags: strict ? flags : flags.filter((f) => isStandard(f.kind)), lix: clarity.lix, lixLabel: clarity.lixLabel, density };
}

export function categoryOf(kind: string): Category {
  if (kind.startsWith("grammatik:") || kind.startsWith("ro:")) return "grammatik";
  return kind.startsWith("hus:") ? "hus" : (CATEGORY[kind as keyof typeof CATEGORY] ?? "saetning");
}
