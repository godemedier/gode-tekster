// KOPI af gode-ord/src/lib/aitells.ts @ ebee85f 2026-10-07. Ret i Gode Ord, ikke her, og kør scripts/sprog.mjs.
// Maskinsprog-analyse – tekstformer som mange forbinder med AI. DETERMINISTISK: ingen service,
// ingen nøgle, instant (kører klient-side). Spejler clarity.ts' form, men er en anden linse.
//
// VIGTIGT: dette er IKKE en AI-detektor. Vi kan ikke afgøre, om en tekst er maskinskrevet, og
// ingen kan pålideligt på dansk. Vi måler noget andet og ærligere: "er der noget her, der får
// dig til at LIGNE en maskine?" En falsk anklage mod en journalists egen tekst er en værre fejl
// end et overset tell – derfor er tærsklerne sat efter et rigtigt korpus, ikke efter mavefornemmelse.
//
// To grundlag, med hver sin rolle:
//  · RYTMEN er kalibreret på 1.712 artikler af 204 danske fagjournalister (scripts/grundform.mjs).
//    Den skal gælde enhver redaktion, ikke én skribent.
//  · ORDLISTERNE kommer fra C:\GM\standard\SKRIVESTIL.md (126 artikler af én skribent) —
//    ord skribenten faktisk bruger flages ikke, uanset hvad engelske AI-guides siger om dem.
// Plan: docs/plans/2026-08-01-maskinsprog-anti-ai.md

import { quoteRanges, inQuote, type Range } from "./quotes.ts";

export type TellKind =
  | "em-dash"
  | "semikolon"
  | "negativ-parallelisme"
  | "tricolon"
  | "formel-afslutning"
  | "ai-ord"
  | "title-case"
  | "emoji-punkt"
  | "fed-punkt"
  | "tusindtal"
  | "vag-kilde"
  | "deltager-optakt"
  | "tvangsbalance";

export type TellFlag = {
  kind: TellKind;
  offset: number;
  length: number;
  quote: string;
  message: string;
  inQuote: boolean;
  /** Kan fjernes med ét klik (rene overflødigheder). */
  canRemove: boolean;
  /** Enklere/dansk alternativ til ét-kliks-swap. */
  replacement?: string;
};

/** Dokument-niveau-fund: rytme kan ikke hænges på ét sted i teksten. */
export type RytmeFund = {
  id: "variation" | "afsnit-variation" | "korte" | "tunge";
  navn: string;
  maalt: string;
  maal: string;
  besked: string;
  /** Bidrag til scoren (0 = i orden). */
  vaegt: number;
};

export type MaskinNiveau = "menneskeligt" | "enkelte-maskintraek" | "maskinelt";

export type AiReport = {
  /** 0-100. Højere = flere træk, som mange forbinder med AI. Ikke en sandsynlighed. */
  score: number;
  niveau: MaskinNiveau;
  niveauLabel: string;
  rytme: {
    saetninger: number;
    medianSaetning: number;
    variation: number;
    afsnitVariation: number;
    andelUnder10: number;
    andelUnder7: number;
  };
  rytmeFund: RytmeFund[];
  flags: TellFlag[];
  /** For få ord til at rytme-målene siger noget. Så vises kun punktfund. */
  forKort: boolean;
};

// ── Tærskler ────────────────────────────────────────────────────────────────────────────
// GRUNDFORMEN er 1.712 artikler af 204 danske fagjournalister (Gode Datas Akademikerbladet-
// scrape), IKKE ét menneskes skriveri. Første udgave var kalibreret på én skribent alene; målt
// mod de 204 var tre af fire tærskler for stramme og ville have flaget almindelig dansk
// journalistik. Gode Ord bruges af redaktioner – grundformen skal være mange skribenter.
//
// Alle tal er målt med DENNE fils egen pipeline (citater fjernet), aldrig med et sidescript.
//   node scripts/grundform.mjs   → fordelingen på tværs af de 204 (og pr. forfatter)
//   node scripts/maskinsprog-validering.mjs --kalibrer  → samme for den ene skribents delmængde
const MIN_ORD_TIL_RYTME = 120;
// Variationskoefficienten er ustabil i korte tekster. I stedet for at slå fundet fra
// (så korte maskintekster slap igennem) kræver vi en KRAFTIGERE afvigelse, når stikprøven
// er lille. Tærsklen strammes først, når der er nok sætninger til at tro på tallet.
const MIN_SAET_TIL_VARIATION = 8;
const SAET_TIL_FULD_TAERSKEL = 15;
const KORT_TEKST_FAKTOR = 0.75;
// Grundform (204 forfattere): p01 0,35 · p05 0,40 · median 0,54. Bemærkelsesværdigt stabil —
// pr. forfatter ligger medianen mellem 0,49 og 0,60. Burstiness er altså ikke en personlig
// manér, men et træk ved dansk fagjournalistik som sådan. Tærsklen er sat på 1.-percentilen.
const VARIATION_MIN = 0.35;
// Grundform: p01 0,24 · p02 0,29 · p05 0,34. (Var 0,30 = p02 – for stramt.)
const AFSNIT_VARIATION_MIN = 0.26;
// Grundform: p02 0,03 · p05 0,06 · p10 0,08. (Var 0,10 ≈ p12 – flagede hver ottende
// rigtige artikel.) Det er det mest personlige af målene: pr. forfatter 13-31 %.
const ANDEL_UNDER_10_MIN = 0.06;
// Grundform: p90 22 · p95 23 · p99 27 · max 31. (Var 22 = p90 – flagede hver tiende.)
const MEDIAN_MAX = 26;
const TRICOLON_PR_1000_MAX = 3; // én skribent: 1,4

// "Andel under 7 ord" er MÅLT UBRUGELIG som selvstændigt fund: 5 % af rigtige artikler har
// nul korte sætninger. Rådet lever videre i beskeden til "for få korte sætninger".

/** Gradueret vægt: marginalt under tærsklen vejer lidt, langt under vejer meget. */
function graderet(maalt: number, taerskel: number, min: number, max: number): number {
  const afstand = Math.min(1, (taerskel - maalt) / (taerskel * 0.5));
  return Math.round(min + (max - min) * Math.max(0, afstand));
}

// Ord/vendinger med NUL forekomster i 90.000 ord. Se SKRIVESTIL.md 3c.
// Ord han selv bruger (samtidig, sikre, afgørende, ikke mindst, desuden, derudover,
// i sidste ende, med andre ord, yderligere, omfattende, først og fremmest, styrke,
// spændende) står bevidst IKKE her.
const AI_ORD: [string, string | undefined][] = [
  ["nøglen til", undefined],
  ["landskabet", undefined],
  ["kaste lys over", "vise"],
  ["muliggøre", "gøre mulig"],
  ["muliggør", "gør det muligt at"],
  ["holistisk", "helhedsorienteret"],
  ["banebrydende", undefined],
  ["transformere", "forandre"],
  ["gamechanger", undefined],
  ["vidner om", "viser"],
  ["spiller en central rolle", "er vigtig"],
  ["i hjertet af", "midt i"],
  ["forankre", undefined],
  ["favne", "rumme"],
  ["essentiel", "nødvendig"],
  ["essentielt", "nødvendigt"],
  ["fundamentalt set", undefined],
  ["i en verden hvor", undefined],
  ["i en verden, hvor", undefined],
  ["i en tid hvor", undefined],
  ["i en tid, hvor", undefined],
  ["endvidere", "desuden"],
  ["når alt kommer til alt", undefined],
  ["tænke ud af boksen", undefined],
  ["løfte i flok", undefined],
  ["i øjenhøjde", undefined],
  ["sætte fokus på", "se på"],
  ["værdiskabende", undefined],
  ["det er værd at bemærke, at", undefined],
  ["det er vigtigt at understrege, at", undefined],
  ["markerer et vendepunkt", undefined],
  ["i takt med at", "efterhånden som"],
];

// Vage kilder – påstanden har ingen adresse.
const VAGE_KILDER = [
  "eksperter mener",
  "eksperter peger på",
  "flere undersøgelser viser",
  "forskning viser",
  "studier viser",
  "det er almindeligt kendt",
  "mange mener",
  "man kan argumentere for",
  "det siges",
  "kritikere hævder",
  "iagttagere peger på",
];

// Negativ parallelisme – nul forekomster i korpus. Klassisk maskinfigur.
const NEGATIV_PARALLELISME: [RegExp, string][] = [
  [/(handler|drejer\s+det\s+sig|går\s+det)\s+ikke\s+om\b[^.!?]{1,70}?,?\s+men\s+om\b/giu, "«handler ikke om X, men om Y»"],
  [/\bikke\s+bare\b[^.!?]{1,70}?\bmen\s+også\b/giu, "«ikke bare X, men også Y»"],
  [/\bikke\s+blot\b[^.!?]{1,70}?\bmen\s+også\b/giu, "«ikke blot X, men også Y»"],
  [/\bdet\s+er\s+ikke\b[^.!?]{1,50}?\.\s+Det\s+er\b/gu, "«Det er ikke X. Det er Y.»"],
  [/\ber\s+ikke\b[^.!?]{1,40}?\s+–\s+(det|den|de)\s+er\b/giu, "«X er ikke Y – X er Z»"],
];

const FORMEL_AFSLUTNING: [RegExp, string][] = [
  [/(^|\n)\s*(Kort\s+sagt|I\s+sidste\s+ende|Alt\s+i\s+alt|Sammenfattende|Afslutningsvis)\b[^.!?\n]{0,80}[,.]/giu, "opsummerende formel-afslutning"],
  [/(^|\n)\s*Trods\s+(disse\s+)?(udfordringer|forhindringer)\b/giu, "«Trods udfordringerne …»"],
  [/\bog\s+det\s+er\s+præcis\s+derfor\b/giu, "«og det er præcis derfor»"],
];

const EMOJI_PUNKT = /^[ \t]*(?:[-*+][ \t]*)?[\u2705\u2714\u274C\u2B50\u{1F680}\u{1F511}\u{1F4A1}\u{1F449}\u{1F525}\u{1F4CC}\u{1F3AF}\u{1F4C8}]/gmu;

// ── Hjælpere ────────────────────────────────────────────────────────────────────────────

function ordAntal(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Variationskoefficient (sd/gns) – burstiness. Lav værdi = maskinel ensartethed. */
function variationskoefficient(a: number[]): number {
  if (a.length < 2) return 1;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  if (m === 0) return 1;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
  return sd / m;
}

/** Fjerner citatblokke, så et langt ordret citat ikke trækker rytmen skæv. */
function udenCitater(text: string, ranges: Range[]): string {
  if (!ranges.length) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let ud = "";
  let pos = 0;
  for (const [s, e] of sorted) {
    if (s < pos) continue;
    ud += text.slice(pos, s);
    pos = e;
  }
  return ud + text.slice(pos);
}

function addRegex(
  text: string,
  re: RegExp,
  kind: TellKind,
  message: string,
  ranges: Range[],
  flags: TellFlag[],
  canRemove = false,
  replacement?: string,
): void {
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    if (m[0].length === 0) {
      rx.lastIndex++;
      continue;
    }
    flags.push({
      kind,
      offset: m.index,
      length: m[0].length,
      quote: m[0].length > 90 ? m[0].slice(0, 90) + "…" : m[0],
      message,
      inQuote: inQuote(m.index, ranges),
      canRemove,
      replacement,
    });
  }
}

function addFrase(
  text: string,
  frase: string,
  kind: TellKind,
  message: string,
  ranges: Range[],
  flags: TellFlag[],
  replacement?: string,
): void {
  const esc = frase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Unicode-sikker ordgrænse – \b tæller ikke æøå som word-chars uden /u.
  const re = new RegExp(`(?<!\\p{L})${esc}(?!\\p{L})`, "giu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    flags.push({
      kind,
      offset: m.index,
      length: m[0].length,
      quote: m[0],
      message,
      inQuote: inQuote(m.index, ranges),
      canRemove: replacement === undefined && kind === "ai-ord" ? false : false,
      replacement,
    });
  }
}

/** Ser en markdown-overskrift ud til at være Title Case? Dansk bruger sentence case. */
function erTitleCase(linje: string): boolean {
  const uden = linje.replace(/^#{1,6}\s+/, "").trim();
  const ord = uden.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (ord.length < 3) return false;
  // Ignorér første ord (skal være stort) og korte funktionsord.
  const kandidater = ord.slice(1).filter((w) => w.replace(/[^\p{L}]/gu, "").length > 3);
  if (kandidater.length < 2) return false;
  const store = kandidater.filter((w) => /^\p{Lu}/u.test(w));
  return store.length >= Math.max(2, Math.ceil(kandidater.length * 0.6));
}

// ── Analysen ────────────────────────────────────────────────────────────────────────────

export function analyzeAiTells(text: string): AiReport {
  const ranges = quoteRanges(text);
  const flags: TellFlag[] = [];

  // ── Mekanik ──
  addRegex(text, /—/gu, "em-dash", "Em-dash (—) findes ikke i dansk typografi. Brug – med mellemrum om.", ranges, flags, false, " – ");
  addRegex(text, /(?<=\S);/gu, "semikolon", "Semikolon – sæt punktum. Det er sjældent i levende dansk.", ranges, flags);
  addRegex(text, /\b\d{1,3},\d{3}(?!\d)/gu, "tusindtal", "Dansk bruger punktum som tusindtalsseparator (1.402), komma som decimal.", ranges, flags);
  addRegex(text, EMOJI_PUNKT, "emoji-punkt", "Emoji som punkttegn – et af de mest genkendte AI-træk.", ranges, flags, true);
  addRegex(text, /^[ \t]*[-*+][ \t]+\*\*[^*\n]{2,40}\*\*\s*:/gmu, "fed-punkt", "«**Fed indledning**: forklaring» – punktopstillingen der råber AI. Skriv punktet som sætning.", ranges, flags);

  // ── Overskrifter i Title Case ──
  const overskrift = /^#{1,6}[ \t]+.+$/gmu;
  let h: RegExpExecArray | null;
  while ((h = overskrift.exec(text)) !== null) {
    if (erTitleCase(h[0])) {
      flags.push({
        kind: "title-case",
        offset: h.index,
        length: h[0].length,
        quote: h[0].length > 90 ? h[0].slice(0, 90) + "…" : h[0],
        message: "Overskriften ser ud til at være Title Case. Dansk bruger sentence case – kun første ord stort.",
        inQuote: false,
        canRemove: false,
      });
    }
  }

  // ── Syntaks-figurer ──
  for (const [re, navn] of NEGATIV_PARALLELISME)
    addRegex(text, re, "negativ-parallelisme", `Negativ parallelisme ${navn} – nul forekomster i korpus. Sig bare det, du mener.`, ranges, flags);
  for (const [re, navn] of FORMEL_AFSLUTNING)
    addRegex(text, re, "formel-afslutning", `Formel-afslutning ${navn} – slut på det sidste rigtige, du har at sige.`, ranges, flags);
  addRegex(text, /\bpå\s+den\s+ene\s+side\b[^.!?]{0,200}?\bpå\s+den\s+anden\s+side\b/giu, "tvangsbalance", "Tvangsbalance – har du en holdning, så skriv den.", ranges, flags);
  addRegex(text, /(^|[.!?]\s+)Ved\s+at\s+\p{Ll}+[^,.!?]{0,60},\s/gu, "deltager-optakt", "«Ved at gøre X, …» – sæt hvem der gør hvad forrest.", ranges, flags);

  // ── Ordforråd ──
  for (const [ord, repl] of AI_ORD)
    addFrase(text, ord, "ai-ord", `«${ord}» står nul gange i 90.000 ord af dit eget.${repl ? ` Prøv “${repl}”.` : ""}`, ranges, flags, repl);
  for (const k of VAGE_KILDER)
    addFrase(text, k, "vag-kilde", "Vag kilde – hvem, hvornår, hvor? Navn og årstal, ellers ud.", ranges, flags);

  // ── Rytme (uden citater) ──
  const brød = udenCitater(text, ranges);
  const afsnit = brød
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^[#>\s*\-+\d.]+/, "").trim())
    .filter((p) => ordAntal(p) >= 5);
  const flad = afsnit.join(" ");
  const totalOrd = ordAntal(flad);
  const saetLaengder = flad
    .split(/(?<=[.!?])\s+/u)
    .map(ordAntal)
    .filter((n) => n > 0);

  const forKort = totalOrd < MIN_ORD_TIL_RYTME || saetLaengder.length < 6;
  const variation = variationskoefficient(saetLaengder);
  const afsnitVariation = variationskoefficient(afsnit.map(ordAntal));
  const medSaet = median(saetLaengder);
  const andelUnder10 = saetLaengder.length ? saetLaengder.filter((n) => n < 10).length / saetLaengder.length : 0;
  const andelUnder7 = saetLaengder.length ? saetLaengder.filter((n) => n < 7).length / saetLaengder.length : 0;

  const rytmeFund: RytmeFund[] = [];
  if (!forKort) {
    const variationMin =
      saetLaengder.length >= SAET_TIL_FULD_TAERSKEL ? VARIATION_MIN : VARIATION_MIN * KORT_TEKST_FAKTOR;
    if (variation < variationMin && saetLaengder.length >= MIN_SAET_TIL_VARIATION)
      rytmeFund.push({
        id: "variation",
        navn: "Ensartet kadence",
        maalt: variation.toFixed(2),
        maal: `over ${variationMin.toFixed(2)}`,
        besked:
          "Sætningerne er næsten lige lange. Det er det enkelttræk, flest genkender som maskinskrevet, og det der overlever flest omskrivninger. Bryd det med en meget kort sætning.",
        vaegt: graderet(variation, variationMin, 20, 50),
      });
    if (afsnitVariation < AFSNIT_VARIATION_MIN && afsnit.length >= 5)
      rytmeFund.push({
        id: "afsnit-variation",
        navn: "Ensartede afsnit",
        maalt: afsnitVariation.toFixed(2),
        maal: `over ${AFSNIT_VARIATION_MIN.toFixed(2)}`,
        besked: "Alle afsnit er lige lange. Lad ét fylde dobbelt så meget som de andre.",
        vaegt: graderet(afsnitVariation, AFSNIT_VARIATION_MIN, 6, 14),
      });
    if (andelUnder10 < ANDEL_UNDER_10_MIN)
      rytmeFund.push({
        id: "korte",
        navn: "For få korte sætninger",
        maalt: `${Math.round(andelUnder10 * 100)} %`,
        maal: `mindst ${Math.round(ANDEL_UNDER_10_MIN * 100)} %`,
        besked:
          andelUnder7 === 0
            ? "Ikke én sætning under 7 ord. En på fire-fem ord lander en pointe, resten forklarer den."
            : "Cirka hver fjerde sætning bør være under 10 ord. Ellers får teksten ingen puls.",
        vaegt: graderet(andelUnder10, ANDEL_UNDER_10_MIN, 8, 20),
      });
    if (medSaet > MEDIAN_MAX)
      rytmeFund.push({
        id: "tunge",
        navn: "Tunge sætninger hele vejen",
        maalt: `${medSaet} ord`,
        maal: `højst ${MEDIAN_MAX} ord`,
        besked: "Median-sætningen er lang. I dansk fagjournalistik er den 17 ord.",
        vaegt: 10,
      });
  }

  // ── Tricolon: kun ved overtæthed (to-tre stykker er normalt dansk) ──
  const triRe = /(?<!\p{L})\p{L}{3,},\s+\p{L}{3,},?\s+og\s+\p{L}{3,}(?!\p{L})/giu;
  const triFund: RegExpExecArray[] = [];
  let t: RegExpExecArray | null;
  while ((t = triRe.exec(brød)) !== null) triFund.push(t);
  const triPr1000 = totalOrd ? (triFund.length / totalOrd) * 1000 : 0;
  if (triPr1000 > TRICOLON_PR_1000_MAX && triFund.length >= 3) {
    // Flag dem i den fulde tekst, så offsets passer til editoren.
    addRegex(
      text,
      triRe,
      "tricolon",
      `Tre-leddede opremsninger ${triPr1000.toFixed(1)} pr. 1.000 ord. To led er ofte nok.`,
      ranges,
      flags,
    );
  }

  // ── Score ──
  const synlige = flags.filter((f) => !f.inQuote);
  let score = rytmeFund.reduce((s, f) => s + f.vaegt, 0);
  const vaegtPrKind: Record<TellKind, number> = {
    "em-dash": 6,
    semikolon: 3,
    "negativ-parallelisme": 8,
    tricolon: 2,
    "formel-afslutning": 5,
    "ai-ord": 4,
    "title-case": 5,
    "emoji-punkt": 4,
    "fed-punkt": 6,
    tusindtal: 3,
    "vag-kilde": 3,
    "deltager-optakt": 3,
    tvangsbalance: 4,
  };
  // Aftagende udbytte pr. type: første fund vejer fuldt, næste det halve, osv.
  const perKind = new Map<TellKind, number>();
  for (const f of synlige) perKind.set(f.kind, (perKind.get(f.kind) ?? 0) + 1);
  for (const [kind, n] of perKind) {
    const v = vaegtPrKind[kind];
    for (let i = 0; i < n; i++) score += v / (i + 1);
  }
  score = Math.min(100, Math.round(score));

  const niveau: MaskinNiveau = score >= 45 ? "maskinelt" : score >= 20 ? "enkelte-maskintraek" : "menneskeligt";
  const niveauLabel =
    niveau === "maskinelt"
      ? "Lyder maskinskrevet"
      : niveau === "enkelte-maskintraek"
        ? "Enkelte maskintræk"
        : "Lyder menneskeligt";

  flags.sort((a, b) => a.offset - b.offset);
  return {
    score,
    niveau,
    niveauLabel,
    rytme: {
      saetninger: saetLaengder.length,
      medianSaetning: medSaet,
      variation: Number(variation.toFixed(2)),
      afsnitVariation: Number(afsnitVariation.toFixed(2)),
      andelUnder10: Number(andelUnder10.toFixed(3)),
      andelUnder7: Number(andelUnder7.toFixed(3)),
    },
    rytmeFund,
    flags,
    forKort,
  };
}
