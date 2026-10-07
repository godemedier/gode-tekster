// Felterne i en skabelon (research 3.2): `{{dato}}`, `{{1:tekst}}`, `{{markør}}`. Hvert felt har et
// dansk og et engelsk navn, og begge virker altid, så en skabelon kan deles på tværs af sprog.
// Resultatet følger programmets sprog (`ctx.lang`): dato, klokkeslæt, tusindtal og ugedag.
//
// Et ukendt felt er en fejl i kommandoen, aldrig tekst, der slipper ud i artiklen. Derfor
// udfolder `expandTemplate` intet, før hele skabelonen er godkendt. Teksten læses én gang fra
// venstre, så klammer i det markerede eller i navnet aldrig bliver læst som felter.
// Rene funktioner, testet med node --test.

import { tr, type Lang } from "../i18n.ts";
import type { CommandError, Expanded, FieldContext, Stop } from "./types.ts";

type DateFormat = "long" | "short" | "iso";
type Field =
  | { type: "date"; offset: number; format: DateFormat }
  | { type: "weekday" | "week" | "year"; offset: number }
  | { type: "time" | "name" | "filename" | "title" | "selection" | "words" | "characters" | "readingtime" }
  | { type: "cursor" }
  | { type: "stop"; index: number; text: string | null };

type Token = { kind: "text"; text: string } | { kind: "field"; raw: string; line: number };

/** Feltnavnene på begge sprog. Dem med dato i sig kan regne frem og tilbage (`{{dato+7}}`). */
const DATE_NAMES: Record<string, "date" | "weekday" | "week" | "year"> = {
  dato: "date",
  date: "date",
  ugedag: "weekday",
  weekday: "weekday",
  uge: "week",
  week: "week",
  år: "year",
  year: "year",
};
const PLAIN_NAMES: Record<string, "time" | "name" | "filename" | "title" | "selection" | "words" | "characters" | "readingtime" | "cursor"> = {
  tid: "time",
  time: "time",
  navn: "name",
  name: "name",
  filnavn: "filename",
  filename: "filename",
  titel: "title",
  title: "title",
  markering: "selection",
  selection: "selection",
  ord: "words",
  words: "words",
  anslag: "characters",
  characters: "characters",
  læsetid: "readingtime",
  readingtime: "readingtime",
  markør: "cursor",
  cursor: "cursor",
};
const FORMATS: Record<string, DateFormat> = { lang: "long", long: "long", kort: "short", short: "short", iso: "iso" };

/** Alle feltnavne, dansk og engelsk side om side. Til knapperne i formularen og til kataloget, sprogmodellen får. */
export const FIELD_NAMES: { da: string; en: string }[] = [
  { da: "dato", en: "date" },
  { da: "dato:kort", en: "date:short" },
  { da: "dato:iso", en: "date:iso" },
  { da: "dato+7", en: "date+7" },
  { da: "ugedag", en: "weekday" },
  { da: "uge", en: "week" },
  { da: "år", en: "year" },
  { da: "tid", en: "time" },
  { da: "navn", en: "name" },
  { da: "filnavn", en: "filename" },
  { da: "titel", en: "title" },
  { da: "markering", en: "selection" },
  { da: "ord", en: "words" },
  { da: "anslag", en: "characters" },
  { da: "læsetid", en: "readingtime" },
  { da: "markør", en: "cursor" },
  { da: "1:tekst", en: "1:text" },
];

/** Del skabelonen i tekst og felter. `\{{` er to bogstavelige klammer. */
function tokenize(body: string): { tokens: Token[]; errors: CommandError[] } {
  const tokens: Token[] = [];
  const errors: CommandError[] = [];
  let text = "";
  let line = 1;
  let i = 0;
  const flush = () => {
    if (text) tokens.push({ kind: "text", text });
    text = "";
  };
  while (i < body.length) {
    if (body.startsWith("\\{{", i)) {
      text += "{{";
      i += 3;
      continue;
    }
    if (body.startsWith("{{", i)) {
      const end = body.indexOf("}}", i + 2);
      const newline = body.indexOf("\n", i + 2);
      if (end === -1 || (newline !== -1 && newline < end)) {
        errors.push({ line, message: tr("Feltet mangler de to afsluttende klammer }}.", "The field is missing its two closing braces }}.") });
        text += "{{";
        i += 2;
        continue;
      }
      flush();
      tokens.push({ kind: "field", raw: body.slice(i + 2, end), line });
      i = end + 2;
      continue;
    }
    if (body[i] === "\n") line += 1;
    text += body[i];
    i += 1;
  }
  flush();
  return { tokens, errors };
}

/** Læs det, der står mellem klammerne. Null, når feltet ikke findes. */
function parseField(raw: string): Field | null {
  const stop = /^\s*([1-9])(?::([\s\S]*))?$/.exec(raw);
  if (stop) return { type: "stop", index: Number(stop[1]), text: stop[2] === undefined ? null : stop[2].trim() };
  const key = raw.trim().toLowerCase();
  const plain = PLAIN_NAMES[key];
  if (plain === "cursor") return { type: "cursor" };
  if (plain) return { type: plain };
  const m = /^([a-zæøå]+)\s*(?:([+-])\s*(\d{1,4}))?\s*(?::\s*([a-zæøå]+))?$/.exec(key);
  if (!m) return null;
  const type = DATE_NAMES[m[1]];
  if (!type) return null;
  const offset = m[3] ? Number(m[3]) * (m[2] === "-" ? -1 : 1) : 0;
  if (m[4] === undefined) return type === "date" ? { type, offset, format: "long" } : { type, offset };
  const format = FORMATS[m[4]];
  // Kun selve datoen har formater. »{{uge:kort}}« findes ikke.
  if (type !== "date" || !format) return null;
  return { type, offset, format };
}

/**
 * Fejlene i en skabelon med linjenummer i kroppen (1 = første linje). Tom liste: skabelonen kan
 * udfoldes. Ukendte felter, felter uden afslutning og mere end én `{{markør}}` er fejl.
 */
export function validateTemplate(body: string): CommandError[] {
  const { tokens, errors } = tokenize(body.replace(/\r\n?/g, "\n"));
  let cursors = 0;
  for (const t of tokens) {
    if (t.kind !== "field") continue;
    const field = parseField(t.raw);
    if (!field) {
      const shown = t.raw.trim().slice(0, 30);
      errors.push({ line: t.line, message: tr(`Feltet {{${shown}}} findes ikke.`, `There is no field called {{${shown}}}.`) });
      continue;
    }
    if (field.type === "cursor") {
      cursors += 1;
      if (cursors === 2) errors.push({ line: t.line, message: tr("Der kan kun være én {{markør}} i en skabelon.", "A template can only have one {{cursor}}.") });
    }
  }
  return errors.sort((a, b) => a.line - b.line);
}

const MONTHS_DA = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"];
// Samme korte former som editor/dates.ts, så en fodnote og en skabelon skriver måneden ens.
const MONTHS_DA_SHORT = ["jan.", "feb.", "marts", "april", "maj", "juni", "juli", "aug.", "sept.", "okt.", "nov.", "dec."];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_EN_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_DA = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const two = (n: number) => String(n).padStart(2, "0");

/** Datoen `days` dage fra `d`, på lokal tid. Kalenderen regner selv hen over måned, år og sommertid. */
export function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes());
}

/** ISO-ugen: uge 1 er ugen med årets første torsdag, og ugen begynder mandag. */
export function isoWeek(d: Date): number {
  // Regnet i UTC på den lokale dato, så sommertid ikke kan flytte en dag.
  const day = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  return Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** »5. oktober 2026«, »5. okt. 2026« eller »2026-10-05«. På engelsk »5 October 2026« og »5 Oct 2026«. */
export function formatDate(d: Date, format: DateFormat, lang: Lang): string {
  if (format === "iso") return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  if (lang === "en") return `${d.getDate()} ${(format === "long" ? MONTHS_EN : MONTHS_EN_SHORT)[d.getMonth()]} ${d.getFullYear()}`;
  return `${d.getDate()}. ${(format === "long" ? MONTHS_DA : MONTHS_DA_SHORT)[d.getMonth()]} ${d.getFullYear()}`;
}

/** »14.32« på dansk, »14:32« på engelsk. Altid 24 timer. */
export function formatTime(d: Date, lang: Lang): string {
  return `${two(d.getHours())}${lang === "en" ? ":" : "."}${two(d.getMinutes())}`;
}

/** Heltal med tusindtalstegn: »1.180« på dansk, »1,180« på engelsk. */
export function formatNumber(n: number, lang: Lang): string {
  const digits = String(Math.abs(Math.round(n)));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += lang === "en" ? "," : ".";
    out += digits[i];
  }
  return (n < 0 ? "-" : "") + out;
}

function value(field: Exclude<Field, { type: "stop" | "cursor" }>, ctx: FieldContext): string {
  switch (field.type) {
    case "date":
      return formatDate(addDays(ctx.now, field.offset), field.format, ctx.lang);
    case "weekday":
      return (ctx.lang === "en" ? WEEKDAYS_EN : WEEKDAYS_DA)[addDays(ctx.now, field.offset).getDay()];
    case "week":
      return String(isoWeek(addDays(ctx.now, field.offset)));
    case "year":
      return String(addDays(ctx.now, field.offset).getFullYear());
    case "time":
      return formatTime(ctx.now, ctx.lang);
    case "name":
      return ctx.name;
    case "filename":
      return ctx.filename;
    case "title":
      return ctx.title;
    case "selection":
      return ctx.selection;
    case "words":
      return formatNumber(ctx.words, ctx.lang);
    case "characters":
      return formatNumber(ctx.characters, ctx.lang);
    case "readingtime":
      // En tekst på tre linjer tager også »1« minut. Nul ligner en fejl.
      return formatNumber(Math.max(1, Math.round(ctx.readingMinutes)), ctx.lang);
  }
}

/**
 * Skabelonen med felterne sat ind. `stops` står i tekstens rækkefølge. Samme `index` flere steder
 * er samme stop og udfyldes samlet, og et stop uden egen tekst (`{{1}}`) låner teksten fra det
 * første med samme nummer. `cursor` er stedet for `{{markør}}`, ellers null.
 *
 * Kaster en fejl, hvis skabelonen ikke er gyldig. Kald `validateTemplate` først: en kommando, der
 * er læst med `parseCommand`, er allerede godkendt.
 */
export function expandTemplate(body: string, ctx: FieldContext): Expanded {
  const source = body.replace(/\r\n?/g, "\n");
  const errors = validateTemplate(source);
  if (errors.length) throw new Error(errors[0].message);
  const { tokens } = tokenize(source);
  const fields = tokens.map((t) => (t.kind === "field" ? parseField(t.raw) : null));
  const defaults = new Map<number, string>();
  for (const f of fields) {
    if (f?.type === "stop" && f.text !== null && !defaults.has(f.index)) defaults.set(f.index, f.text);
  }
  let text = "";
  const stops: Stop[] = [];
  let cursor: number | null = null;
  tokens.forEach((t, i) => {
    const field = fields[i];
    if (t.kind === "text" || !field) {
      if (t.kind === "text") text += t.text;
      return;
    }
    if (field.type === "cursor") {
      cursor = text.length;
      return;
    }
    if (field.type === "stop") {
      const shown = field.text ?? defaults.get(field.index) ?? "";
      stops.push({ index: field.index, from: text.length, to: text.length + shown.length });
      text += shown;
      return;
    }
    text += value(field, ctx);
  });
  return { text, stops, cursor };
}
