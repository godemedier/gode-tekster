// Beskedlinjen øverst: et valg, brugeren skal træffe, eller en kort kvittering (notify). Én linje
// ad gangen, men en kø bagved (personatjek 2/10): et valg går altid forrest, så en kvittering
// aldrig kan skubbe et ventende valg væk, mens autosave venter på det. Hver besked har et nummer,
// så et modul kun skjuler sine egne.

import { tr } from "../i18n.ts";

export type Action = { label: string; run: () => void | Promise<void> };

type Entry = { id: number; message: string; actions: Action[]; choice: boolean; closable: boolean; perText?: boolean };
/** closable: kan også bare lukkes (×), og handlingerne lukker den. perText: hører til den åbne tekst. */
export type BannerOptions = { closable?: boolean; perText?: boolean };

const el = (): HTMLElement => document.getElementById("banner") as HTMLElement;

let next = 0;
let queue: Entry[] = [];

/** Det, der skal vises: det nyeste valg, ellers den nyeste kvittering. */
function render(): void {
  const box = el();
  const top = [...queue].reverse().find((e) => e.choice) ?? queue[queue.length - 1];
  if (!top) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const text = document.createElement("span");
  text.textContent = top.message;
  const buttons = top.actions.map((a) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.label;
    b.addEventListener("click", () => {
      void a.run();
    });
    return b;
  });
  if (top.closable) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "banner-close";
    close.textContent = "×";
    close.title = tr("Luk", "Close");
    close.setAttribute("aria-label", tr("Luk beskeden", "Close the message"));
    close.addEventListener("click", () => hideBanner(top.id));
    buttons.push(close);
  }
  box.replaceChildren(text, ...buttons);
  box.hidden = false;
}

/**
 * Vis en besked. Med handlinger er det et valg, der bliver stående, til en handling skjuler det.
 * Uden handlinger får beskeden en »OK«, så den altid kan lukkes. Returnerer nummeret til `hideBanner`.
 */
export function showBanner(message: string, actions: Action[] = [], opts: BannerOptions = {}): number {
  const id = ++next;
  const choice = actions.length > 0;
  // closable: en kvittering med handlinger, man også bare kan lukke (×). Handlingerne lukker den.
  const run = (a: Action): Action => ({ label: a.label, run: () => (hideBanner(id), a.run()) });
  queue.push({
    id,
    message,
    choice: true,
    closable: Boolean(opts.closable),
    perText: opts.perText,
    actions: !choice ? [{ label: "OK", run: () => hideBanner(id) }] : opts.closable ? actions.map(run) : actions,
  });
  render();
  return id;
}

/** Skjul en besked. Uden nummer: den, der står nu (en handling i den har lukket den). */
export function hideBanner(id?: number): void {
  if (id === undefined) {
    const shown = [...queue].reverse().find((e) => e.choice) ?? queue[queue.length - 1];
    if (!shown) return;
    id = shown.id;
  }
  queue = queue.filter((e) => e.id !== id);
  render();
}

/**
 * En anden tekst er åbnet: beskeder, der hørte til den forrige, forsvinder (5/10: kvitteringen
 * efter Skær fulgte med over i den næste artikel).
 */
export function clearTextBanners(): void {
  if (!queue.some((e) => e.perText)) return;
  queue = queue.filter((e) => !e.perText);
  render();
}

/** En kvittering uden valg. Står 4 s (længere, mens musen er over den) og skubber aldrig et valg væk. */
export function notify(message: string): void {
  const id = ++next;
  queue.push({ id, message, choice: false, closable: true, actions: [] });
  render();
  const expire = () => {
    if (el().matches(":hover")) window.setTimeout(expire, 1000);
    else hideBanner(id);
  };
  window.setTimeout(expire, 4000);
}

/** Fejlen fra et Rust-kald som tekst. Kommandoerne sender enten en streng eller {kind, message}. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
