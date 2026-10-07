// Egne kommandoer og skabeloner med »/« (5/10). Kontrakten mellem delene: modellen
// (model.ts), felterne (fields.ts), klodserne (blocks.ts), tjekkene (checks.ts), de indbyggede
// (builtin.ts), lageret (store.ts), menuen og kørslen (slashMenu.ts, run.ts) og fanen
// (ui/commandsPanel.ts). Designet står i docs/research/2026-10-05-skraastreg-kommandoer.md del 3.
//
// Grænserne (ADR i ARKITEKTUR.md): ingen kode, ingen regulære udtryk, ingen adgang til andre filer
// og intet net fra en kommando. AI peger, spørger og tjekker, men formulerer aldrig tekst (5/10:
// svarformen »alternativer« er fravalgt). Alt, en kommando gør i teksten, er ét fortryd-trin.

import type { Lang } from "../i18n.ts";

export type Kind = "template" | "transform" | "check" | "ai";
/** AI-svarformer. Der findes ingen form, der kan rumme brødtekst. */
export type Output = "findings" | "questions";
/** Tasterne, en kommando kan få som genvej. F1, F7 og F11 er optaget. */
export const SHORTCUT_KEYS = ["F5", "F6", "F8", "F9"] as const;
export type ShortcutKey = (typeof SHORTCUT_KEYS)[number];

export type Command = {
  /** Det, man skriver efter »/«: små bogstaver (også æøå), tal og bindestreg, højst 24 tegn. */
  name: string;
  kind: Kind;
  /** Én linje, højst 80 tegn. */
  description: string;
  /** Flere navne. For de indbyggede står det andet sprogs navn her (skjult alias). */
  aliases: string[];
  scope: "selection" | "document";
  /** Skabelonen opretter en ny fil i stedet for at sætte ind ved markøren. */
  newfile: boolean;
  /** Kun kind "ai". */
  output?: Output;
  shortcut?: ShortcutKey;
  /** Vis kun på det sprog. Udeladt: vis altid. */
  lang?: Lang;
  /** Skabelonteksten, klodskæden, ordlisten (eller `builtin: <id>` for et indbygget tjek) eller instruksen. */
  body: string;
  source: "builtin" | "user";
  /** Filens sti for brugerens egne. */
  path?: string;
};

export type CommandError = { line: number; message: string };
export type ParseResult = { ok: true; command: Command } | { ok: false; errors: CommandError[] };

/** En fil fra brugerens mappe, som Rust leverer den (commands_list). */
export type CommandFile = { path: string; fileName: string; text: string; /** Sat, når filen er for stor eller ikke kan læses. Teksten er da tom. */ error?: string | null };
/** En fil, der ikke kunne læses som kommando: vises i fanen med fejlen. */
export type BrokenCommand = { path: string; fileName: string; errors: CommandError[] };

// --- felter (fields.ts) ------------------------------------------------------------------------

export type FieldContext = {
  now: Date;
  lang: Lang;
  /** »Dit navn« fra indstillingerne. */
  name: string;
  /** Filens navn uden endelse. */
  filename: string;
  /** Tekstens første overskrift, ellers filnavnet. */
  title: string;
  selection: string;
  words: number;
  characters: number;
  readingMinutes: number;
};

/** Et markørstop i den udfoldede tekst. Samme `index` udfyldes samlet. */
export type Stop = { index: number; from: number; to: number };
export type Expanded = { text: string; stops: Stop[]; /** `{{markør}}`: her ender markøren. */ cursor: number | null };

// --- klodser (blocks.ts) -----------------------------------------------------------------------

export type Step = { block: string; args: string[]; line: number };
/**
 * Resultatet af en kæde. `text` sættes ind i stedet for området. `then` er en afsluttende handling,
 * som editoren selv udfører på den nye tekst (de kan ikke udtrykkes som ren tekst).
 */
export type ChainResult = { text: string; then: "clip" | "footnote" | null };

// --- tjek og AI-svar ---------------------------------------------------------------------------

/** Et fund i teksten. `from`/`to` er positioner i den tekst, tjekket fik. */
export type Finding = { from: number; to: number; excerpt: string; comment: string };

export type CommandResult =
  | { kind: "findings"; title: string; findings: Finding[]; /** Fx »Ingen fund.« eller hvem der svarede. */ note?: string }
  | { kind: "questions"; title: string; questions: string[]; note?: string };

/** Svaret fra Rust-kommandoen `ai_command`. Uddrag, der ikke står ordret i teksten, er kasseret. */
export type AiCommandAnswer = { findings: { excerpt: string; comment: string }[]; questions: string[]; provider: string };

/** Svaret fra `ai_design_command`: én kommando som felter, eller et nej med begrundelse. */
export type AiDesign = {
  possible: boolean;
  reason: string;
  name: string;
  description: string;
  kind: Kind;
  body: string;
  output: Output | "";
  scope: "selection" | "document";
};

// --- det, kørslen har brug for udefra (run.ts får det fra main.ts) -------------------------------

export type CommandHooks = {
  /** Navn, filnavn og titel til felterne. */
  fileContext(): { name: string; filename: string; title: string };
  /** Vis et resultat i højre spalte (tjek og AI). Skriver intet i teksten. */
  showResult(result: CommandResult): void;
  /**
   * Kør en AI-kommando: spørger om lov som resten af AI-hjælpen, viser prompten første gang,
   * kalder `ai_command` og viser svaret. `offset` er tekstens plads i dokumentet, så fund kan springes til.
   */
  runAi(command: Command, text: string, offset: number): void;
  /** Opret en ny tekst med indholdet (newfile-skabeloner). */
  newFile(text: string): Promise<void>;
  /** En kort kvittering eller fejl i beskedlinjen. */
  notify(message: string): void;
};
