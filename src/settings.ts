// Indstillingerne fra Rust (`settings.rs`). Ét sted i fladen, så alle moduler ser det samme.

import { invoke } from "@tauri-apps/api/core";

import { errorText, showBanner } from "./ui/banner.ts";
import { tr } from "./i18n.ts";

/** Punkttegnene: skærm, udskrift og Word. Stregen er standarden. Stjerne og ring er fra skrivemaskinen. */
export const BULLETS = { streg: "–", prik: "•", pil: "→", stjerne: "*", ring: "○" } as const;
export type BulletStyle = keyof typeof BULLETS;
export const bulletChar = (s: Pick<Settings, "bulletStyle">): string => BULLETS[s.bulletStyle] ?? BULLETS.streg;

export type Settings = {
  libraries: string[];
  font: string;
  /** »Dit navn« til byline og forfatterskab. null: Office-brugernavnet bruges (settings.rs). */
  authorName: string | null;
  /** AI-hjælpen: "claude", "codex", "gemini" eller "mistral". null: den første, der er klar (ai.rs). */
  aiProvider: string | null;
  lineLength: number;
  quotes: "guillemets" | "curly" | "low";
  alwaysShowCount: boolean;
  showAuthorship: boolean;
  /** Afløst af theme (8/10). Kun fra ældre indstillingsfiler. */
  dark: boolean;
  /** Udseendet: lys, mørk, aften eller »Skifter selv« (ADR-0037). */
  theme: "lys" | "moerk" | "aften" | "auto";
  /** Statusserne i biblioteket (ADR-0038). Den sidste betyder færdig. */
  statuses: { id: string; name: string }[];
  startWithWindows: boolean;
  checkUpdates: boolean;
  /** Afsnit som på nettet (luft) eller som i bøger (indryk). */
  paragraphs: "luft" | "indryk";
  /** Punkttegn i lister (5/10). */
  bulletStyle: BulletStyle;
  /** Ordklasser, der ikke farves (fanen Sprog). */
  hiddenWordClasses: string[];
  /** Stjernemarkerede mapper og filer i biblioteket (ui/stars.ts). */
  starred: string[];
  /** Sproget: "auto" følger Windows (i18n.ts). Skift genindlæser vinduerne. */
  language: "auto" | "da" | "en";
  showHouseFiles: boolean;
  focusMode: boolean;
  typewriter: boolean;
  /** Sluk wifi, mens Ro på (F11) er slået til. */
  roWifi: boolean;
  /** Afløst af markMode (7/10). Kun fra ældre indstillingsfiler. */
  hideMarks: boolean;
  /** Visning af markdown: aldrig tegn, tegn ved markøren, altid tegn, eller kun ren markdown (7/10). */
  markMode: "skjul" | "markoer" | "alle" | "raa";
  /** Mappen med egne kommandoer (commands.rs). Sættes kun af Rust. */
  commandsDir: string | null;
  /** Kommandoer, der er slået fra i fanen Kommandoer (navne). */
  disabledCommands: string[];
  wordClasses: boolean;
  /** Kommatjek i stiltjekket: med startkomma, uden startkomma eller fra (7/10). */
  commaStyle: "start" | "uden" | "fra";
  styleCheck: boolean;
  sortBy: "date" | "name";
  newestFirst: boolean;
  foldersFirst: boolean;
};

let current: Settings | null = null;
const listeners: ((s: Settings) => void)[] = [];

export async function loadSettings(): Promise<Settings> {
  current = await invoke<Settings>("get_settings");
  return current;
}

/** Et andet vindue har ændret indstillingerne: hent dem og tegn om. */
export async function reloadSettings(): Promise<void> {
  current = await invoke<Settings>("get_settings");
  for (const l of listeners) l(current);
}

export function settings(): Settings {
  if (!current) throw new Error(tr("Indstillingerne er ikke indlæst endnu.", "The settings haven't loaded yet."));
  return current;
}

/** Ændringen slår igennem med det samme. Kan den ikke gemmes, siges det, men den gælder resten af kørslen. */
export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  current = { ...settings(), ...patch };
  for (const l of listeners) l(current);
  try {
    await invoke("save_settings", { settings: current });
  } catch (e) {
    showBanner(errorText(e));
  }
}

/** Bibliotekerne ændres kun i Rust (add_library/remove_library). Her opdateres fladens kopi. */
export function setLibraries(libraries: string[]): void {
  current = { ...settings(), libraries };
  for (const l of listeners) l(current);
}

export function onSettings(listener: (s: Settings) => void): void {
  listeners.push(listener);
}
