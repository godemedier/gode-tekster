// Lageret for »/«-kommandoerne (plan 2026-10-05): de indbyggede på programmets sprog plus brugerens
// egne filer fra kommandomappen, som Rust læser (commands.rs). En egen kommando skygger for en
// indbygget med samme navn, en fil med fejl lægges til side med linjenummer, og hvad der er slået
// fra, står i indstillingerne. Selve sammenlægningen er en ren funktion (mergeCommands) med tests.

import { invoke } from "@tauri-apps/api/core";

import { currentLang, tr, type Lang } from "../i18n.ts";
import { settings, updateSettings, type Settings } from "../settings.ts";
import { builtinCommands } from "./builtin.ts";
import { fileNameFor, parseCommand, serializeCommand } from "./model.ts";
import type { BrokenCommand, Command, CommandFile, ParseResult } from "./types.ts";

export type Entry = { command: Command; enabled: boolean };
export type Merged = { entries: Entry[]; broken: BrokenCommand[] };
/** Rust sætter `error`, når en fil ikke kunne læses (for stor eller ulæselig). `text` er da tom. */
export type ListedFile = CommandFile & { error?: string | null };

/**
 * Læg indbyggede og egne sammen. Egne står først og skygger for en indbygget med samme navn.
 * En fil, der ikke kan læses, eller som gentager et navn fra en anden fil, lægges til side.
 * Indbyggede på det andet sprog tages ikke med. Egne med `lang` beholdes her, så fanen kan vise dem.
 */
export function mergeCommands(
  builtin: Command[],
  files: ListedFile[],
  parse: (text: string, source: "user", path: string) => ParseResult,
  disabled: string[],
  lang: Lang,
  duplicate: (name: string) => string = (name) => `/${name}`,
): Merged {
  const off = new Set(disabled);
  const own: Command[] = [];
  const broken: BrokenCommand[] = [];
  const names = new Set<string>();
  for (const f of [...files].sort((a, b) => a.fileName.localeCompare(b.fileName, lang))) {
    if (f.error) {
      broken.push({ path: f.path, fileName: f.fileName, errors: [{ line: 0, message: f.error }] });
      continue;
    }
    const r = parse(f.text, "user", f.path);
    if (!r.ok) {
      broken.push({ path: f.path, fileName: f.fileName, errors: r.errors });
    } else if (names.has(r.command.name)) {
      broken.push({ path: f.path, fileName: f.fileName, errors: [{ line: 1, message: duplicate(r.command.name) }] });
    } else {
      names.add(r.command.name);
      own.push({ ...r.command, source: "user", path: f.path });
    }
  }
  const rest = builtin.filter((c) => !names.has(c.name) && (!c.lang || c.lang === lang));
  return { entries: [...own, ...rest].map((command) => ({ command, enabled: !off.has(command.name) })), broken };
}

/** Det, menuen må vise: uden slåede fra og uden kommandoer til det andet sprog. */
export function visibleCommands(entries: Entry[], lang: Lang): Command[] {
  return entries.filter((e) => e.enabled && (!e.command.lang || e.command.lang === lang)).map((e) => e.command);
}

/** Senest brugte: nyeste først, uden gentagelser, højst tre. */
export function withRecent(list: string[], name: string): string[] {
  return [name, ...list.filter((n) => n !== name)].slice(0, 3);
}

// --- tilstanden -----------------------------------------------------------------------------------

let files: ListedFile[] = [];
let merged: Merged | null = null;
const listeners: (() => void)[] = [];

function disabledNames(): string[] {
  try {
    return (settings() as Settings & { disabledCommands?: string[] }).disabledCommands ?? [];
  } catch {
    return []; // indstillingerne er ikke indlæst endnu
  }
}

function rebuild(): void {
  merged = mergeCommands(builtinCommands(currentLang()), files, parseCommand, disabledNames(), currentLang(), (name) =>
    tr(`En anden fil hedder allerede /${name}. Giv den ene et andet navn.`, `Another file is already named /${name}. Rename one of them.`),
  );
  for (const l of listeners) l();
}

function state(): Merged {
  if (!merged) merged = mergeCommands(builtinCommands(currentLang()), [], parseCommand, disabledNames(), currentLang());
  return merged;
}

/** Læs mappen igen. Kan den ikke læses, gælder de indbyggede alene, og fejlen kastes videre. */
export async function loadCommands(): Promise<void> {
  try {
    files = await invoke<ListedFile[]>("commands_list");
  } catch (e) {
    files = [];
    rebuild();
    throw e;
  }
  rebuild();
}

/** Egne først (de skygger for indbyggede med samme navn), uden slåede fra og uden forkert sprog. */
export function allCommands(): Command[] {
  return visibleCommands(state().entries, currentLang());
}

export function brokenCommands(): BrokenCommand[] {
  return state().broken;
}

/** Til fanen: alle, også de slåede fra. */
export function everyCommand(): Entry[] {
  return state().entries;
}

export async function setEnabled(name: string, on: boolean): Promise<void> {
  const next = new Set(disabledNames());
  if (on) next.delete(name);
  else next.add(name);
  const patch: Partial<Settings> & { disabledCommands: string[] } = { disabledCommands: [...next].sort() };
  await updateSettings(patch);
  rebuild();
}

/** Gem en egen kommando som fil. `previousPath`: filen, den afløser (omdøbning eller rettelse). */
export async function saveUserCommand(c: Command, previousPath?: string): Promise<void> {
  const command: Command = { ...c, source: "user" };
  await invoke<string>("command_save", { fileName: fileNameFor(command), text: serializeCommand(command), previousPath: previousPath ?? null });
  await loadCommands();
}

/** Til papirkurven. */
export async function deleteUserCommand(path: string): Promise<void> {
  await invoke("command_delete", { path });
  await loadCommands();
}

const RECENT_KEY = "gt-commands-recent";

export function recentNames(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string").slice(0, 3) : [];
  } catch {
    return [];
  }
}

export function markUsed(name: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(withRecent(recentNames(), name)));
  } catch {
    // Lagringen kan være spærret. Så huskes de senest brugte ikke.
  }
}

/** Kaldes, når listen er læst igen, eller noget er slået til eller fra. */
export function onCommandsChanged(cb: () => void): void {
  listeners.push(cb);
}
