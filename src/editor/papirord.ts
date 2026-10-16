// Papirord og opmærksomhedsforskydere (stiltjek fase 3, 16/10). Egne formuleringer. Ordparrene er
// kendt stof fra klarsprogsarbejdet (Ombudsmanden, borger.dk, Dansk Sprognævn). Clarity.ts (en kopi
// af Gode Ord) har allerede »såfremt«, »vedrørende«, »anvende« m.fl., så de står ikke her.
//
// To lag. »papirord« er ord, der næsten altid kan siges enklere. »papirord-2« er ord, der er fine i
// mange tekster, men tunge i en tekst til almindelige læsere. Begge vises kun med »Alle forslag«,
// til målebænken har målt dem (ADR-0051).
//
// Hver form står for sig med sit eget forslag, så forslaget passer i bøjning. Står der ingen
// erstatning (null), afhænger den rigtige form af sætningen, og beskeden nævner kun ordet.

import { inQuote, quoteRanges } from "../sprog/quotes.ts";
import type { Flag } from "./styleRules.ts";

type Entry = { forms: Record<string, string | null>; say: string };

const LAYER_1: Entry[] = [
  { say: "få", forms: { erholde: "få", erholder: "får", erholdes: "fås", erholdt: null, erholdte: null } },
  { say: "sende", forms: { fremsende: "sende", fremsender: "sender", fremsendes: "sendes", fremsendt: "sendt", fremsendte: "sendte" } },
  { say: "sende", forms: { tilsende: "sende", tilsender: "sender", tilsendes: "sendes", tilsendt: "sendt", tilsendte: "sendte" } },
  { say: "begynde", forms: { påbegynde: "begynde", påbegynder: "begynder", påbegyndes: "begyndes", påbegyndt: "begyndt", påbegyndte: "begyndte" } },
  { say: "sætte i gang", forms: { iværksætte: "sætte i gang", iværksættes: "sættes i gang", iværksat: "sat i gang", iværksatte: "satte i gang" } },
  { say: "sørge for", forms: { foranledige: "sørge for", foranlediger: "sørger for", foranlediget: null, foranledigede: null } },
  { say: "sige", forms: { tilkendegive: "sige", tilkendegiver: "siger", tilkendegav: "sagde", tilkendegivet: "sagt" } },
  { say: "bede om", forms: { "anmode om": "bede om", "anmoder om": "beder om", "anmodede om": "bad om", "anmodet om": "bedt om", "anmodes om": "bedes om" } },
  { say: "komme med", forms: { "fremkomme med": "komme med", "fremkommer med": "kommer med", "fremkom med": "kom med" } },
  { say: "søge om", forms: { "ansøge om": "søge om", "ansøger om": "søger om", "ansøgte om": "søgte om" } },
  { say: "findes", forms: { forefindes: "findes", forefandtes: "fandtes" } },
  { say: "skaffe", forms: { tilvejebringe: "skaffe", tilvejebringer: "skaffer", tilvejebringes: "skaffes", tilvejebragt: "skaffet", tilvejebragte: "skaffede" } },
  { say: "regne med", forms: { påregne: "regne med", påregner: "regner med", påregnes: "regnes med", påregnet: "regnet med" } },
  { say: "skrive", forms: { affatte: "skrive", affatter: "skriver", affattet: "skrevet", affattede: "skrev" } },
  { say: "nødvendig", forms: { fornøden: "nødvendig", fornødent: "nødvendigt", fornødne: "nødvendige" } },
  { say: "desuden", forms: { endvidere: "desuden" } },
  { say: "også", forms: { tillige: "også" } },
  { say: "om", forms: { hvorvidt: "om" } },
  { say: "selvom", forms: { uagtet: "selvom" } },
  { say: "før eller tidligere", forms: { forinden: null } },
  { say: "fremover", forms: { fremadrettet: "fremover" } },
  { say: "nævnte", forms: { førnævnte: "nævnte", ovennævnte: "nævnte" } },
  { say: "jeg", forms: { undertegnede: null } },
  { say: "i dag", forms: { "pr. dags dato": "i dag", "dags dato": "i dag" } },
  { say: "efter", forms: { "i henhold til": null, "i medfør af": null } },
  { say: "på grund af", forms: { "henset til": "på grund af" } },
  { say: "beløb", forms: { beløbsstørrelse: "beløb", beløbsstørrelsen: "beløbet" } },
  { say: "se", forms: { jævnfør: "se" } },
  { say: "fra", forms: { "med virkning fra": "fra" } },
];

const LAYER_2: Entry[] = [
  { say: "få", forms: { modtage: "få", modtager: null, modtages: "fås", modtaget: "fået", modtog: "fik" } },
  { say: "fortælle", forms: { meddele: "fortælle", meddeler: "fortæller", meddeles: null, meddelt: "fortalt", meddelte: "fortalte" } },
  { say: "holde", forms: { afholde: "holde", afholder: "holder", afholdes: "holdes", afholdt: "holdt", afholdte: null } },
  { say: "lave eller gøre", forms: { foretage: null, foretager: null, foretages: null, foretaget: null, foretog: null } },
  { say: "svare på", forms: { besvare: "svare på", besvarer: "svarer på", besvares: null, besvaret: "svaret på", besvarede: "svarede på" } },
  { say: "også", forms: { ligeledes: "også" } },
  { say: "blandt andet", forms: { herunder: "blandt andet" } },
  { say: "og", forms: { samt: "og" } },
];

/** Opmærksomhedsforskydere: »omkring« betyder rundt om eller cirka, men står ofte for »om«. */
const ABOUT_AFTER = [
  "informere", "informerer", "informeret", "informerede", "snakke", "snakker", "snakkede", "tale", "taler", "talte",
  "spørgsmål", "spørgsmålet", "spørgsmålene", "debat", "debatten", "dialog", "dialogen", "viden", "regler", "reglerne",
  "aftale", "aftalen", "drøftelse", "drøftelser", "drøftelserne", "bekymring", "bekymringer", "usikkerhed", "usikkerheden",
  "enighed", "uenighed", "forvirring", "retningslinjer", "retningslinjerne", "information", "informationen", "oplysninger",
  "diskussion", "diskussionen", "diskussioner", "snak", "snakken", "samtale", "samtalen", "spekulationer", "fortælling",
];
/** »diskutere omkring X« er bare »diskutere X«. */
const DISCUSS = ["diskutere", "diskuterer", "diskuteret", "diskuterede", "drøfte", "drøfter", "drøftet", "drøftede"];

const L = "\\p{L}\\p{N}";
const esc = (s: string) => s.replace(/[.]/g, "\\.").replace(/ /g, "\\s+");
const wordRe = (alts: string[]) => new RegExp(`(?<![${L}.-])(?:${alts.map(esc).join("|")})(?![${L}-])`, "giu");

function keepCase(original: string, next: string): string {
  return original[0] !== original[0].toLowerCase() ? next[0].toUpperCase() + next.slice(1) : next;
}

/**
 * Steder, hvor ordet er rigtigt (målebænken 16/10): »samt« skiller led, der selv har »og«, og
 * »er der modtaget« er passiv, hvor »fået« ikke passer.
 */
function skip(key: string, before: string, after: string): boolean {
  if (key === "samt") return /(^|\s)og\s/i.test(before.split(/[.!?;:]/).pop() ?? "") || /^[^.!?,]{0,40}\sog\s/i.test(after);
  if (key === "modtaget") return /(^|\s)(er|blev|bliver|var|blive|være)\s+(der\s+)?$/i.test(before);
  return false;
}

function layer(text: string, entries: Entry[], kind: string, out: Flag[], quotes: ReturnType<typeof quoteRanges>): void {
  const lookup = new Map<string, [string | null, string]>();
  for (const e of entries) for (const [form, repl] of Object.entries(e.forms)) lookup.set(form, [repl, e.say]);
  // Længste form først, så »pr. dags dato« vinder over »dags dato«.
  const forms = [...lookup.keys()].sort((a, b) => b.length - a.length);
  for (const m of text.matchAll(wordRe(forms))) {
    if (inQuote(m.index, quotes)) continue;
    const key = m[0].toLowerCase().replace(/\s+/g, " ");
    const hit = lookup.get(key);
    if (!hit) continue;
    const [found, say] = hit;
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (skip(key, before, after)) continue;
    // »om, hvorvidt«: her undgår ordet netop »om, om« (målebænken 16/10, 5 af 5).
    if (key === "hvorvidt" && /(^|\s)om[\s,][^.!?]{0,20}$/i.test(before)) continue;
    const repl = found;
    const message = kind === "papirord" ? `Papirord: skriv hellere »${repl ?? say}«.` : `Tungt for mange læsere: prøv »${repl ?? say}«.`;
    out.push({ from: m.index, to: m.index + m[0].length, kind, message, replacement: repl ? keepCase(m[0], repl) : undefined });
  }
}

export function papirordFlags(text: string): Flag[] {
  const quotes = quoteRanges(text);
  const out: Flag[] = [];
  layer(text, LAYER_1, "papirord", out, quotes);
  layer(text, LAYER_2, "papirord-2", out, quotes);

  // »omkring« efter ord om at tale og vide, men ikke foran et tal (»omkring 50« = cirka).
  const about = new RegExp(`(?<![${L}])(${[...ABOUT_AFTER, ...DISCUSS].join("|")})\\s+(omkring)(?!\\s+\\d)(?![${L}])`, "giu");
  for (const m of text.matchAll(about)) {
    const at = m.index + m[0].length - m[2].length;
    if (inQuote(at, quotes)) continue;
    const discuss = DISCUSS.includes(m[1].toLowerCase());
    out.push({
      from: at,
      to: at + m[2].length,
      kind: "omkring",
      message: discuss ? `»omkring« betyder rundt om eller cirka. Man ${m[1].toLowerCase().startsWith("dr") ? "drøfter" : "diskuterer"} noget.` : "»omkring« betyder rundt om eller cirka. Her er det »om«.",
      replacement: discuss ? undefined : "om",
    });
  }
  return out.sort((a, b) => a.from - b.from);
}
