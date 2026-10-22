// Retskrivning (stiltjek fase 2, 16/10): fejl, som en ordliste kan finde sikkert, fordi den forkerte
// form næsten aldrig er rigtig. Skrevet med egne ord ud fra Retskrivningsreglerne og LanguageTools
// danske regler (LGPL, kun ordparrene er brugt, ikke teksterne).
//
//   to-ord       faste udtryk i ét ord, der skal stå i to: »igang« → »i gang«
//   forveksling  ord, der ligner et andet: »kunde ikke« → »kunne ikke«, »ned af trappen« → »ned ad«
//   forkortelse  punktum: »dvs« → »dvs.«, »jvf.« → »jf.«, »fx.« → »fx«
//   tal          »3 årig« → »3-årig«, »1990erne« → »1990'erne«, »1990 tallet« → »1990-tallet«
//   komma        komma lige efter »men« eller »og« først i sætningen: »Men, det …«
//
// Nye regler vises kun med »Alle forslag«, til målebænken har målt dem (ADR-0051). Tekst i citater
// markeres ikke.

import { inQuote, quoteRanges } from "../sprog/quotes.ts";
import type { Flag } from "./styleRules.ts";

/** Ét ord, der skal være to. Kun former, der ikke selv er et ord. */
const TWO_WORDS: Record<string, string> = {
  igang: "i gang",
  idag: "i dag",
  igår: "i går",
  imorgen: "i morgen",
  iaften: "i aften",
  inat: "i nat",
  iforvejen: "i forvejen",
  ihvertfald: "i hvert fald",
  hvertfald: "hvert fald",
  ialtfald: "i alt fald",
  istedet: "i stedet",
  istedetfor: "i stedet for",
  iøvrigt: "i øvrigt",
  forøvrigt: "for øvrigt",
  ialt: "i alt",
  istand: "i stand",
  iorden: "i orden",
  iforhold: "i forhold",
  iløbet: "i løbet",
  iforbindelse: "i forbindelse",
  iøjeblikket: "i øjeblikket",
  ivejen: "i vejen",
  iflæng: "i flæng",
  tilsidst: "til sidst",
  tilstede: "til stede",
  tilgode: "til gode",
  tilfulde: "til fulde",
  tilbunds: "til bunds",
  tilsøs: "til søs",
  tilfods: "til fods",
  påny: "på ny",
  pågrund: "på grund",
  pånær: "på nær",
  påtværs: "på tværs",
  fuldtud: "fuldt ud",
  hvorlænge: "hvor længe",
  forsåvidt: "for så vidt",
  såvidt: "så vidt",
  overbord: "over bord",
};

/** Ord, der ligner et andet ord. Kun hvor den forkerte form ikke findes i almindelig brug. */
const LOOKALIKES: Record<string, [string, string]> = {
  standart: ["standard", "En standart er en fane. Mente du »standard«?"],
  standarten: ["standarden", "En standart er en fane. Mente du »standarden«?"],
  standarter: ["standarder", "En standart er en fane. Mente du »standarder«?"],
  egenavn: ["egennavn", "Navne som Jens og Aarhus er egennavne, med to n."],
  egenavne: ["egennavne", "Navne som Jens og Aarhus er egennavne, med to n."],
  varetegn: ["vartegn", "Det hedder »vartegn«."],
  varetegnet: ["vartegnet", "Det hedder »vartegnet«."],
  skrællemand: ["skraldemand", "Det hedder »skraldemand«."],
  skrællemænd: ["skraldemænd", "Det hedder »skraldemænd«."],
  extra: ["ekstra", "På dansk staves det »ekstra«."],
  incl: ["inkl.", "På dansk forkortes inklusive »inkl.«"],
  excl: ["ekskl.", "På dansk forkortes eksklusive »ekskl.«"],
  jvf: ["jf.", "Jævnfør forkortes »jf.«"],
  feks: ["f.eks.", "For eksempel forkortes »f.eks.« eller »fx«."],
};

/** Forkortelser, der skal have punktum, når de står midt i teksten (»dvs det«, »ca 50«). */
const NEEDS_DOT = ["dvs", "osv", "evt", "inkl", "ekskl", "pga", "mht", "iflg", "bl.a", "f.eks", "vedr"];
/** Forkortelser, der kun er sikre foran et tal: »ca 50«, »kl 14«, »nr 3«. */
const NEEDS_DOT_BEFORE_NUMBER = ["ca", "kl", "nr"];

/** Grundled. Ikke »som«: »du som kunde« er navneordet (målebænken 16/10). */
const SUBJECT = "jeg|du|han|hun|vi|de|man|det|der|den";
/** Retning + »af« + en vej: »ned af trappen« → »ned ad trappen« (ad = langs). */
/** Ikke »ud«: »gå ud af vejen« er rigtigt. */
const DIRECTIONS = "hen|ned|op|frem|tilbage|nord|syd|øst|vest";
const PATHS = "vejen|vejene|stien|gangen|gaden|gaderne|trappen|trapperne|floden|åen|bakken|skrænten|gelænderet|kysten|sporet";

const L = "\\p{L}\\p{N}";
/** Hele ord, uden at fange en del af et længere ord. */
const word = (body: string, flags = "giu") => new RegExp(`(?<![${L}'’.-])(?:${body})(?![${L}'’-])`, flags);

/** Følg store bogstaver: »Idag« → »I dag«. */
function keepCase(original: string, next: string): string {
  return original[0] !== original[0].toLowerCase() ? next[0].toUpperCase() + next.slice(1) : next;
}

export function retskrivningFlags(text: string): Flag[] {
  const quotes = quoteRanges(text);
  const out: Flag[] = [];
  const add = (from: number, to: number, kind: string, message: string, replacement?: string) => {
    if (!inQuote(from, quotes)) out.push({ from, to, kind: `ro:${kind}`, message, replacement });
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    for (const m of text.matchAll(re)) fn(m as RegExpExecArray);
  };

  each(word(Object.keys(TWO_WORDS).join("|")), (m) => {
    const right = TWO_WORDS[m[0].toLowerCase()];
    add(m.index, m.index + m[0].length, "to-ord", `Skrives i to ord: »${right}«.`, keepCase(m[0], right));
  });
  // »al ting« → »alting« (men ikke »al tings«, ejefald).
  each(word("al ting"), (m) => add(m.index, m.index + m[0].length, "to-ord", "Skrives i ét ord: »alting«.", keepCase(m[0], "alting")));

  // Forkortelser, der står som et ord (»extra«, »jvf.«). Med stort er det et navn eller en titel.
  each(word(Object.keys(LOOKALIKES).join("|")), (m) => {
    if (m[0][0] !== m[0][0].toLowerCase()) return;
    const [right, message] = LOOKALIKES[m[0].toLowerCase()];
    // »jvf.«: punktummet hører med til det, der rettes.
    const end = m.index + m[0].length + (text[m.index + m[0].length] === "." && right.endsWith(".") ? 1 : 0);
    add(m.index, end, ["incl", "excl", "jvf", "feks"].includes(m[0].toLowerCase()) ? "forkortelse" : "forveksling", message, right);
  });

  // kunde/kunne: »kunde« efter et grundled og foran et udsagnsord eller »ikke« er »kunne«.
  each(word(`(?:${SUBJECT}) kunde (?:ikke|godt|også|aldrig|være|have|få|se|gøre|blive|komme|gå|tage|sige|nå|bruge)`), (m) => {
    const at = m.index + m[0].toLowerCase().indexOf(" kunde ") + 1;
    add(at, at + 5, "forveksling", "En kunde køber noget. Udsagnsordet er »kunne«.", "kunne");
  });
  // heder/hedder: »hun heder« → »hun hedder« (en hede er et lyngområde).
  each(word(`(?:${SUBJECT}|hvad|nu) heder`), (m) => {
    const at = m.index + m[0].length - 5;
    add(at, at + 5, "forveksling", "Om navne hedder det »hedder« med to d'er.", keepCase(m[0].slice(-5), "hedder"));
  });
  // af/ad: »gik ned af trappen« → »ned ad trappen«.
  each(word(`(?:${DIRECTIONS}) af (?:${PATHS})`), (m) => {
    const at = m.index + m[0].toLowerCase().indexOf(" af ") + 1;
    add(at, at + 2, "forveksling", "Langs en vej eller trappe hedder det »ad«: »ned ad trappen«.", "ad");
  });
  each(word("vel og mærke(?:t)?"), (m) => add(m.index, m.index + m[0].length, "forveksling", "Udtrykket hedder »vel at mærke«.", keepCase(m[0], "vel at mærke")));
  each(word("ynglings\\p{L}*"), (m) => {
    const right = `yndlings${m[0].slice(8)}`;
    add(m.index, m.index + m[0].length, "forveksling", `Det hedder »${right}«.`, keepCase(m[0], right));
  });
  each(word("(?:kende|kender|kendte) (?:ikke |aldrig )?(?:sin|sine|deres|vores|hans|hendes) besøgstid"), (m) => {
    const at = m.index + m[0].length - 9;
    add(at, at + 9, "forveksling", "Udtrykket hedder »kende sin besøgelsestid«.", "besøgelsestid");
  });

  // Forkortelser uden punktum, midt i en sætning: »dvs det«, »bl.a de«. Ikke sidst i en sætning
  // (»osv«), hvor punktummet kan være sætningens.
  each(word(`(?:${NEEDS_DOT.map((a) => a.replace(".", "\\.")).join("|")})(?= [\\p{Ll}\\d])`), (m) => {
    add(m.index, m.index + m[0].length, "forkortelse", `Forkortelsen skrives med punktum: »${m[0]}.«`, `${m[0]}.`);
  });
  each(word(`(?:${NEEDS_DOT_BEFORE_NUMBER.join("|")})(?= \\d)`, "gu"), (m) => {
    add(m.index, m.index + m[0].length, "forkortelse", `Forkortelsen skrives med punktum: »${m[0]}.«`, `${m[0]}.`);
  });
  each(word("bla\\.", "gu"), (m) => add(m.index, m.index + m[0].length, "forkortelse", "Blandt andet forkortes »bl.a.«", "bl.a."));
  each(word("b\\.la\\.", "gu"), (m) => add(m.index, m.index + m[0].length, "forkortelse", "Blandt andet forkortes »bl.a.«", "bl.a."));
  // »fx.« midt i en sætning: fx skrives uden punktum. Sidst i sætningen er punktummet sætningens.
  each(/(?<![\p{L}.])(?:fx\.|f\.x\.)(?= \p{Ll})/gu, (m) => add(m.index, m.index + m[0].length, "forkortelse", "»fx« skrives uden punktum.", "fx"));

  // Tal: bindestreg i sammensætninger med tal og apostrof foran endelsen.
  each(/(?<![\p{L}\p{N}.,])(\d+) (årig|årige|årigt|tallet|tallets)(?![\p{L}])/gu, (m) => {
    add(m.index, m.index + m[0].length, "tal", `Tal i et sammensat ord får bindestreg: »${m[1]}-${m[2]}«.`, `${m[1]}-${m[2]}`);
  });
  each(/(?<![\p{L}\p{N}.,])(\d+)(tallet|tallets)(?![\p{L}])/gu, (m) => {
    add(m.index, m.index + m[0].length, "tal", `Tal i et sammensat ord får bindestreg: »${m[1]}-${m[2]}«.`, `${m[1]}-${m[2]}`);
  });
  each(/(?<![\p{L}\p{N}.,])(\d{2,4})(erne|ernes|eren|er)(?![\p{L}])/gu, (m) => {
    add(m.index, m.index + m[0].length, "tal", `Endelsen efter et tal får apostrof: »${m[1]}'${m[2]}«.`, `${m[1]}'${m[2]}`);
  });

  // Komma lige efter »men« eller »og« først i sætningen, når der ikke følger et indskud. Indskuddet
  // kan være langt (»Men, som prodekanen skriver i sit svar, …«, målebænken 16/10), så intet komma
  // i resten af sætningen.
  each(/(?:^|[.!?]\s+|\n)[ \t]*(Men|Og),[ \t]+([^\n.!?]*)/gu, (m) => {
    if (/[,–—]/.test(m[2])) return;
    const at = m.index + m[0].indexOf(m[1]);
    add(at, at + m[1].length + 1, "komma", `Intet komma efter »${m[1]}«.`, m[1]);
  });

  return out.sort((a, b) => a.from - b.from);
}
