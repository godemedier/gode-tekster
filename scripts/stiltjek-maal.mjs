// Kræver private prøvetekster i tests/private/ og skriver til audit/. Ingen af dem er offentlige.
// Målebænk for stiltjekket (fase 0, ADR-0051). Kører præcis den
// analyse, programmet viser (`analyze` i src/editor/styleRules.ts), på to slags tekst:
//
//   1. Et korpus af redigerede artikler: fund pr. regel pr. 1.000 ord og faste stikprøver med
//      sætningen omkring, til vurdering af præcision. Redigeret tekst har få fejl (0,2-0,5 %), så
//      grammatikfund her er næsten altid falske.
//   2. DaLA (CC BY 4.0, danish-foundation-models/dala): rigtige og fejlbehæftede sætninger. Fangst
//      pr. fejltype og andelen af rigtige sætninger, der fejlagtigt får et grammatikfund.
//
// Teksterne ligger aldrig i repoet. Stier gives som argumenter eller miljøvariabler, og resultatet
// skrives i audit/stiltjek/ (gitignoreret).
//
//   node scripts/stiltjek-maal.mjs [--korpus articles.json] [--dala dala-test.jsonl] [--navn før]
//                                  [--komma start|uden|fra] [--stikproever 20]

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { analyze, isStandard } from "../src/editor/styleRules.ts";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const KORPUS = arg("korpus", process.env.GT_KORPUS ?? "tests/private/stiltjek/korpus.json");
const DALA = arg("dala", "tests/private/stiltjek/dala-test.jsonl");
const NAVN = arg("navn", new Date().toISOString().slice(0, 10));
const KOMMA = arg("komma", "start");
const N = Number(arg("stikproever", "20"));
const OUT = "audit/stiltjek";

const lex = JSON.parse(readFileSync("src/assets/ordklasser.json", "utf8"));
const words = {
  verbs: new Set(lex.v),
  nouns: new Set(lex.n),
  adjectives: new Set(lex.a),
  adverbs: new Set(lex.d),
  agree: JSON.parse(readFileSync("src/assets/kongruens.json", "utf8")),
};

/** Fast tilfældighed, så stikprøverne er de samme fra kørsel til kørsel (mulberry32). */
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sætningen omkring fundet, med fundet i ⟦ ⟧. */
function context(text, from, to) {
  let a = from;
  while (a > 0 && !/[.!?\n]/.test(text[a - 1]) && from - a < 300) a--;
  let b = to;
  while (b < text.length && !/[.!?\n]/.test(text[b]) && b - to < 300) b++;
  if (b < text.length) b++;
  return `${text.slice(a, from)}⟦${text.slice(from, to)}⟧${text.slice(to, b)}`.replace(/\s+/g, " ").trim();
}

const countWords = (t) => (t.match(/\p{L}+/gu) ?? []).length;

/** Fast frø pr. regel, så en uændret regel får de samme stikprøver, og vurderingerne kan genbruges. */
const seedOf = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 20261012);

/**
 * Artiklens egen tekst uden udtrækkets skrald: rubrikken forrest, »Relateret indhold« og kildelister
 * bagerst, HTML- og CSS-rester, indlejrede tweets, links og debatsektionens faste forbehold.
 * Uden rensning kom omkring en tredjedel af fundene fra skraldet (vurdering 12/10).
 */
export function clean(article) {
  let t = article.text;
  if (article.title && t.startsWith(article.title)) t = t.slice(article.title.length);
  for (const stop of ["Relateret indhold", "Kilder og referencer"]) {
    const i = t.indexOf(stop);
    if (i > 0) t = t.slice(0, i);
  }
  return t
    .replace(/[^.!?»”"]*?(?:pic\.twitter\.com\/\S+\s*|https:\/\/t\.co\/\S+\s*)?— [^()\n]{1,60}\(@\w+\) \p{L}+ \d{1,2}, \d{4}/gu, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\S*(?:[<>]|\b(?:sm|md|lg|xl|print):)\S*/g, " ")
    .replace(/Dette er et debatindlæg\. Teksten er udtryk for forfatterens egen holdning\./g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

mkdirSync(OUT, { recursive: true });
const result = { navn: NAVN, komma: KOMMA, korpus: null, dala: null };
const lines = [`# Stiltjek målt: ${NAVN} (komma: ${KOMMA})`, ""];

// --- 1. korpus -------------------------------------------------------------------------------------
if (existsSync(KORPUS)) {
  const raw = JSON.parse(readFileSync(KORPUS, "utf8"));
  const articles = (Array.isArray(raw) ? raw : Object.values(raw))
    .filter((a) => typeof a.text === "string")
    .map((a) => ({ ...a, text: clean(a) }))
    .filter((a) => a.text.length > 200);
  const perKind = new Map();
  let totalWords = 0;
  const started = Date.now();
  articles.forEach((a, ai) => {
    totalWords += countWords(a.text);
    // Alle regler måles, også dem, der ikke vises som standard.
    for (const f of analyze(a.text, words, KOMMA, true).flags) {
      const k = perKind.get(f.kind) ?? { kind: f.kind, count: 0, articles: new Set(), hits: [] };
      k.count++;
      k.articles.add(ai);
      k.hits.push({ article: ai, from: f.from, to: f.to, message: f.message, replacement: f.replacement });
      perKind.set(f.kind, k);
    }
  });
  const ms = Date.now() - started;
  const samples = [];
  const table = [...perKind.values()].sort((x, y) => y.count - x.count).map((k) => {
    // Højst ét fund pr. artikel i stikprøven, så én artikel ikke fylder den.
    const pool = [...new Map(k.hits.map((h) => [h.article, h])).values()];
    const random = rng(seedOf(k.kind));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const h of pool.slice(0, N)) {
      const text = articles[h.article].text;
      samples.push({ id: `${k.kind}#${h.article}:${h.from}`, kind: k.kind, ord: text.slice(h.from, h.to), saetning: context(text, h.from, h.to), besked: h.message, forslag: h.replacement ?? null });
    }
    return { kind: k.kind, fund: k.count, prTusindOrd: +(k.count / (totalWords / 1000)).toFixed(3), artikler: k.articles.size };
  });
  // Præcision fra vurderingerne (audit/stiltjek/vurdering-*.jsonl), slået op på stikprøvens id.
  const verdicts = new Map();
  for (const f of existsSync(OUT) ? readdirSync(OUT).filter((f) => /^vurdering-.*\.jsonl$/.test(f)) : []) {
    for (const l of readFileSync(`${OUT}/${f}`, "utf8").trim().split("\n")) {
      if (!l) continue;
      const v = JSON.parse(l);
      verdicts.set(v.id, v);
    }
  }
  const missing = [];
  for (const r of table) {
    const own = samples.filter((x) => x.kind === r.kind);
    const judged = own.map((x) => verdicts.get(x.id)).filter(Boolean);
    missing.push(...own.filter((x) => !verdicts.has(x.id)));
    const n = (v) => judged.filter((j) => j.nyttig === v).length;
    r.vurderet = judged.length;
    r.ja = n("ja");
    r.nej = n("nej");
    r.tvivl = n("tvivl");
    r.praecision = judged.length ? +(r.ja / judged.length).toFixed(2) : null;
    // Uden fund, der kun skyldes korpusudtrækket (mellemrubrik eller byline limet på sætningen).
    const real = judged.filter((j) => !/udtræksrest/i.test(j.grund ?? ""));
    r.praecisionUdenRest = real.length ? +(real.filter((j) => j.nyttig === "ja").length / real.length).toFixed(2) : null;
  }
  writeFileSync(`${OUT}/mangler-vurdering-${NAVN}.jsonl`, missing.map((s) => JSON.stringify(s) + "\n").join(""));
  result.korpus = { artikler: articles.length, ord: totalWords, ms, regler: table, ikkeVurderet: missing.length };
  writeFileSync(`${OUT}/stikproever-${NAVN}.jsonl`, samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
  lines.push(`## Korpus: ${articles.length} redigerede artikler, ${totalWords.toLocaleString("da-DK")} ord (${ms} ms)`, "");
  lines.push("| Regel | Fund | Pr. 1.000 ord | Artikler | Nyttige (ja/nej/tvivl) | Præcision | Uden udtræksrest | Standard |", "|---|---:|---:|---:|---|---:|---:|---|");
  for (const r of table) {
    const p = r.praecision === null ? "ikke vurderet" : `${Math.round(r.praecision * 100)} %`;
    const q = r.praecisionUdenRest === null ? "" : `${Math.round(r.praecisionUdenRest * 100)} %`;
    lines.push(`| ${r.kind} | ${r.fund} | ${String(r.prTusindOrd).replace(".", ",")} | ${r.artikler} | ${r.vurderet ? `${r.ja}/${r.nej}/${r.tvivl}` : ""} | ${p} | ${q} | ${isStandard(r.kind) ? "ja" : ""} |`);
  }
  const total = table.reduce((s, r) => s + r.fund, 0);
  lines.push("", "Præcision = andel af stikprøven, en redaktør ville have ønsket markeret (»ja«). »tvivl« tæller ikke med som ja.");
  lines.push("", `I alt ${total} fund, ${String((total / (totalWords / 1000)).toFixed(1)).replace(".", ",")} pr. 1.000 ord. Stikprøver: \`${OUT}/stikproever-${NAVN}.jsonl\`.`, "");
} else {
  lines.push(`Korpus ikke fundet: ${KORPUS}`, "");
}

// --- 2. DaLA -------------------------------------------------------------------------------------
if (existsSync(DALA)) {
  const rows = readFileSync(DALA, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const grammar = (text) => analyze(text, words, KOMMA, true).flags.filter((f) => f.kind.startsWith("grammatik:"));
  const byType = new Map();
  const falseKinds = new Map();
  const falseExamples = [];
  for (const r of rows) {
    const type = r.corruption_type ?? "rigtig";
    const flags = grammar(r.text);
    const t = byType.get(type) ?? { type, saetninger: 0, medFund: 0 };
    t.saetninger++;
    if (flags.length) t.medFund++;
    byType.set(type, t);
    if (type === "rigtig") {
      for (const f of flags) {
        falseKinds.set(f.kind, (falseKinds.get(f.kind) ?? 0) + 1);
        if (falseExamples.length < 40) falseExamples.push({ kind: f.kind, saetning: context(r.text, f.from, f.to) });
      }
    }
  }
  const types = [...byType.values()].sort((a, b) => b.saetninger - a.saetninger);
  result.dala = { saetninger: rows.length, typer: types, falskeRegler: Object.fromEntries(falseKinds), falskeEksempler: falseExamples };
  lines.push(`## DaLA: ${rows.length} sætninger, kun grammatikfund`, "");
  lines.push("| Fejltype | Sætninger | Med fund | Andel |", "|---|---:|---:|---:|");
  for (const t of types) lines.push(`| ${t.type} | ${t.saetninger} | ${t.medFund} | ${String(((100 * t.medFund) / t.saetninger).toFixed(1)).replace(".", ",")} % |`);
  lines.push("", "»rigtig« er falske fund: rigtige sætninger, der fik mindst ét grammatikfund.", "");
  if (falseKinds.size) {
    lines.push("Falske fund i rigtige sætninger pr. regel:", "");
    for (const [k, n] of [...falseKinds].sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${n}`);
    lines.push("");
  }
} else {
  lines.push(`DaLA ikke fundet: ${DALA}`, "");
}

writeFileSync(`${OUT}/maaling-${NAVN}.md`, lines.join("\n"));
writeFileSync(`${OUT}/maaling-${NAVN}.json`, JSON.stringify(result, null, 1));
console.log(lines.join("\n"));
