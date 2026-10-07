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

export function grammarFlags(text: string, verbs: ReadonlySet<string>): GrammarFlag[] {
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
  return out;
}
