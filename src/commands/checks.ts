// Tjek (research 3.1 og planen): de læser kun og giver fund med præcise positioner i den tekst,
// de fik. Brugerens egne tjek er ordlister med én regel pr. linje, `fra => til`. Reglen er fast
// tekst og hele ord, aldrig et mønster. De tre indbyggede (`builtin: names`, `gaps`, `repeats`)
// er skøn, der peger på steder at se efter. De retter intet. `builtin: all` er alle tre i ét, og
// det er den, /tjek bruger (6/10: »hvorfor ikke bare /tjek?«).
//
// Skjulte blokke, noter og dæmpet tekst læses ikke. Eneste undtagelse er `gaps`, som også finder
// noter, der begynder med TJEK eller CHECK.
// Rene funktioner, testet med node --test.

import { tr, type Lang } from "../i18n.ts";
import { protectedSpans } from "./blocks.ts";
import type { Command, CommandError, Finding } from "./types.ts";

export const BUILTIN_CHECKS: string[] = ["all", "names", "gaps", "repeats"];
/** Flere fund end det er en liste, ingen læser. */
const MAX_FINDINGS = 200;

export type WordRule = { from: string; to: string; line: number };

/** Id'et i `builtin: <id>`, ellers null. Et id, der ikke findes, giver også en streng, så fejlen kan vises. */
export function builtinCheckId(body: string): string | null {
  const m = /^\s*builtin:\s*(\S*)\s*$/.exec(body);
  return m ? m[1] : null;
}

/** Læs en ordliste. Tomme linjer springes over, og `line` er linjen i kroppen (1 = første). */
export function parseWordlist(body: string): { rules: WordRule[]; errors: CommandError[] } {
  const rules: WordRule[] = [];
  const errors: CommandError[] = [];
  body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((raw, i) => {
      const line = i + 1;
      if (raw.trim() === "") return;
      const at = raw.indexOf("=>");
      if (at === -1) {
        errors.push({ line, message: tr("Linjen mangler en pil. Skriv reglen som: fra => til", "The line has no arrow. Write the rule as: from => to") });
        return;
      }
      const from = raw.slice(0, at).trim();
      if (from === "") {
        errors.push({ line, message: tr("Der står ikke noget foran pilen.", "There is nothing before the arrow.") });
        return;
      }
      rules.push({ from, to: raw.slice(at + 2).trim(), line });
    });
  return { rules, errors };
}

type Range = { from: number; to: number };

/** Det, tjekkene ikke læser: skjulte blokke, noter og dæmpet tekst med mærker. */
function skipped(text: string): Range[] {
  const out: Range[] = [];
  let open: number | null = null;
  for (const s of protectedSpans(text)) {
    if (s.kind === "hidden" || s.kind === "note") out.push({ from: s.from, to: s.to });
    else if (s.kind === "dim-open") open = s.from;
    else if (s.kind === "dim-close" && open !== null) {
      out.push({ from: open, to: s.to });
      open = null;
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Teksten med det oversprungne byttet til mellemrum. Længden og linjeskiftene er de samme, så positionerne holder. */
function readable(text: string): string {
  let out = "";
  let at = 0;
  for (const r of skipped(text)) {
    // En note inde i dæmpet tekst ligger inden i et større område. Kun det nye stykke tages med.
    const from = Math.max(r.from, at);
    if (r.to <= from) continue;
    out += text.slice(at, from) + text.slice(from, r.to).replace(/[^\n]/g, " ");
    at = r.to;
  }
  return out + text.slice(at);
}

const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const quoted = (s: string) => tr(`»${s}«`, `“${s}”`);

function wordlist(rules: WordRule[], text: string): Finding[] {
  const clean = readable(text);
  const out: Finding[] = [];
  for (const r of rules) {
    const needle = r.from.toLowerCase();
    for (let i = 0; i + r.from.length <= clean.length; i++) {
      if (clean.slice(i, i + r.from.length).toLowerCase() !== needle) continue;
      // Hele ord: »pct.« i »pct. af« tæller, »del« i »delvis« gør ikke (æøå er bogstaver, L-066).
      if (isWord(r.from[0]) && isWord(clean[i - 1])) continue;
      if (isWord(r.from[r.from.length - 1]) && isWord(clean[i + r.from.length])) continue;
      out.push({ from: i, to: i + r.from.length, excerpt: text.slice(i, i + r.from.length), comment: r.to || tr("Står på din ordliste.", "Is on your word list.") });
      i += r.from.length - 1;
    }
  }
  return out;
}

// --- names: samme navn stavet forskelligt, og tal med forskellig værdi ---------------------------

type Word = { text: string; from: number; to: number };

const WORD = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
const words = (text: string): Word[] => [...text.matchAll(WORD)].map((m) => ({ text: m[0], from: m.index ?? 0, to: (m.index ?? 0) + m[0].length }));

/** Står ordet først i en sætning eller på en linje? Der har alle ord stort begyndelsesbogstav. */
function startsSentence(text: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /[ \t»«"“”‘’(\[*_#>-]/.test(text[i])) i -= 1;
  return i < 0 || /[\n.!?…:]/.test(text[i]);
}

/** Antal rettelser mellem to ord (indsæt, slet, byt et bogstav, byt om på to naboer), dog højst `max` + 1. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      row.push(v);
    }
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

/** Ejefald og flertal er ikke en anden stavemåde: »Jensens«, »Jensen's«. */
const stem = (name: string) => name.toLowerCase().replace(/['’]?s$/, "");

function nameFindings(text: string, clean: string): Finding[] {
  // Navne: ord med stort begyndelsesbogstav midt i en sætning, mindst fem bogstaver.
  const seen = new Map<string, { shown: string; hits: Word[] }>();
  const capitalised = words(clean).filter((w) => w.text.length >= 5 && /^\p{Lu}\p{Ll}/u.test(w.text));
  const count = (w: Word) => {
    const key = stem(w.text);
    const entry = seen.get(key) ?? { shown: w.text, hits: [] };
    entry.hits.push(w);
    seen.set(key, entry);
  };
  const first = capitalised.filter((w) => startsSentence(clean, w.from));
  for (const w of capitalised) if (!first.includes(w)) count(w);
  // Først i en sætning har alle ord stort. De tæller kun, når de ligner et navn, der er set midt i en.
  const known = [...seen.keys()];
  for (const w of first) {
    const key = stem(w.text);
    if (known.some((k) => distance(key, k, 1) <= 1)) count(w);
  }
  for (const entry of seen.values()) entry.hits.sort((a, b) => a.from - b.from);
  const names = [...seen.entries()];
  const out: Finding[] = [];
  for (const [key, entry] of names) {
    // Lange navne må afvige med to bogstaver, korte med ét.
    const twin = names.find(([other]) => {
      const max = key.length >= 9 && other.length >= 9 ? 2 : 1;
      return other !== key && distance(key, other, max) <= max;
    });
    if (!twin) continue;
    // Den sjældne form er oftest fejlen. Står de lige tit, vises begge.
    if (entry.hits.length > twin[1].hits.length) continue;
    for (const h of entry.hits) {
      out.push({ from: h.from, to: h.to, excerpt: text.slice(h.from, h.to), comment: tr(`Står også som ${quoted(twin[1].shown)}. Er det samme navn?`, `Also written ${quoted(twin[1].shown)}. Is it the same name?`) });
    }
  }
  return out;
}

/** Enheder, der naturligt står efter mange forskellige tal. De siger ikke, at to tal handler om det samme. */
const UNITS = new Set(
  "år års kr kroner procent pct procentpoint timer time dage dag uger uge måneder måned minutter mio mia millioner milliarder tusind gange gang meter km kilometer kg gram liter grader stk sider side years year percent days day hours hour weeks week months month minutes million billion thousand times pounds dollars euro euros miles pages page".split(
    " ",
  ),
);

function numberFindings(text: string, clean: string): Finding[] {
  // Et tal og ordet lige efter: »340 medlemmer«. Samme ord med to forskellige tal er værd at se på.
  const seen = new Map<string, { value: string; from: number; to: number }[]>();
  for (const m of clean.matchAll(/(?<![\p{L}\p{N}.,])(\d+(?:[.,]\d+)*)[  ](\p{L}{3,})/gu)) {
    const unit = m[2].toLowerCase();
    if (UNITS.has(unit)) continue;
    const from = m.index ?? 0;
    const list = seen.get(unit) ?? [];
    list.push({ value: m[1], from, to: from + m[1].length });
    seen.set(unit, list);
  }
  const out: Finding[] = [];
  for (const [unit, list] of seen) {
    const values = [...new Set(list.map((l) => l.value))];
    if (values.length < 2) continue;
    for (const hit of list) {
      const others = values.filter((v) => v !== hit.value).join(tr(" og ", " and "));
      out.push({ from: hit.from, to: hit.to, excerpt: text.slice(hit.from, hit.to), comment: tr(`Et andet sted står der ${others} ${unit}. Stemmer tallene?`, `Elsewhere it says ${others} ${unit}. Do the figures agree?`) });
    }
  }
  return out;
}

// --- gaps: det, skribenten selv har markeret som ufærdigt ----------------------------------------

function gapFindings(text: string, clean: string): Finding[] {
  const out: Finding[] = [];
  const add = (source: string, re: RegExp, comment: string) => {
    for (const m of source.matchAll(re)) {
      const from = m.index ?? 0;
      out.push({ from, to: from + m[0].length, excerpt: text.slice(from, from + m[0].length), comment });
    }
  };
  const unfinished = tr("Markeret som ufærdigt.", "Marked as unfinished.");
  add(clean, /(?<![\p{L}\p{N}])(?:TK|XXX+)(?![\p{L}\p{N}])/gu, unfinished);
  add(clean, /\?{2,}/g, unfinished);
  add(clean, /\[(?:\?+|\.{3}|…)\]/g, unfinished);
  add(clean, /(?<!!)\[[^\]\n]*\]\(\s*\)/g, tr("Linket har ingen adresse.", "The link has no address."));
  add(clean, /(?<!!)\[\s*\]\([^)\n]+\)/g, tr("Linket har ingen tekst.", "The link has no text."));
  // Noterne er sprunget over i `clean`, så de findes i den rigtige tekst.
  add(text, /<!--(?!\s*gt:)\s*(?:TJEK|CHECK)\b[\s\S]*?-->|\{>>\s*(?:TJEK|CHECK)\b[\s\S]*?<<\}/g, tr("Kommentar, der skal tjekkes.", "Comment to check."));
  // »[???]« rammes af to regler. Det længste fund vinder.
  out.sort((a, b) => a.from - b.from || b.to - a.to);
  const kept: Finding[] = [];
  for (const f of out) if (!kept.some((k) => f.from < k.to && f.to > k.from)) kept.push(f);
  return kept;
}

// --- repeats: samme ord to gange i træk, og samme sætningsstart tre gange i træk ------------------

const STRUCTURAL = /^\s*(?:#{1,6} |[-*+] |\d+[.)] |\|)/;

function repeatFindings(text: string, clean: string): Finding[] {
  const out: Finding[] = [];
  const all = words(clean);
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1];
    const b = all[i];
    // Kun blanktegn imellem, og ikke tal: »2 2« er en tabel, ikke en tastefejl.
    // En tom linje imellem er et nyt afsnit, og så er det ikke en gentagelse.
    if (a.text.toLowerCase() !== b.text.toLowerCase() || !/^(?:[ \t]+|[ \t]*\n[ \t]*)$/.test(clean.slice(a.to, b.from)) || /^\d/.test(a.text)) continue;
    out.push({ from: a.from, to: b.to, excerpt: text.slice(a.from, b.to), comment: tr(`${quoted(b.text)} står to gange i træk.`, `${quoted(b.text)} appears twice in a row.`) });
  }
  // Sætningsstarter. Punkter, overskrifter og tabeller tæller ikke: en liste må gerne begynde ens.
  let run: Word[] = [];
  let offset = 0;
  const flush = () => {
    run = [];
  };
  for (const line of clean.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (line.trim() === "") continue;
    if (STRUCTURAL.test(line)) {
      flush();
      continue;
    }
    for (const m of line.matchAll(/(?:^|(?<=[.!?…][»«"”’)\]]*\s))[\s»«"“”‘’(\[]*([\p{L}\p{N}]+)/gu)) {
      const from = lineStart + (m.index ?? 0) + m[0].length - m[1].length;
      const word = { text: m[1], from, to: from + m[1].length };
      if (run.length && run[0].text.toLowerCase() !== word.text.toLowerCase()) flush();
      run.push(word);
      if (run.length >= 3) {
        out.push({
          from: word.from,
          to: word.to,
          excerpt: text.slice(word.from, word.to),
          comment: tr(`${run.length} sætninger i træk begynder med ${quoted(run[0].text)}.`, `${run.length} sentences in a row start with ${quoted(run[0].text)}.`),
        });
      }
    }
  }
  return out;
}

/**
 * Kør et tjek på teksten. Kroppen er `builtin: <id>` eller en ordliste. `from` og `to` er
 * positioner i `text`, og `excerpt` er præcis `text.slice(from, to)`. Fundene står i tekstens
 * rækkefølge. Et tjek, der ikke kan læses, giver ingen fund: fejlen hører hjemme i `validateCommand`.
 */
export function runCheck(command: Command, text: string, _lang: Lang): Finding[] {
  const id = builtinCheckId(command.body);
  const clean = readable(text);
  const found =
    id === null
      ? wordlist(parseWordlist(command.body).rules, text)
      : id === "names"
        ? [...nameFindings(text, clean), ...numberFindings(text, clean)]
        : id === "gaps"
          ? gapFindings(text, clean)
          : id === "repeats"
            ? repeatFindings(text, clean)
            : id === "all"
              ? [...gapFindings(text, clean), ...nameFindings(text, clean), ...numberFindings(text, clean), ...repeatFindings(text, clean)]
              : [];
  return found.sort((a, b) => a.from - b.from || a.to - b.to).slice(0, MAX_FINDINGS);
}
