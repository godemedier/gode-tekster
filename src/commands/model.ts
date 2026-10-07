// Én kommando er én lille markdown-fil (research 3.7): et fladt hoved af `nøgle: værdi` mellem to
// linjer med `---`, og en krop, der er skabelonteksten, klodskæden, ordlisten eller instruksen.
// Nøglerne er engelske og faste, så en fil betyder det samme på en dansk og en engelsk
// installation. Ingen YAML: ingen indrykning, ingen lister, ingen anførselstegn.
//
// Der er én validator. Den læser håndskrevne filer, formularen i fanen og sprogmodellens forslag
// (research 3.6), så modellen aldrig kan bygge noget, brugeren ikke selv kunne have skrevet.
// En ukendt nøgle, et ukendt felt eller en ukendt klods er en fejl med linjenummer, aldrig noget,
// der bare springes over. Rene funktioner, testet med node --test.

import { tr } from "../i18n.ts";
import { parseChain } from "./blocks.ts";
import { BUILTIN_CHECKS, builtinCheckId, parseWordlist } from "./checks.ts";
import { validateTemplate } from "./fields.ts";
import { SHORTCUT_KEYS, type Command, type CommandError, type Kind, type ParseResult } from "./types.ts";

export const MAX_FILE_BYTES = 20 * 1024;
export const MAX_NAME = 24;
export const MAX_DESCRIPTION = 80;
export const MAX_INSTRUCTION = 2000;

const KEYS = ["name", "kind", "description", "aliases", "scope", "newfile", "output", "shortcut", "lang"] as const;
type Key = (typeof KEYS)[number];
const KINDS: Kind[] = ["template", "transform", "check", "ai"];
/** Små bogstaver (også æøå), tal og bindestreg. Første tegn er et bogstav eller et tal. */
const NAME = /^[a-zæøå0-9][a-zæøå0-9-]*$/;

/** En fejl, før den har fået sit linjenummer: enten ved en nøgle i hovedet eller på en linje i kroppen. */
type Issue = { key?: Key; bodyLine?: number; message: string };

const quoted = (s: string) => tr(`»${s}«`, `“${s}”`);
const bytes = (s: string) => new TextEncoder().encode(s).length;
const validName = (s: string) => s.length <= MAX_NAME && NAME.test(s);

function headIssues(c: Command): Issue[] {
  const out: Issue[] = [];
  const add = (key: Key, message: string) => out.push({ key, message });
  const nameRule = tr(`Brug små bogstaver, tal og bindestreg, højst ${MAX_NAME} tegn.`, `Use lower-case letters, digits and hyphens, at most ${MAX_NAME} characters.`);

  if (!c.name) add("name", tr("Kommandoen mangler et navn (name).", "The command has no name."));
  else if (!validName(c.name)) add("name", tr(`Navnet ${quoted(c.name.slice(0, 30))} kan ikke bruges. ${nameRule}`, `The name ${quoted(c.name.slice(0, 30))} cannot be used. ${nameRule}`));

  if (!c.kind) add("kind", tr("Kommandoen mangler en slags (kind): template, transform, check eller ai.", "The command has no kind: template, transform, check or ai."));
  else if (!KINDS.includes(c.kind)) add("kind", tr(`Slagsen ${quoted(String(c.kind).slice(0, 30))} findes ikke. Vælg template, transform, check eller ai.`, `There is no kind called ${quoted(String(c.kind).slice(0, 30))}. Choose template, transform, check or ai.`));

  if (!c.description) add("description", tr("Kommandoen mangler en beskrivelse (description).", "The command has no description."));
  else if (c.description.includes("\n")) add("description", tr("Beskrivelsen skal stå på én linje.", "The description has to be on one line."));
  else if (c.description.length > MAX_DESCRIPTION) add("description", tr(`Beskrivelsen er på ${c.description.length} tegn. Der er plads til ${MAX_DESCRIPTION}.`, `The description is ${c.description.length} characters. There is room for ${MAX_DESCRIPTION}.`));

  for (const a of c.aliases) {
    if (!validName(a)) add("aliases", tr(`Navnet ${quoted(a.slice(0, 30))} kan ikke bruges. ${nameRule}`, `The name ${quoted(a.slice(0, 30))} cannot be used. ${nameRule}`));
  }

  if (c.scope !== "selection" && c.scope !== "document") add("scope", tr("scope skal være selection eller document.", "scope has to be selection or document."));
  if (c.newfile && c.kind !== "template") add("newfile", tr("Kun en skabelon kan oprette en ny fil (newfile).", "Only a template can create a new file (newfile)."));

  const answers = tr("Vælg findings eller questions.", "Choose findings or questions.");
  if (c.output !== undefined && c.output !== "findings" && c.output !== "questions") {
    // Der findes ingen svarform, der kan rumme brødtekst (5/10). »alternatives« er fravalgt.
    add("output", tr(`Svarformen ${quoted(String(c.output).slice(0, 30))} findes ikke. ${answers}`, `There is no answer form called ${quoted(String(c.output).slice(0, 30))}. ${answers}`));
  } else if (c.kind === "ai" && c.output === undefined) add("output", tr(`En AI-kommando skal have en svarform (output). ${answers}`, `An AI command needs an answer form (output). ${answers}`));
  else if (c.kind !== "ai" && c.output !== undefined) add("output", tr("Kun AI-kommandoer har en svarform (output).", "Only AI commands have an answer form (output)."));

  if (c.shortcut !== undefined && !SHORTCUT_KEYS.includes(c.shortcut)) {
    add("shortcut", tr(`Genvejen skal være en af tasterne ${SHORTCUT_KEYS.join(", ")}.`, `The shortcut has to be one of the keys ${SHORTCUT_KEYS.join(", ")}.`));
  }
  if (c.lang !== undefined && c.lang !== "da" && c.lang !== "en") add("lang", tr("lang skal være da eller en.", "lang has to be da or en."));
  return out;
}

function bodyIssues(c: Command): Issue[] {
  const lines = (errors: CommandError[]): Issue[] => errors.map((e) => ({ bodyLine: e.line, message: e.message }));
  const empty = c.body.trim() === "";
  switch (c.kind) {
    case "template":
      if (empty) return [{ bodyLine: 1, message: tr("Skabelonen er tom. Skriv teksten under hovedet.", "The template is empty. Write the text below the head.") }];
      return lines(validateTemplate(c.body));
    case "transform": {
      if (empty) return [{ bodyLine: 1, message: tr("Omformningen har ingen trin. Skriv én klods pr. linje.", "The transform has no steps. Write one block per line.") }];
      return lines(parseChain(c.body).errors);
    }
    case "check": {
      if (empty) return [{ bodyLine: 1, message: tr("Ordlisten er tom. Skriv én regel pr. linje: fra => til", "The word list is empty. Write one rule per line: from => to") }];
      const id = builtinCheckId(c.body);
      if (id === null) return lines(parseWordlist(c.body).errors);
      if (BUILTIN_CHECKS.includes(id)) return [];
      return [{ bodyLine: 1, message: tr(`Det indbyggede tjek ${quoted(id.slice(0, 30))} findes ikke. Vælg mellem: ${BUILTIN_CHECKS.join(", ")}.`, `There is no built-in check called ${quoted(id.slice(0, 30))}. Choose from: ${BUILTIN_CHECKS.join(", ")}.`) }];
    }
    case "ai":
      if (empty) return [{ bodyLine: 1, message: tr("Instruksen er tom. Skriv under hovedet, hvad sprogmodellen skal se efter.", "The instruction is empty. Write below the head what the language model should look for.") }];
      if (c.body.length > MAX_INSTRUCTION) return [{ bodyLine: 1, message: tr(`Instruksen er på ${c.body.length} tegn. Der er plads til ${MAX_INSTRUCTION}.`, `The instruction is ${c.body.length} characters. There is room for ${MAX_INSTRUCTION}.`) }];
      return [];
    default:
      // Slagsen er ukendt, og det har hovedet allerede sagt.
      return [];
  }
}

function tooBig(size: number): string {
  const kb = Math.ceil(size / 1024);
  return tr(`Filen fylder ${kb} KB. En kommando må højst fylde 20 KB.`, `The file is ${kb} KB. A command can be at most 20 KB.`);
}

/**
 * Alle fejl i en kommando. Tom liste: den kan gemmes og køres. `line` er 0 for en fejl i hovedet
 * (navn, slags, beskrivelse og de andre nøgler) og ellers linjen i kroppen, 1 for den første.
 * `parseCommand` regner selv om til linjer i filen.
 */
export function validateCommand(c: Command): CommandError[] {
  const out = [...headIssues(c), ...bodyIssues(c)].map((i) => ({ line: i.bodyLine ?? 0, message: i.message }));
  const size = bytes(serializeCommand(c));
  if (size > MAX_FILE_BYTES) out.push({ line: 0, message: tooBig(size) });
  return out;
}

/**
 * Læs en fil. Enten en gyldig kommando eller alle fejl med linjenummer i filen (1 = første linje).
 * Tåler CRLF og BOM. Tomme linjer først og sidst i kroppen hører ikke med til den.
 */
export function parseCommand(text: string, source: "builtin" | "user", path?: string): ParseResult {
  const size = bytes(text);
  if (size > MAX_FILE_BYTES) return { ok: false, errors: [{ line: 1, message: tooBig(size) }] };
  const lines = text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first === -1 || lines[first].trim() !== "---") {
    return { ok: false, errors: [{ line: first === -1 ? 1 : first + 1, message: tr("Filen skal begynde med en linje med tre bindestreger: ---", "The file has to begin with a line of three hyphens: ---") }] };
  }
  const close = lines.findIndex((l, i) => i > first && l.trim() === "---");
  if (close === -1) {
    return { ok: false, errors: [{ line: first + 1, message: tr("Hovedet mangler sin sidste linje med tre bindestreger: ---", "The head is missing its last line of three hyphens: ---") }] };
  }

  const errors: CommandError[] = [];
  const values = new Map<Key, string>();
  const where = new Map<Key, number>();
  for (let i = first + 1; i < close; i++) {
    const raw = lines[i];
    const line = i + 1;
    if (raw.trim() === "") continue;
    const colon = raw.indexOf(":");
    if (colon === -1) {
      errors.push({ line, message: tr("Linjen kan ikke læses. Hovedet består af linjer som: name: rettelse", "The line cannot be read. The head is made of lines like: name: correction") });
      continue;
    }
    const key = raw.slice(0, colon).trim().toLowerCase();
    if (!(KEYS as readonly string[]).includes(key)) {
      errors.push({ line, message: tr(`Nøglen ${quoted(key.slice(0, 30))} findes ikke. De mulige er: ${KEYS.join(", ")}.`, `There is no key called ${quoted(key.slice(0, 30))}. The possible ones are: ${KEYS.join(", ")}.`) });
      continue;
    }
    if (values.has(key as Key)) {
      errors.push({ line, message: tr(`Nøglen ${quoted(key)} står to gange.`, `The key ${quoted(key)} appears twice.`) });
      continue;
    }
    values.set(key as Key, raw.slice(colon + 1).trim());
    where.set(key as Key, line);
  }

  // Kroppen uden tomme linjer først og sidst. `bodyStart` er filens linjenummer for dens første linje.
  let bodyFrom = close + 1;
  while (bodyFrom < lines.length && lines[bodyFrom].trim() === "") bodyFrom += 1;
  const body = lines.slice(bodyFrom).join("\n").trimEnd();
  const bodyStart = body === "" ? close + 1 : bodyFrom + 1;

  const newfile = values.get("newfile");
  if (newfile !== undefined && newfile !== "yes" && newfile !== "no") {
    errors.push({ line: where.get("newfile") ?? first + 1, message: tr("newfile skal være yes eller no.", "newfile has to be yes or no.") });
  }
  // Værdierne lægges ind, som de står. Validatoren afgør, om de findes, så reglerne kun står ét sted.
  const command: Command = {
    name: values.get("name") ?? "",
    kind: (values.get("kind") ?? "") as Kind,
    description: values.get("description") ?? "",
    aliases: (values.get("aliases") ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a !== ""),
    scope: (values.get("scope") ?? "selection") as Command["scope"],
    newfile: newfile === "yes",
    body,
    source,
  };
  if (values.has("output")) command.output = values.get("output") as Command["output"];
  if (values.has("shortcut")) command.shortcut = (values.get("shortcut") ?? "").toUpperCase() as Command["shortcut"];
  if (values.has("lang")) command.lang = values.get("lang") as Command["lang"];
  if (path !== undefined) command.path = path;

  for (const issue of [...headIssues(command), ...bodyIssues(command)]) {
    const line = issue.bodyLine !== undefined ? bodyStart + issue.bodyLine - 1 : ((issue.key && where.get(issue.key)) ?? first + 1);
    errors.push({ line, message: issue.message });
  }
  if (errors.length) return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
  return { ok: true, command };
}

/**
 * Kommandoen som fil: hovedet i fast rækkefølge og kun med de nøgler, der afviger fra standarden,
 * og derefter kroppen. `parseCommand(serializeCommand(c))` giver `c` igen, og en fil, der er
 * skrevet herfra, kommer uændret ud efter en tur gennem begge.
 */
export function serializeCommand(c: Command): string {
  const head = [`name: ${c.name}`, `kind: ${c.kind}`, `description: ${c.description}`];
  if (c.aliases.length) head.push(`aliases: ${c.aliases.join(", ")}`);
  if (c.scope === "document") head.push("scope: document");
  if (c.newfile) head.push("newfile: yes");
  if (c.output !== undefined) head.push(`output: ${c.output}`);
  if (c.shortcut !== undefined) head.push(`shortcut: ${c.shortcut}`);
  if (c.lang !== undefined) head.push(`lang: ${c.lang}`);
  const body = c.body
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
  return `---\n${head.join("\n")}\n---\n${body}\n`;
}

/** Filens navn i kommandomappen. Æ, ø og å bevares. */
export function fileNameFor(c: Command): string {
  return `${c.name}.md`;
}
