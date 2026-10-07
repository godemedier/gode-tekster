// Dansk og engelsk (5/10). Sproget følger Windows, til det vælges under Indstillinger, og
// Rust afgør det (i18n.rs), så fladen og Rust altid er enige. Hentes med top-level await, så
// sproget er kendt, før noget modul, der importerer `tr`, bygger sine tekster. Uden Tauri (tests)
// er det dansk.
//
// Teksterne står begge to ved kaldet: `tr("Gem", "Save")`. Så følger tal, flertal og ordstilling
// med i hvert sprog for sig, og der er ingen nøgler, der kan drive fra teksten.

import { invoke } from "@tauri-apps/api/core";

export type Lang = "da" | "en";

let lang: Lang = "da";
try {
  lang = (await invoke<Lang>("ui_language")) === "en" ? "en" : "da";
} catch {
  lang = "da";
}

export const currentLang = (): Lang => lang;
export const isEnglish = (): boolean => lang === "en";

/** Teksten på det aktuelle sprog. */
export function tr(da: string, en: string): string {
  return lang === "en" ? en : da;
}

/** Til datoer og tal: dansk eller britisk engelsk (dag før måned, 24-timers ur). */
export const locale = (): string => (lang === "en" ? "en-GB" : "da-DK");

/** Kun til tests: skift sproget uden Tauri. */
export function setLangForTest(l: Lang): void {
  lang = l;
}
