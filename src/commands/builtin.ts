// Startbiblioteket (6/10: »strammet op og gjort mere universelle«, ADR-0028). 12 kommandoer:
// 4 skabeloner, 4 omformninger, 1 tjek og 3 AI. Journalistskabelonerne (interview, pitch, rettelse,
// faktaboks og flere) udgik, fordi programmet skal kunne bruges af alle, og de tre tjek
// blev til ét /tjek. De ligger i programmet på begge sprog og skrives ikke til disken, så en
// opdatering kan forbedre dem uden at røre brugerens egne filer.
//
// Hver kommando står som den samme slags fil, brugeren selv kan skrive, og læses med
// `parseCommand`, når modulet indlæses. Så er de indbyggede også eksempler, der altid er gyldige,
// og »Tilpas« i fanen kan lægge en kopi i brugerens mappe med `serializeCommand`.
//
// Ingen af dem har `lang: da`. Den nøgle er til kommandoer, der bygger på ordklasser eller dansk
// stiltjek.

import type { Lang } from "../i18n.ts";
import { parseCommand } from "./model.ts";
import type { Command, CommandError } from "./types.ts";

const file = (head: string, body: string) => `---\n${head.trim()}\n---\n${body.replace(/^\n/, "")}`;

/** Hver kommando som et par: dansk fil og engelsk fil. Rækkefølgen er den, menuen viser. */
const PAIRS: [da: string, en: string][] = [
  // --- skabeloner ---
  [
    file("name: dato\nkind: template\ndescription: Dagens dato", "{{dato}}"),
    file("name: date\nkind: template\ndescription: Today's date", "{{date}}"),
  ],
  [
    // Markeret tekst bliver en tabel. Uden markering sætter run.ts en tom tabel ind (6/10).
    file("name: tabel\nkind: transform\ndescription: Det markerede som tabel, ellers en tom tabel", "table"),
    file("name: table\nkind: transform\ndescription: The selection as a table, otherwise an empty table", "table"),
  ],
  [
    file(
      "name: møde\nkind: template\ndescription: Mødenoter med beslutninger og opgaver",
      `
# Møde: {{1:emne}}, {{dato}}

Til stede: {{2:navne}}

## Besluttet

- {{markør}}

## Opgaver

- [ ] {{3:Hvem gør hvad, og hvornår}}

## Næste gang

-`,
    ),
    file(
      "name: meeting\nkind: template\ndescription: Meeting notes with decisions and actions",
      `
# Meeting: {{1:topic}}, {{date}}

Present: {{2:names}}

## Decided

- {{cursor}}

## Actions

- [ ] {{3:Who does what, and by when}}

## Next time

-`,
    ),
  ],
  [
    file(
      "name: brev\nkind: template\ndescription: Brev med dato, hilsen og dit navn",
      `
{{dato}}

Kære {{1:navn}}

{{markør}}

Venlig hilsen
{{navn}}`,
    ),
    file(
      "name: letter\nkind: template\ndescription: Letter with the date, a greeting and your name",
      `
{{date}}

Dear {{1:name}},

{{cursor}}

Kind regards
{{name}}`,
    ),
  ],
  // --- omformninger ---
  [
    file("name: ryd\nkind: transform\ndescription: Ryd op i indsat tekst: linjeskift, mellemrum og citationstegn", "join-lines\ntidy\nellipsis\nquotes"),
    file("name: tidy\nkind: transform\ndescription: Tidy up pasted text: line breaks, spaces and quotation marks", "join-lines\ntidy\nellipsis\nquotes"),
  ],
  [
    file("name: liste\nkind: transform\ndescription: Lav linjerne til punkter", "list bullets"),
    file("name: list\nkind: transform\ndescription: Turn the lines into bullets", "list bullets"),
  ],
  [
    file("name: sorter\nkind: transform\ndescription: Sorter linjerne alfabetisk", "sort"),
    file("name: sort\nkind: transform\ndescription: Sort the lines alphabetically", "sort"),
  ],
  [
    file("name: citat\nkind: transform\ndescription: Sæt citationstegn om", "quotes around"),
    file("name: quote\nkind: transform\ndescription: Put quotation marks around", "quotes around"),
  ],
  // --- tjek ---
  [
    file("name: tjek\nkind: check\ndescription: Huller, navne og tal, der ikke stemmer, og gentagelser\nscope: document", "builtin: all"),
    file("name: check\nkind: check\ndescription: Gaps, names and figures that differ, and repetitions\nscope: document", "builtin: all"),
  ],
  // --- AI: peger og spørger. Ingen af dem formulerer tekst. ---
  [
    file(
      "name: nylæser\nkind: ai\ndescription: Hvor falder en ny læser af?\noutput: findings\nscope: document",
      "Læs teksten som en, der aldrig har hørt om emnet. Peg på de steder, hvor et fagord, en forkortelse eller en forudsætning ikke er forklaret. Skriv for hvert sted, hvad læseren mangler at vide. Foreslå ikke en ny formulering.",
    ),
    file(
      "name: newreader\nkind: ai\ndescription: Where does a new reader get lost?\noutput: findings\nscope: document",
      "Read the text as someone who has never heard of the subject. Point to the places where a technical term, an abbreviation or an assumption is not explained. For each place, say what the reader needs to know. Do not suggest new wording.",
    ),
  ],
  [
    file(
      "name: redaktør\nkind: ai\ndescription: Spørgsmålene, en kritisk redaktør ville stille\noutput: questions\nscope: document",
      "Du er en kritisk, venlig redaktør. Stil de spørgsmål, teksten ikke svarer på: hvad mangler, hvilke påstande står uden belæg, og hvad en skeptisk læser vil sidde tilbage med. Stil kun spørgsmål. Foreslå ikke tekst.",
    ),
    file(
      "name: editor\nkind: ai\ndescription: The questions a critical editor would ask\noutput: questions\nscope: document",
      "You are a critical, kind editor. Ask the questions the text does not answer: what is missing, which claims have nothing to back them, and what a sceptical reader will be left wondering. Only ask questions. Do not suggest text.",
    ),
  ],
  [
    file(
      "name: halver\nkind: ai\ndescription: Peg på det, der kan undværes, til halv længde\noutput: findings\nscope: document",
      "Teksten skal ned på cirka den halve længde. Udpeg ordret de sætninger og afsnit, der bedst kan undværes, uden at teksten mister sin pointe, sine vigtigste argumenter eller sin sammenhæng. Omskriv intet.",
    ),
    file(
      "name: half\nkind: ai\ndescription: Point to what can go to reach half the length\noutput: findings\nscope: document",
      "The text must be cut to roughly half its length. Mark, word for word, the sentences and paragraphs that can best be left out without the text losing its point, its main arguments or its coherence. Rewrite nothing.",
    ),
  ],
];

/** Æ, ø og å skrevet med ae, oe og aa, så »/moede« også finder »/møde«. */
export function withoutDanishLetters(name: string): string {
  return name.replaceAll("æ", "ae").replaceAll("ø", "oe").replaceAll("å", "aa");
}

type Pair = { da: Command; en: Command };
const pairs: Pair[] = [];
const problems: { name: string; lang: Lang; errors: CommandError[] }[] = [];

PAIRS.forEach(([daText, enText], i) => {
  const da = parseCommand(daText, "builtin");
  const en = parseCommand(enText, "builtin");
  if (!da.ok) problems.push({ name: /name: (\S+)/.exec(daText)?.[1] ?? String(i), lang: "da", errors: da.errors });
  if (!en.ok) problems.push({ name: /name: (\S+)/.exec(enText)?.[1] ?? String(i), lang: "en", errors: en.errors });
  // En indbygget med en fejl udelades frem for at vælte programmet. Testen fanger den.
  if (da.ok && en.ok) pairs.push({ da: da.command, en: en.command });
});

/** Indbyggede, der ikke kunne læses. Skal være tom. Kun til testen. */
export function builtinProblems(): { name: string; lang: Lang; errors: CommandError[] }[] {
  return problems;
}

/**
 * De indbyggede på sproget, i menuens rækkefølge. Det andet sprogs navn står i `aliases`, så
 * `/faktaboks` også virker i den engelske udgave, sammen med en ae/oe/aa-form af navne med æøå.
 * Et alias, der er en anden indbyggets navn på sproget, kommer ikke med. Hvert kald giver nye
 * objekter, så kalderen frit kan ændre dem.
 */
export function builtinCommands(lang: Lang): Command[] {
  const other: Lang = lang === "da" ? "en" : "da";
  const names = new Set(pairs.map((p) => p[lang].name));
  return pairs.map((p) => {
    const own = p[lang];
    const candidates = [...own.aliases, p[other].name, ...p[other].aliases];
    const all = [...candidates, ...[own.name, ...candidates].map(withoutDanishLetters)];
    const aliases = [...new Set(all)].filter((a) => a !== own.name && !names.has(a));
    return { ...own, aliases };
  });
}

/** AI-kommandoer, hvor fundene er ting, der kan undværes: fladen tilbyder at dæmpe dem (/halver). */
const DIM_OFFER = ["halver", "half"];
export function offersDimming(c: Command): boolean {
  return c.source === "builtin" && c.kind === "ai" && DIM_OFFER.includes(c.name);
}
