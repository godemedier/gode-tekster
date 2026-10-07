// Dansk grammatik mens man skriver, uden AI og uden net (7/10, fra sammenligningen med Grammarly).
// Kun regler, der næsten aldrig tager fejl, fordi en falsk rettelse er værre end ingen:
//
//   1. Navnemåde efter »at« og mådesudsagnsord: »at lærer« → »at lære«, »kan er« → »kan være«.
//   2. Nutid efter jeg, du, han, hun, vi og man: »vi lære« → »vi lærer«. Ikke ved omvendt
//      ordstilling (»kan vi lære«, »lod han være«), hvor navnemåden er rigtig.
//   3. Dobbelte småord: »og og«, »med med«.
//
// Udsagnsordene kommer fra ordklasselisten (UD Danish-DDT), hvor ca. 300 står i både navnemåde og
// nutid. Prøvet 7/10 på 126 artikler fra et fagblad: hvert fund gennemgået, de falske fjernet med
// undtagelserne nedenfor. Kommaer er udeladt (startkomma er valgfrit efter Dansk Sprognævn), og
// kongruens kræver køn på navneordene, som listen ikke har. Tekst i citater markeres ikke.

import { inQuote, quoteRanges } from "../sprog/quotes.ts";

export type GrammarFlag = { from: number; to: number; kind: string; message: string; replacement: string };

const MODALS = new Set(["kan", "kunne", "skal", "skulle", "vil", "ville", "må", "måtte", "bør", "burde", "tør", "turde", "gider", "gad"]);
const PRONOUNS = new Set(["jeg", "du", "han", "hun", "vi", "man"]);
/** Uregelmæssige par: nutid → navnemåde. »ved« er udeladt: efter »kunne« er det oftest et forholdsord. */
const IRREGULAR: Record<string, string> = { har: "have", er: "være", gør: "gøre" };
const PRESENT_OF: Record<string, string> = { have: "har", være: "er", gøre: "gør", vide: "ved" };
/** Navneord, der staves som et udsagnsord i nutid. Efter »at« som bindeord kan de være rigtige. */
const AGENT_NOUNS = new Set([
  "lærer", "maler", "sælger", "køber", "læser", "skriver", "leder", "ejer", "spiller", "løber",
  "ryger", "bager", "tegner", "taler", "forsker", "kører", "hjælper", "vinder", "taber", "arbejder", "ønsker",
]);
/** Ord, der også er noget andet end et udsagnsord i navnemåde: »jeg få dage« (få = ikke mange). */
const NOT_INFINITIVE = new Set(["få", "stille"]);
/** Grundled efter et udsagnsord: »at søger man …« er en betingelse, ikke en fejl. */
const SUBJECTS = new Set(["jeg", "du", "han", "hun", "vi", "man", "de", "den", "det", "der", "i"]);
/** Gentagne forholdsord kan være rigtige (»på på kort sigt«, »stod i i slutningen«), så kun disse. */
const DOUBLES = new Set(["og", "med", "en", "et", "at", "som", "af"]);

type Word = { text: string; low: string; from: number; to: number };

/** Følg store bogstaver: »Lære« bliver til »Lærer«, ikke »lærer«. */
function keepCase(original: string, next: string): string {
  if (!next) return next;
  return original[0] === original[0].toUpperCase() ? next[0].toUpperCase() + next.slice(1) : next;
}

/** `agree` og `adjs` er kongruensdata og tillægsord. Uden dem springes kongruensen over. */
/** `comma`: "start" (med startkomma, standard), "uden" (uden startkomma) eller "fra" (intet kommatjek). */
export function grammarFlags(
  text: string,
  verbs: ReadonlySet<string>,
  agree?: Agreement,
  adjs?: ReadonlySet<string>,
  nounSet?: ReadonlySet<string>,
  comma = "start",
  advs?: ReadonlySet<string>,
): GrammarFlag[] {
  adjectives = adjs ?? new Set();
  nouns = nounSet ?? new Set();
  const words: Word[] = [];
  for (const m of text.matchAll(/\p{L}+(?:-\p{L}+)*/gu)) {
    const from = m.index ?? 0;
    words.push({ text: m[0], low: m[0].toLowerCase(), from, to: from + m[0].length });
  }
  // To ord hænger kun sammen, hvis der er mellemrum imellem: intet punktum, komma eller linjeskift.
  const joined = (a: Word, b: Word) => /^[ \t]+$/.test(text.slice(a.to, b.from));
  // Et ord med stort begyndelsesbogstav midt i en sætning er et navn (»Povl Gad er«), ikke »gad«.
  const isName = (w: Word) => w.text[0] !== w.low[0] && !/(^|[.!?:»«"”\n]\s*)$/.test(text.slice(Math.max(0, w.from - 3), w.from));
  const quotes = quoteRanges(text);
  const out: GrammarFlag[] = [];
  const flag = (w: Word, kind: string, message: string, replacement: string) => {
    if (!inQuote(w.from, quotes)) out.push({ from: w.from, to: w.to, kind: `grammatik:${kind}`, message, replacement: keepCase(w.text, replacement) });
  };

  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const w = words[i];
    if (!joined(prev, w)) continue;

    // 3. Dobbelte småord. Ikke en endelse efter punktum eller apostrof (»ph.d.en en«, »AI’en en«).
    if (w.low === prev.low && DOUBLES.has(w.low) && !/[.’']/.test(text[prev.from - 1] ?? "")) {
      flag(w, "dobbelt", `»${prev.text}« står to gange.`, "");
      continue;
    }

    // 1. Navnemåde efter »at« og mådesudsagnsord. Efter »at« som bindeord kan der stå et navneord
    // (»at lærer og pædagog …«) eller et udsagnsord i en betingelse (»at søger man …«).
    const next = words[i + 1];
    const atAsConjunction =
      prev.low === "at" && (AGENT_NOUNS.has(w.low) || text[w.to] === "," || (next !== undefined && joined(w, next) && SUBJECTS.has(next.low)));
    if ((prev.low === "at" || MODALS.has(prev.low)) && !isName(prev) && !atAsConjunction) {
      const inf = IRREGULAR[w.low] ?? (w.low.endsWith("r") && w.low.length > 2 && verbs.has(w.low) && verbs.has(w.low.slice(0, -1)) ? w.low.slice(0, -1) : null);
      if (inf && !MODALS.has(w.low)) {
        flag(w, "navnemaade", `Efter »${prev.text}« skal udsagnsordet stå i navnemåde: »${inf}«.`, inf);
        continue;
      }
    }

    // 2. Nutid efter et stedord, der er grundled. Ikke ved omvendt ordstilling efter et hvilket
    // som helst udsagnsord: »kan vi lære«, »lod han være«.
    if (PRONOUNS.has(prev.low) && !MODALS.has(w.low) && !NOT_INFINITIVE.has(w.low)) {
      const before = words[i - 2];
      const inverted = before !== undefined && joined(before, prev) && (MODALS.has(before.low) || before.low === "at" || verbs.has(before.low) || before.low.endsWith("ede"));
      // Et mådesudsagnsord lidt længere tilbage i samme sætning: »skulle min mand og jeg melde«.
      let k = i - 2;
      let modalBefore = false;
      while (k >= 0 && k >= i - 6 && joined(words[k], words[k + 1])) {
        if (MODALS.has(words[k].low)) modalBefore = true;
        k--;
      }
      const present = PRESENT_OF[w.low] ?? (verbs.has(w.low) && verbs.has(`${w.low}r`) ? `${w.low}r` : null);
      if (present && !inverted && !modalBefore) flag(w, "nutid", `Efter »${prev.text}« skal udsagnsordet stå i nutid: »${present}«.`, present);
    }
  }
  text0 = text;
  if (agree) agreementFlags(words, joined, agree, flag);
  if (comma === "start" || comma === "uden") commaFlags(text, words, verbs, comma, out, quotes, advs ?? new Set());
  return out.sort((a, b) => a.from - b.from);
}

// --- kongruens (7/10) ------------------------------------------------------------------------------
//
// Køn og former fra træbanken (scripts/kongruens.mjs → assets/kongruens.json). Kun når navneordet
// efter er kendt og står med lille begyndelsesbogstav (ikke et navn):
//   »en hus« → »et hus« · »et stor hus« → »et stort hus« · »en stort bil« → »en stor bil«
//   »det stor hus« → »det store hus«

export type Agreement = { n: Record<string, "c" | "n">; a: Record<string, [string, string]> };

/** Her står »den/det/de« oftest som artikel: efter et forholdsord eller et bindeord, eller først. */
const ARTICLE_AFTER = new Set(["i", "på", "til", "med", "for", "af", "om", "fra", "ved", "under", "over", "efter", "mod", "gennem", "uden", "hos", "og", "eller", "men", "end", "som"]);
/** Bestemt form uden e er også rigtig efter Retskrivningsordbogen: »den ny«, »den fri«. */
const E_OPTIONAL = new Set(["ny", "fri"]);
/** Småord, der kan følge et navneord, der står alene: »en offer for«, »et gæt er«. */
const SMALL_WORDS = new Set(["i", "på", "til", "med", "for", "af", "om", "fra", "ved", "og", "eller", "men", "at", "som", "der", "er", "var", "har", "havde", "bliver", "blev", "kan", "skal", "vil", "nu", "her", "der", "da", "når"]);
/** Navneord, hvor træbankens køn er forkert eller begge køn er rigtige (fundet i korpusset 7/10). */
const GENDER_UNSURE = new Set(["boykot", "match", "spand", "tidsfordriv", "alternativ", "kollektiv", "del", "standard", "race"]);
/** »en enkelt undtagelse«: enkelt = én, ikke t-formen af »enkel«. */
const NOT_T_FORM = new Set(["enkelt"]);
const DEFINITE = new Set(["den", "det", "de", "denne", "dette", "disse", "min", "mit", "mine", "din", "dit", "dine", "sin", "sit", "sine", "vores", "jeres", "deres", "hans", "hendes"]);

/** Tillægsord med regelmæssig endelse, der ikke står i træbanken med t-form: vigtig → vigtigt, vigtige. */
function regularForms(base: string): [string, string] | null {
  if (/(lig|ig|bar)$/.test(base)) return [`${base}t`, `${base}e`];
  if (/som$/.test(base)) return [`${base}t`, `${base}me`];
  return null;
}

function agreementFlags(
  words: Word[],
  joined: (a: Word, b: Word) => boolean,
  agree: Agreement,
  flag: (w: Word, kind: string, message: string, replacement: string) => void,
): void {
  const tToBase = new Map(Object.entries(agree.a).map(([base, [t]]) => [t, base]));
  const formsOf = (w: string): [string, string] | null => agree.a[w] ?? (adjectives.has(w) ? regularForms(w) : null);
  // Kun ord, der oftest er navneord i ordklasselisten: træbanken kender også »dansk«, »helt« og »ny«
  // som navneord (sproget, en helt …), og så blev »en dansk avis« og »et helt år« markeret.
  const noun = (w: Word | undefined) =>
    w && w.text[0] === w.low[0] && nouns.has(w.low) && !adjectives.has(w.low) && !GENDER_UNSURE.has(w.low) ? agree.n[w.low] : undefined;
  const adj = (w: Word) => adjectives.has(w.low);
  for (let i = 0; i + 1 < words.length; i++) {
    const det = words[i];
    const w1 = words[i + 1];
    if (!joined(det, w1)) continue;
    const w2 = words[i + 2] && joined(w1, words[i + 2]) ? words[i + 2] : undefined;

    if (det.low === "en" || det.low === "et") {
      const g = noun(w1);
      // Artiklen lige foran navneordet: »en hus«. Kun når navneordet står alene: følger et navneord
      // eller tillægsord, er det første ord et tillægsord (»en kompleks sag«, »en tysk ubåd«).
      // Ikke ejefald (»et lands«) eller et ord, der fortsætter med bindestreg (»et familie- og«).
      const after = text0.slice(w1.to).match(/^\s*(\S)/)?.[1] ?? "";
      const alone = /[.,;:!?)»”"]/.test(after) || after === "" || (w2 !== undefined && SMALL_WORDS.has(w2.low));
      const genitive = w1.low.endsWith("s") && agree.n[w1.low.slice(0, -1)] !== undefined;
      if (g && alone && !genitive && words[i + 1] && text0[w1.to] !== "-" && (g === "n") !== (det.low === "et")) {
        flag(det, "koen", `»${w1.text}« er et ${g === "n" ? "et" : "en"}-ord: »${g === "n" ? "et" : "en"} ${w1.text}«.`, g === "n" ? "et" : "en");
        continue;
      }
      const g2 = noun(w2);
      if (!g2 || !adj(w1) || (g2 === "n") !== (det.low === "et")) continue;
      // Et tillægsord imellem: »et stor hus«, »en stort bil«.
      const forms = formsOf(w1.low);
      if (det.low === "et" && forms && w1.low !== forms[0]) flag(w1, "koen", `Efter »et« og foran et et-ord: »${forms[0]}«.`, forms[0]);
      const base = NOT_T_FORM.has(w1.low) ? undefined : tToBase.get(w1.low);
      if (det.low === "en" && base) flag(w1, "koen", `Efter »en« og foran et en-ord: »${base}«.`, base);
      continue;
    }

    // Bestemt form efter den, det, min …: »det stor hus« → »det store hus«.
    // »kræver det fri konkurrence«: efter et udsagnsord er »det« et stedord, ikke en artikel.
    const before = words[i - 1];
    const startOfSentence = before === undefined || !joined(before, det);
    const pronoun = ["den", "det", "de"].includes(det.low) && !startOfSentence && !ARTICLE_AFTER.has(before.low);
    if (DEFINITE.has(det.low) && adj(w1) && noun(w2) && !pronoun) {
      const base = agree.a[w1.low] ? w1.low : tToBase.get(w1.low) ?? (adjectives.has(w1.low) ? w1.low : undefined);
      const forms = base ? formsOf(base) : null;
      if (forms && w1.low !== forms[1] && !E_OPTIONAL.has(w1.low)) flag(w1, "bestemt", `Efter »${det.text}« står tillægsordet i bestemt form: »${forms[1]}«.`, forms[1]);
    }
  }
}

/** Tillægsord, navneord og udsagnsord fra ordklasselisten. Sættes af grammarFlags. */
let adjectives: ReadonlySet<string> = new Set();
let nouns: ReadonlySet<string> = new Set();
let text0 = "";

// --- komma (7/10) ---------------------------------------------------------------------------------
//
// Dansk Sprognævns to systemer, valgt i Indstillinger › Tekst. Kun de mønstre, der kan findes
// sikkert uden en fuld sætningsanalyse:
//   begge: komma efter en ledsætning først i sætningen: »Når han kommer, går vi.«
//   med startkomma: komma foran »at« efter siger/mener/tror …, og foran hvis/når/fordi/selvom
//   uden startkomma: intet komma foran »at« efter siger/mener/tror …

const SUBORD_START = new Set(["når", "hvis", "fordi", "selvom", "mens", "skønt", "medmindre", "eftersom", "idet"]);
const SUBORD_MID = new Set(["hvis", "når", "fordi", "selvom"]);
const SUBJ = new Set(["jeg", "du", "han", "hun", "vi", "de", "man", "det", "den"]);
const SAYING = new Set([
  "siger", "sagde", "mener", "mente", "tror", "troede", "synes", "syntes", "fortæller", "fortalte", "skriver", "skrev",
  "viser", "viste", "oplyser", "oplyste", "forklarer", "forklarede", "understreger", "påpeger", "vurderer", "håber",
  "håbede", "erkender", "frygter", "tænker", "føler", "vidste", "konkluderer", "anslår", "betyder",
]);
/** Ord, der hører til bindeordet (»selv hvis«, »især når«), eller hvor det er udsagnsled (»det er fordi«). */
const BEFORE_SUBORD_OK = new Set([
  "selv", "især", "kun", "netop", "også", "bare", "ikke", "og", "eller", "men", "for", "at", "som", "end", "lige", "navnlig",
  "specielt", "både", "mest", "altså", "så", "først", "sidst", "allerede", "første", "andet", "tredje",
  "er", "var", "være", "været", "bliver", "blev",
  // Faste udtryk fra korpusset (7/10): »hvad hvis«, »tænk hvis«, »i hvert fald hvis«, »dels fordi«.
  "hvad", "tænk", "fald", "mindst", "dels", "enten", "eksempel", "særligt", "særlig", "fremfor", "det",
]);
/** Det, der kan stå efter »at« som bindeord: et stedord, en artikel eller et ejestedord (ikke »at gå«). */
const AT_CONJ_NEXT = new Set([
  "jeg", "du", "han", "hun", "vi", "de", "man", "det", "den", "der", "i", "en", "et", "alle", "mange", "nogle", "nogen",
  "min", "mit", "mine", "din", "dit", "dine", "hans", "hendes", "vores", "jeres", "deres", "hver", "ingen", "flere",
]);
const PAST_FINITE = new Set(["var", "blev", "fik", "gik", "kom", "så", "stod", "lå", "tog", "gav", "sagde", "kunne", "skulle", "ville", "måtte", "havde", "gjorde", "vidste", "burde"]);

function commaFlags(text: string, words: Word[], verbs: ReadonlySet<string>, style: string, out: GrammarFlag[], quotes: ReturnType<typeof quoteRanges>, advs: ReadonlySet<string>): void {
  const between = (a: Word, b: Word) => text.slice(a.to, b.from);
  const plain = (a: Word, b: Word) => /^[ \t]+$/.test(between(a, b));
  const finite = (w: Word) => MODALS.has(w.low) || PAST_FINITE.has(w.low) || (verbs.has(w.low) && (w.low.endsWith("r") || w.low.endsWith("ede")));
  const add = (from: number, to: number, kind: string, message: string, replacement: string) => {
    if (!inQuote(from, quotes)) out.push({ from, to, kind: `grammatik:${kind}`, message, replacement });
  };
  // Sætningerne: ord fra en start til næste punktum, spørgsmålstegn, udråbstegn eller linjeskift.
  let start = 0;
  for (let i = 0; i <= words.length; i++) {
    const end = i === words.length || /[.!?\n]/.test(between(words[i - 1] ?? words[i], words[i]));
    if (!end || i === start) continue;
    const sentence = words.slice(start, i);
    start = i;
    const first = sentence[0];
    // Begge systemer: ledsætning først, så hovedsætning med omvendt ordstilling uden komma.
    const lead = first.low === "selv" && sentence[1]?.low === "om" ? 2 : SUBORD_START.has(first.low) ? 1 : 0;
    // En tankestreg afbryder ledsætningen: »Hvis vi skal – og det skal vi – så må vi …«.
    const span = between(first, sentence[sentence.length - 1]);
    if (lead && !span.includes(",") && !/[–—]/.test(span)) {
      for (let j = lead + 2; j + 1 < sentence.length; j++) {
        const v = sentence[j];
        const subj = sentence[j + 1];
        const hasVerbBefore = sentence.slice(lead, j).some(finite);
        if (hasVerbBefore && finite(v) && SUBJ.has(subj.low) && plain(sentence[j - 1], v) && plain(v, subj)) {
          const w = sentence[j - 1];
          add(w.from, w.to, "komma", `Sæt komma efter ledsætningen, før »${v.text}«.`, `${w.text},`);
          break;
        }
      }
    }
    for (let j = 1; j < sentence.length; j++) {
      const prev = sentence[j - 1];
      const w = sentence[j];
      const next = sentence[j + 1];
      const gap = between(prev, w);
      const nextIsName = next !== undefined && next.text[0] !== next.low[0];
      if (SAYING.has(prev.low) && w.low === "at" && next && (AT_CONJ_NEXT.has(next.low) || nextIsName) && !verbs.has(next.low)) {
        // »at« er her bindeord: et grundled følger, ikke et udsagnsord i navnemåde (»frygter at dumme sig«).
        if (style === "start" && /^[ \t]+$/.test(gap)) add(prev.from, prev.to, "komma", `Med startkomma: komma foran »at«.`, `${prev.text},`);
        if (style === "uden" && /^,[ \t]+$/.test(gap)) add(prev.to, w.from, "komma", `Uden startkomma: intet komma foran »at«.`, " ");
      }
      // Ikke et bindeord med stort (en overskrift uden punktum foran) og ikke »de når dem« (udsagnsord).
      const lower = w.text[0] === w.low[0];
      const verbUse = w.low === "når" && SUBJ.has(prev.low);
      if (style === "start" && SUBORD_MID.has(w.low) && lower && !verbUse && /^[ \t]+$/.test(gap) && !BEFORE_SUBORD_OK.has(prev.low) && !advs.has(prev.low) && j >= 2) {
        add(prev.from, prev.to, "komma", `Med startkomma: komma foran »${w.text}«.`, `${prev.text},`);
      }
    }
  }
}
