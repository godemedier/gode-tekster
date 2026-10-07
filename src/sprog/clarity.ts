// KOPI af gode-ord/src/lib/clarity.ts @ ebee85f 2026-10-07. Ret i Gode Ord, ikke her, og kør scripts/sprog.mjs.
// Klarheds-analyse (Hemingway-agtig, dansk). DETERMINISTISK – ingen service, ingen nøgle,
// instant (kan køre klient-side). Måler læsbarhed (LIX) + flager tunge sætninger, passiv,
// nominaliseringer, floskler og fyldord. Forslag, ikke autokorrektur. Citat-bevidst.
// Floskel/fyldord-listerne er en STARTER – udvides med dansk kliché-research (næste skridt).

import { quoteRanges, inQuote, type Range } from "./quotes.ts";

export type ClarityKind =
  | "lang"
  | "meget-lang"
  | "passiv"
  | "nominalisering"
  | "floskel"
  | "fyldord"
  | "omstaendeligt"
  | "svagt-anslag"
  | "vis-ikke-fortael"
  | "ladet-attribution"
  | "fremmedord"
  | "upraecis-maengde"
  | "tung-optakt"
  | "adverbier"
  | "gentagelse";

export type ClarityFlag = {
  kind: ClarityKind;
  offset: number;
  length: number;
  quote: string;
  message: string;
  inQuote: boolean;
  /** Kan fjernes med ét klik (floskel/fyldord – struktur-flag kræver omskrivning). */
  canRemove: boolean;
  /** Enklere alternativ til ét-kliks-swap (kun "omstaendeligt"). */
  replacement?: string;
};

export type ClarityReport = {
  lix: number;
  lixLabel: string;
  words: number;
  sentences: number;
  flags: ClarityFlag[];
};

const LANG = 25;
const MEGET_LANG = 40;

// Klichéer/floskler (fraser). Nedslidte – sig det konkret i stedet. Kilder: DR's stilguide,
// Dansk Sprognævn, journalistik-guides (research 2026-07-18). Kan udvides.
const FLOSKLER = [
  "i den forbindelse",
  "på nuværende tidspunkt",
  "det er vigtigt at understrege",
  "det er værd at bemærke",
  "når alt kommer til alt",
  "i sidste ende",
  "når dagen er omme",
  "for at gøre en lang historie kort",
  "det korte af det lange",
  "som bekendt",
  "sagen er den",
  "alt andet lige",
  "tænke ud af boksen",
  "løfte i flok",
  "lavthængende frugter",
  "i øjenhøjde",
  "gå forrest",
  "sætte fokus på",
  "spille en central rolle",
  "kun tiden vil vise",
  "ligge i kortene",
  "sende et signal",
  "på tegnebrættet",
  "rykke tættere på",
  "en kærkommen lejlighed",
  "med livet som indsats",
  "kaste lys over",
  "sætte tingene i perspektiv",
  "værdiskabende",
  "proaktiv",
  "helhedsorienteret",
  "brænder for",
];
// Fyldord / tomme forstærkere + hedges. Ofte overflødige.
const FYLDORD = [
  "faktisk",
  "egentlig",
  "sådan set",
  "på en måde",
  "på sin vis",
  "i og for sig",
  "virkelig",
  "temmelig",
  "rimelig",
  "alt i alt",
  "som sagt",
  "ligesom",
  "en form for",
  "en slags",
  "i bund og grund",
  "sådan lidt",
];
// Omstændelige kancelli-fraser → enklere alternativ (ét-kliks-swap; tjek konteksten).
// Kancellisprog = hovedfjenden i klart dansk (Dansk Sprognævn). [frase, enklere].
const OMSTAENDELIGE: [string, string][] = [
  ["med henblik på", "for at"],
  ["i forbindelse med", "ved"],
  ["på baggrund af", "efter"],
  ["med hensyn til", "om"],
  ["i overensstemmelse med", "efter"],
  ["med undtagelse af", "undtagen"],
  ["forud for", "før"],
  ["efterfølgende", "bagefter"],
  ["såfremt", "hvis"],
  ["vedrørende", "om"],
  ["angående", "om"],
  ["anvende", "bruge"],
  ["besidde", "have"],
  ["erhverve", "få"],
  ["påbegynde", "begynde"],
  ["bringe til ophør", "stoppe"],
  ["være af den opfattelse", "mene"],
  ["foretage en vurdering af", "vurdere"],
  ["i det tilfælde at", "hvis"],
  // Svage verbal-fraser → stærkt verbum (stærke, aktive verber; Meilby).
  ["gøre brug af", "bruge"],
  ["have mulighed for at", "kunne"],
  ["være i stand til at", "kunne"],
  ["tage udgangspunkt i", "bygge på"],
  ["give anledning til", "føre til"],
  ["bringe i anvendelse", "bruge"],
];
// Danske stopord – udelukkes fra gentagelses-tjek (kun indholdsord tæller).
const STOPORD = new Set(
  ("og i på af det en at er som til med for den de har var et om vi kan man vil skal ikke men eller også kun mere flere over under mod ved fra ud op ind han hun der her nu så jeg du sig sin hans hendes deres denne dette disse hvor hvad hvem hvilken være blive have gøre").split(
    " ",
  ),
);
// "Vis, fortæl ikke" (Line Vaaben, fortællende journalistik): evaluerende ord der FORTÆLLER
// læseren hvad de skal føle, i stedet for at VISE det med en detalje. Nudge – ikke fejl.
const VIS_IKKE_FORTAEL = [
  "utroligt",
  "utrolig",
  "fantastisk",
  "forfærdeligt",
  "forfærdelig",
  "chokerende",
  "rystende",
  "imponerende",
  "vildt",
  "helt vildt",
  "mega",
  "enormt",
  "vanvittigt",
  "grotesk",
  "hjerteskærende",
];
// Ladede attributionsverber – de vurderer kilden. Journalistisk håndværk: gengiv neutralt
// (siger/sagde), lad indholdet tale. Nudge.
const LADEDE_ATTRIBUTION = [
  "understregede",
  "understreger",
  "påpegede",
  "påpeger",
  "indrømmede",
  "indrømmer",
  "hævdede",
  "hævder",
  "pointerede",
  "fastslog",
  "fastslår",
  "erklærede",
  "afslørede",
  "afslører",
  "betonede",
  "medgav",
  "vedgik",
];
// Upræcise mængder – "hvor mange præcist?". Nudge (kun de tydeligt vage).
const UPRAECISE_MAENGDER = [
  "en række",
  "adskillige",
  "utallige",
  "talrige",
  "masser af",
  "en stor del",
  "en del",
  "en håndfuld",
];
// Fremmedord med et gangbart dansk alternativ → ét-kliks-swap (tjek konteksten). [ord, dansk].
const FREMMEDORD: [string, string][] = [
  ["implementere", "gennemføre"],
  ["implementering", "gennemførelse"],
  ["facilitere", "understøtte"],
  ["deadline", "frist"],
  ["mindset", "tankegang"],
  ["commitment", "engagement"],
  ["location", "sted"],
  ["update", "opdatering"],
  ["timing", "tidspunkt"],
  ["feedback", "tilbagemelding"],
  ["approach", "tilgang"],
  ["issue", "problem"],
];
// Døde billedklichéer (metaforer). Sig det ligeud eller find et friskt billede.
const BILLEDKLICHEER = [
  "en tikkende bombe",
  "toppen af isbjerget",
  "kaste grus i maskineriet",
  "en varm kartoffel",
  "op ad bakke",
  "i medvind",
  "i modvind",
  "gå amok",
  "en storm i et glas vand",
  "en dråbe i havet",
  "bide i det sure æble",
  "stå med håret i postkassen",
  "tage tyren ved hornene",
  "lægge kortene på bordet",
  "en gordisk knude",
  "koste det hvide ud af øjnene",
  "på bar bund",
  "sætte tingene på spidsen",
];

/** Forkortelser, der aldrig slutter en sætning (»f.eks.«, »kl. 10«). Små bogstaver, uden sidste punktum. */
const ABBREVIATIONS = new Set([
  "f.eks", "fx", "bl.a", "ca", "jf", "dvs", "pga", "kl", "pr", "mht", "evt", "hhv", "inkl", "ekskl",
  "ift", "iht", "ifm", "vedr", "stk", "nr", "s", "hr", "fr", "dr", "prof", "tlf", "mm", "cm", "km",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "okt", "nov", "dec", "e.l", "o.l",
]);
/** Forkortelser, der ofte står sidst i en sætning: de slutter den, hvis et stort bogstav følger. */
const ABBREVIATIONS_AT_END = new Set(["kr", "mio", "mia", "mill", "pct", "osv", "mv", "m.m", "m.fl", "o.l", "e.l"]);

/**
 * Offset-bevarende sætningsdeling. Et punktum slutter kun en sætning, når der følger mellemrum og
 * et stort bogstav, et tal, et citattegn eller tekstens slutning, og ikke efter en forkortelse
 * (»f.eks.«, »bl.a.«). Tal med punktum (»2.500«, »1. maj«) og »hvad?« sagde hun« deler ikke.
 * Linjeskift slutter altid. Før delte den ved hvert punktum, så LIX blev for lav (2/10-2026).
 */
function splitSentences(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t) out.push({ text: t, start: start + lead });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      push(i);
      start = i + 1;
      continue;
    }
    if (c !== "." && c !== "!" && c !== "?") continue;
    // Tegnsætning og citattegn lige efter hører med til sætningen.
    let j = i;
    while (j + 1 < text.length && /[.!?»«"”')\]]/.test(text[j + 1])) j++;
    const after = text[j + 1];
    if (after !== undefined && !/\s/.test(after)) continue; // »2.500«, »f.eks« midt i ordet
    const next = /^\s*(\S)/.exec(text.slice(j + 1))?.[1];
    if (next && /\p{Ll}/u.test(next)) {
      i = j;
      continue; // lille bogstav bagefter: forkortelse eller »hvad?« sagde hun
    }
    if (c === ".") {
      // Forkortelser skrives med små bogstaver: »DR.« (Danmarks Radio) er ikke »dr.« (doktor).
      const raw = /([\p{L}.]+)$/u.exec(text.slice(Math.max(0, i - 12), i))?.[1] ?? "";
      const word = raw === raw.toLowerCase() || /^\p{Lu}\p{Ll}*$/u.test(raw) ? raw.toLowerCase() : "";
      const upper = next !== undefined && /\p{Lu}/u.test(next);
      if (ABBREVIATIONS.has(word) && !(upper && ABBREVIATIONS_AT_END.has(word))) {
        i = j;
        continue;
      }
      if (ABBREVIATIONS_AT_END.has(word) && !upper && next !== undefined) {
        i = j;
        continue;
      }
      if (/\d$/.test(text.slice(0, i)) && next !== undefined && /\d/.test(next)) {
        i = j;
        continue; // »kl. 10.30«-agtige tal
      }
    }
    push(j + 1);
    i = j;
  }
  push(text.length);
  return out;
}

/**
 * Det, der følger »blive« uden at være passiv: tillægsord (»blev træt«, »bliver umuligt«),
 * funktionsord (»bliver det«, »bliver noget«) og faste forbindelser (»bliver nødt«, »blev ved«).
 */
const NOT_PARTICIPLE = new Set([
  "det", "de", "at", "et", "mit", "dit", "sit", "noget", "intet", "alt", "hvad", "nødt", "ved", "til", "væk",
  "træt", "sent", "godt", "svært", "let", "slut", "stille", "klart", "mørkt", "lyst", "koldt", "varmt",
  "dyrt", "billigt", "stort", "småt", "hårdt", "tungt", "svagt", "stærkt", "sjovt", "nyt", "fast",
  "bedre", "værre", "større", "mindre", "længere", "kortere", "flere", "færre", "mere", "mest", "mindst",
  "glad", "ked", "syg", "rask", "vred", "bange", "sur", "klar", "færdig", "færdigt", "anderledes", "tilbage",
  "forkert", "rigtigt", "nødvendigt", "vigtigt", "muligt", "umuligt", "tydeligt", "nemt", "rart", "trist",
]);

/** Gradsord og kendeord mellem »blive« og et ord på -t: så er det et tillægs- eller navneord. */
const DEGREE = new Set(["mere", "mest", "meget", "så", "for", "helt", "lidt", "endnu", "ret", "ganske"]);
const DETERMINERS = new Set(["en", "et", "den", "de", "det", "nogen", "ingen", "min", "din", "sin", "vores", "jeres", "deres", "hans", "hendes"]);

function isParticiple(word: string): boolean {
  const w = word.toLowerCase();
  if (NOT_PARTICIPLE.has(w)) return false;
  // Tillægsord på -ig(t), -lig(t), -sk(t) og -som(t) er ikke kort tillægsform.
  if (/(igt|ligt|skt|sk|somt|ende)$/.test(w)) return false; // og lang tillægsform: »lignende«
  return /(et|t|de)$/.test(w);
}

/** Blive-passiv: blev/bliver/blevet (+ evt. ét ord) + kort tillægsform. */
function findPassive(sentence: string): { index: number; text: string } | null {
  for (const m of sentence.matchAll(/(?<!\p{L})(?:blev|bliver|blevet)(?!\p{L})/giu)) {
    const at = m.index ?? 0;
    const next = [...sentence.slice(at + m[0].length).matchAll(/\p{L}+/gu)].slice(0, 2);
    const [first, second] = next.map((w) => w[0]);
    const end = (w: RegExpMatchArray) => at + m[0].length + (w.index ?? 0) + w[0].length;
    if (!first) continue;
    // Direkte efter »blive«: »blev afvist«.
    if (isParticiple(first)) return { index: at, text: sentence.slice(at, end(next[0])) };
    // Med ét ord imellem: »blev hun mødt«, men ikke »bliver mere kompliceret« (gradsord), »blev en
    // lignende sag« (kendeord) eller »bliver umuligt at« (tillægsord).
    const middle = first.toLowerCase();
    if (second && isParticiple(second) && !DEGREE.has(middle) && !DETERMINERS.has(middle) && !NOT_PARTICIPLE.has(middle)) {
      return { index: at, text: sentence.slice(at, end(next[1])) };
    }
  }
  return null;
}

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

function label(lix: number): string {
  if (lix < 25) return "meget let";
  if (lix < 35) return "let";
  if (lix < 45) return "middel";
  if (lix < 55) return "svær";
  return "meget svær";
}

function addPhrase(
  text: string,
  phrase: string,
  kind: ClarityKind,
  message: string,
  ranges: Range[],
  flags: ClarityFlag[],
  wordBoundary: boolean,
  replacement?: string,
  nudgeOnly = false,
): void {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Unicode-sikker ordgrænse: \b tæller IKKE æøå som word-chars uden /u → brug \p{L}-lookarounds.
  const re = new RegExp(wordBoundary ? `(?<!\\p{L})${esc}(?!\\p{L})` : esc, "giu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    flags.push({
      kind,
      offset: m.index,
      length: m[0].length,
      quote: m[0],
      message,
      inQuote: inQuote(m.index, ranges),
      // fjern (floskel/fyldord) · swap (omstændeligt/fremmedord) · nudge (attribution/mængde)
      canRemove: nudgeOnly ? false : replacement === undefined,
      replacement,
    });
  }
}

export function analyzeClarity(text: string): ClarityReport {
  const ranges = quoteRanges(text);
  const sentences = splitSentences(text);
  const flags: ClarityFlag[] = [];
  let totalWords = 0;
  let longWords = 0;

  for (const s of sentences) {
    const w = words(s.text);
    totalWords += w.length;
    longWords += w.filter((x) => x.replace(/[^\p{L}]/gu, "").length > 6).length;

    if (w.length >= MEGET_LANG) {
      flags.push(sentenceFlag("meget-lang", s, `Meget lang sætning (${w.length} ord) – del den for læsbarhed.`, ranges));
    } else if (w.length >= LANG) {
      flags.push(sentenceFlag("lang", s, `Lang sætning (${w.length} ord) – kan den deles?`, ranges));
    }

    // Passiv (blive-passiv): blev/bliver/blevet (+ evt. adverbium) + participium.
    const pass = findPassive(s.text);
    if (pass) {
      flags.push(spanFlag("passiv", s.start + pass.index, pass.text, "Passiv – hvem gør det? Aktiv er ofte klarere.", ranges));
    }

    // Tunge/abstrakte navneord: nominaliseringer (-ning/-else/-tion/-ering) + abstraktions-
    // endelser (-hed/-itet/-isme). "Konkret frem for abstrakt" (Meilby/Vaaben).
    // Tillad bøjnings-/definit-endelser (ordningEN, implementeringEN, mulighedER).
    const noms = s.text.match(/\b\p{L}+(ning|else|tion|ering|hed|itet|isme)(en|er|erne|s)?\b/giu);
    if (noms && noms.length >= 3) {
      flags.push(sentenceFlag("nominalisering", s, `Mange tunge/abstrakte navneord (${noms.length}) – gør det konkret; kan nogle blive udsagnsord?`, ranges));
    }

    // Svagt anslag: sætning der åbner med "Der/Det er/var …" (udfyldnings-konstruktion).
    // Stærke verber + hvem-gør-hvad er klarere (journalistisk håndværk).
    const anslag = s.text.match(/^(der|det)\s+(er|var|bliver|blev|findes|fandtes)\b/i);
    if (anslag) {
      flags.push(spanFlag("svagt-anslag", s.start, anslag[0], "Svagt anslag – start hellere med hvem der gør hvad (stærkt verbum).", ranges));
    }

    // Tung optakt: lang foranstillet ledsætning før hovedsætningen (Meilbys "syntetiske"
    // sætning – pointen kommer for sent). Kom hurtigere til hvem-gør-hvad.
    const sub = s.text.match(/^(da|fordi|selvom|selv om|hvis|mens|efter at|inden|idet|eftersom|når|såfremt)\b/i);
    if (sub) {
      const comma = s.text.indexOf(",");
      if (comma >= 45) {
        flags.push(sentenceFlag("tung-optakt", s, `Tung optakt (${comma} tegn før hovedsætningen) – kom hurtigere til hvem der gør hvad.`, ranges));
      }
    }

    // Adverbie-tæthed (-ligt/-mæssigt): Hemingway – kan verbet bære betydningen?
    const advs = s.text.match(/\b\p{L}+(ligt|mæssigt)\b/giu);
    if (advs && advs.length >= 2) {
      flags.push(sentenceFlag("adverbier", s, `Mange adverbier (${advs.length}: ${[...new Set(advs)].slice(0, 3).join(", ")}) – kan verberne bære betydningen?`, ranges));
    }

    // Ordgentagelse inden for sætningen (kun indholdsord ≥5 bogstaver). Flag 2. forekomst.
    const count = new Map<string, number>();
    const wre = /\p{L}{5,}/gu;
    let wm: RegExpExecArray | null;
    while ((wm = wre.exec(s.text)) !== null) {
      const norm = wm[0].toLowerCase();
      if (STOPORD.has(norm)) continue;
      const c = (count.get(norm) ?? 0) + 1;
      count.set(norm, c);
      if (c === 2) {
        flags.push(spanFlag("gentagelse", s.start + wm.index, wm[0], `Gentagelse – “${wm[0]}” igen i samme sætning; varier?`, ranges));
      }
    }
  }

  for (const f of FLOSKLER) addPhrase(text, f, "floskel", "Kliché/floskel – sig det konkret.", ranges, flags, true);
  for (const f of FYLDORD) addPhrase(text, f, "fyldord", "Fyldord – ofte overflødigt.", ranges, flags, true);
  for (const [phrase, repl] of OMSTAENDELIGE)
    addPhrase(text, phrase, "omstaendeligt", `Omstændeligt – prøv “${repl}” (tjek konteksten).`, ranges, flags, true, repl);
  for (const f of VIS_IKKE_FORTAEL)
    addPhrase(text, f, "vis-ikke-fortael", "Fortæller læseren hvad de skal føle – vis det med en konkret detalje.", ranges, flags, true);
  for (const f of LADEDE_ATTRIBUTION)
    addPhrase(text, f, "ladet-attribution", "Ladet attributionsverbum – gengiv neutralt (siger/sagde)?", ranges, flags, true, undefined, true);
  for (const f of UPRAECISE_MAENGDER)
    addPhrase(text, f, "upraecis-maengde", "Upræcis mængde – hvor mange præcist?", ranges, flags, true, undefined, true);
  for (const f of BILLEDKLICHEER)
    addPhrase(text, f, "floskel", "Dødt billede/kliché – sig det ligeud eller find et friskt billede.", ranges, flags, false);
  for (const [word, repl] of FREMMEDORD)
    addPhrase(text, word, "fremmedord", `Fremmedord – dansk: “${repl}”? (tjek konteksten)`, ranges, flags, true, repl);

  const lix =
    sentences.length && totalWords
      ? Math.round(totalWords / sentences.length + (longWords * 100) / totalWords)
      : 0;

  flags.sort((a, b) => a.offset - b.offset);
  return { lix, lixLabel: label(lix), words: totalWords, sentences: sentences.length, flags };
}

function sentenceFlag(
  kind: ClarityKind,
  s: { text: string; start: number },
  message: string,
  ranges: Range[],
): ClarityFlag {
  return {
    kind,
    offset: s.start,
    length: s.text.length,
    quote: s.text.length > 90 ? s.text.slice(0, 90) + "…" : s.text,
    message,
    inQuote: inQuote(s.start, ranges),
    canRemove: false,
  };
}

function spanFlag(kind: ClarityKind, offset: number, quote: string, message: string, ranges: Range[]): ClarityFlag {
  return { kind, offset, length: quote.length, quote, message, inQuote: inQuote(offset, ranges), canRemove: false };
}
