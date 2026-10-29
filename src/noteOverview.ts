// Oversigten ved uret (ADR-0068): et venstreklik på ikonet viser noterne, der er fremme, som små kort
// i deres egen farve. Søgefeltet søger i alle noter. Et klik på et kort henter noten frem, og
// oversigten går væk igen, når man klikker et andet sted. Rust ejer vinduet (tray.rs) og filerne (notes.rs).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { tr } from "./i18n.ts";
import { loadSettings, reloadSettings, settings } from "./settings.ts";
import { fontStack } from "./ui/settingspanel.ts";
import { followTheme } from "./ui/theme.ts";
import { errorText, showBanner } from "./ui/banner.ts";
import { matches, snippet } from "./noteSearch.ts";

type Note = { path: string; title: string; text: string; modified: number; open: boolean; color: string | null };

/** Uden noter fremme vises de nyeste. Ved søgning højst så mange kort. */
const NEWEST = 6;
const MAX_HITS = 20;

await loadSettings();
const applySettings = () => {
  const s = settings();
  document.documentElement.style.setProperty("--skrift", fontStack(s.font));
  followTheme(s.theme ?? (s.dark ? "moerk" : "lys"));
};
applySettings();
document.title = tr("Noter", "Notes");

const search = document.getElementById("no-search") as HTMLInputElement;
const cards = document.getElementById("no-cards") as HTMLElement;
const count = document.getElementById("no-count") as HTMLElement;
const heading = document.getElementById("no-heading") as HTMLElement;
const newButton = document.getElementById("no-new") as HTMLButtonElement;
const listButton = document.getElementById("no-list") as HTMLButtonElement;

(document.getElementById("no-title") as HTMLElement).textContent = tr("Noter", "Notes");
search.placeholder = tr("Søg i alle noter", "Search all notes");
search.setAttribute("aria-label", tr("Søg i alle noter", "Search all notes"));
cards.setAttribute("aria-label", tr("Noter", "Notes"));
newButton.textContent = tr("Ny note", "New note");
newButton.title = "Ctrl+N";
listButton.textContent = tr("Noteliste", "Note list");

let notes: Note[] = [];
let selected = 0;

const hide = () => void invoke("overview_hide");

async function run(command: string, args?: Record<string, unknown>): Promise<void> {
  try {
    await invoke(command, args);
    hide();
  } catch (e) {
    showBanner(errorText(e));
    await load();
  }
}

newButton.addEventListener("click", () => void run("note_new"));
listButton.addEventListener("click", () => void run("note_list_open"));

/** De kort, der vises: noterne fremme, ellers de nyeste. Ved søgning alle, der passer, de fremme først. */
function shown(): { list: Note[]; label: string | null } {
  const query = search.value.trim();
  if (query) {
    const hits = notes.filter((n) => matches(n, query));
    return { list: [...hits.filter((n) => n.open), ...hits.filter((n) => !n.open)].slice(0, MAX_HITS), label: null };
  }
  const open = notes.filter((n) => n.open);
  if (open.length) return { list: open, label: null };
  return { list: notes.slice(0, NEWEST), label: notes.length ? tr("Senest skrevet", "Recently written") : null };
}

function card(note: Note, i: number, query: string): HTMLElement {
  const c = document.createElement("div");
  c.className = "no-card";
  c.setAttribute("role", "option");
  c.dataset.farve = note.color ?? "gul";
  c.tabIndex = i === selected ? 0 : -1;
  c.setAttribute("aria-selected", String(i === selected));
  const title = document.createElement("b");
  title.textContent = note.title || tr("Tom note", "Empty note");
  const text = document.createElement("span");
  text.textContent = snippet(note, query);
  c.append(title, text);
  c.addEventListener("click", () => void run("note_open", { path: note.path }));
  return c;
}

function render(): void {
  const query = search.value.trim();
  const open = notes.filter((n) => n.open).length;
  count.textContent = open === 1 ? tr("1 fremme", "1 open") : open ? tr(`${open} fremme`, `${open} open`) : tr("ingen fremme", "none open");
  const { list, label } = shown();
  heading.hidden = !label;
  heading.textContent = label ?? "";
  selected = Math.min(selected, Math.max(0, list.length - 1));
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "no-empty";
    empty.textContent = query
      ? tr(`Ingen noter med »${query}«.`, `No notes with “${query}”.`)
      : tr("Ingen noter endnu. Tryk Win+Alt+N hvor som helst for at lave en.", "No notes yet. Press Win+Alt+N anywhere to make one.");
    cards.replaceChildren(empty);
    return;
  }
  cards.replaceChildren(...list.map((n, i) => card(n, i, query)));
}

function all(): HTMLElement[] {
  return [...cards.querySelectorAll<HTMLElement>(".no-card")];
}

function select(i: number): void {
  const list = all();
  if (!list.length) return;
  selected = Math.max(0, Math.min(list.length - 1, i));
  list.forEach((c, j) => {
    c.tabIndex = j === selected ? 0 : -1;
    c.setAttribute("aria-selected", String(j === selected));
  });
  list[selected].focus();
}

async function load(): Promise<void> {
  try {
    notes = await invoke<Note[]>("notes_list");
  } catch (e) {
    showBanner(errorText(e));
    notes = [];
  }
  render();
}

search.addEventListener("input", () => {
  selected = 0;
  render();
});
search.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") select(selected);
  else if (e.key === "Enter") all()[selected]?.click();
  else return;
  e.preventDefault();
});
// To kort i hver række: op og ned flytter to, til siderne én.
cards.addEventListener("keydown", (e) => {
  const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 };
  if (e.key in moves) {
    if (e.key === "ArrowUp" && selected < 2) search.focus();
    else select(selected + moves[e.key]);
  } else if (e.key === "Enter" || e.key === " ") all()[selected]?.click();
  else return;
  e.preventDefault();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "F5") e.preventDefault();
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    void run("note_new");
  } else if (e.key === "Escape" && !e.defaultPrevented) {
    if (search.value) {
      search.value = "";
      render();
      search.focus();
    } else hide();
  }
});

// Hver gang oversigten kommer frem: et tomt søgefelt og noterne, som de er nu.
await listen("overview-shown", () => {
  search.value = "";
  selected = 0;
  void load().then(() => search.focus());
});
await listen("notes-changed", () => void load());
await listen("settings-changed", () => void reloadSettings().then(applySettings));

await load();
search.focus();
// Første gang: Rust viser vinduet, når noterne er tegnet, så det ikke blinker hvidt.
await invoke("overview_ready");
