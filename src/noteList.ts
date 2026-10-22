// Notelisten (ADR-0050): alle noter i Noter-mappen, også dem, der er lukket, med søgning og
// papirkurven. Dobbeltklik eller Enter åbner noten på sin gamle plads. Ctrl+H fra et ark, »Noteliste«
// i menuen ved uret og springlisten åbner vinduet. Rust ejer filerne (notes.rs).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { locale, tr } from "./i18n.ts";
import { loadSettings, reloadSettings, settings } from "./settings.ts";
import { fontStack } from "./ui/settingspanel.ts";
import { followTheme } from "./ui/theme.ts";
import { showMenu } from "./ui/menu.ts";
import { errorText, showBanner } from "./ui/banner.ts";
import { matches, snippet } from "./noteSearch.ts";

type Note = { path: string; title: string; text: string; modified: number; open: boolean; color: string | null };
type Trashed = { id: string; name: string; deleted: number };

await loadSettings();
function applySettings(): void {
  const s = settings();
  document.documentElement.style.setProperty("--skrift", fontStack(s.font));
  followTheme(s.theme ?? (s.dark ? "moerk" : "lys"));
}
applySettings();
document.title = tr("Noter", "Notes");

const search = document.getElementById("nl-search") as HTMLInputElement;
const list = document.getElementById("nl-list") as HTMLElement;
const trash = document.getElementById("nl-trash") as HTMLDetailsElement;
const trashList = document.getElementById("nl-trash-list") as HTMLElement;
const newButton = document.getElementById("nl-new") as HTMLButtonElement;

search.placeholder = tr("Søg i noterne", "Search notes");
search.setAttribute("aria-label", tr("Søg i noterne", "Search notes"));
list.setAttribute("aria-label", tr("Noter", "Notes"));
newButton.textContent = tr("Ny note", "New note");
newButton.title = "Ctrl+N";
newButton.addEventListener("click", () => void invoke("note_new").catch((e) => showBanner(errorText(e))));

let notes: Note[] = [];
let selected: string | null = null;

function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(locale(), sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

async function openNote(path: string): Promise<void> {
  try {
    await invoke("note_open", { path });
  } catch (e) {
    showBanner(errorText(e));
    await load();
  }
}

async function trashNote(path: string): Promise<void> {
  try {
    if (await invoke<boolean>("note_trash", { path })) await load();
  } catch (e) {
    showBanner(errorText(e));
  }
}

function row(note: Note, query: string): HTMLElement {
  const r = document.createElement("div");
  r.className = "nl-row";
  r.tabIndex = -1;
  r.setAttribute("role", "option");
  r.dataset.path = note.path;
  r.dataset.farve = note.color ?? "gul";
  r.setAttribute("aria-selected", String(note.path === selected));
  const dot = document.createElement("span");
  dot.className = "nl-dot";
  const main = document.createElement("div");
  main.className = "nl-main";
  const head = document.createElement("div");
  head.className = "nl-head";
  const title = document.createElement("span");
  title.className = "nl-title";
  title.textContent = note.title || tr("Tom note", "Empty note");
  const time = document.createElement("span");
  time.className = "nl-time";
  time.textContent = note.open ? `${tr("fremme", "open")} · ${when(note.modified)}` : when(note.modified);
  head.append(title, time);
  const text = document.createElement("div");
  text.className = "nl-snippet";
  text.textContent = snippet(note, query);
  main.append(head, text);
  const more = document.createElement("button");
  more.type = "button";
  more.className = "nl-more";
  more.textContent = "⋯";
  more.title = tr("Mere", "More");
  more.setAttribute("aria-label", tr(`Mere om ${note.title || "noten"}`, `More about ${note.title || "the note"}`));
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    select(note.path);
    const b = more.getBoundingClientRect();
    showMenu(Math.max(4, b.right - 190), b.bottom + 4, [
      { label: tr("Åbn note", "Open note"), run: () => void openNote(note.path) },
      { separator: true },
      { label: tr("Læg i papirkurven", "Move to Recycle Bin"), run: () => void trashNote(note.path) },
    ]);
  });
  r.append(dot, main, more);
  r.addEventListener("click", () => select(note.path));
  r.addEventListener("dblclick", () => void openNote(note.path));
  return r;
}

function rows(): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(".nl-row")];
}

function select(path: string, focus = true): void {
  selected = path;
  for (const r of rows()) {
    const on = r.dataset.path === path;
    r.setAttribute("aria-selected", String(on));
    r.tabIndex = on ? 0 : -1;
    if (on && focus) r.focus();
  }
}

function render(): void {
  const query = search.value.trim();
  const shown = notes.filter((n) => matches(n, query));
  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "nl-empty";
    empty.textContent = notes.length
      ? tr(`Ingen noter med »${query}«.`, `No notes with “${query}”.`)
      : tr("Ingen noter endnu. Tryk Ctrl+N her eller Win+Alt+N hvor som helst for at lave en.", "No notes yet. Press Ctrl+N here or Win+Alt+N anywhere to make one.");
    list.replaceChildren(empty);
    return;
  }
  if (!shown.some((n) => n.path === selected)) selected = shown[0].path;
  list.replaceChildren(...shown.map((n) => row(n, query)));
  const current = rows().find((r) => r.dataset.path === selected);
  if (current) current.tabIndex = 0;
}

async function renderTrash(): Promise<void> {
  let items: Trashed[] = [];
  try {
    items = await invoke<Trashed[]>("notes_trashed");
  } catch {
    items = [];
  }
  trash.hidden = items.length === 0;
  (trash.querySelector("summary") as HTMLElement).textContent = tr(`Papirkurven (${items.length})`, `Recycle Bin (${items.length})`);
  trashList.replaceChildren(
    ...items.slice(0, 50).map((t) => {
      const r = document.createElement("div");
      r.className = "nl-trashed";
      const name = document.createElement("span");
      name.textContent = t.name;
      const date = document.createElement("small");
      date.textContent = tr(`slettet ${when(t.deleted * 1000)}`, `deleted ${when(t.deleted * 1000)}`);
      const back = document.createElement("button");
      back.type = "button";
      back.textContent = tr("Hent tilbage", "Restore");
      back.addEventListener("click", async () => {
        back.disabled = true;
        try {
          await invoke("note_restore", { id: t.id });
          await load();
        } catch (e) {
          back.disabled = false;
          showBanner(errorText(e));
        }
      });
      r.append(name, date, back);
      return r;
    }),
  );
}

async function load(): Promise<void> {
  try {
    notes = await invoke<Note[]>("notes_list");
  } catch (e) {
    showBanner(errorText(e));
    notes = [];
  }
  render();
  void renderTrash();
}

search.addEventListener("input", render);
search.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    const first = rows().find((r) => r.dataset.path === selected) ?? rows()[0];
    if (first?.dataset.path) select(first.dataset.path);
  } else if (e.key === "Enter" && selected) {
    e.preventDefault();
    void openNote(selected);
  } else if (e.key === "Escape" && search.value) {
    e.preventDefault();
    e.stopPropagation();
    search.value = "";
    render();
  }
});
list.addEventListener("keydown", (e) => {
  const all = rows();
  const i = all.findIndex((r) => r.dataset.path === selected);
  const go = (j: number) => {
    const r = all[Math.max(0, Math.min(all.length - 1, j))];
    if (r?.dataset.path) select(r.dataset.path);
  };
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") {
    if (i <= 0) search.focus();
    else go(i - 1);
  } else if (e.key === "Home") go(0);
  else if (e.key === "End") go(all.length - 1);
  else if (e.key === "Enter" && selected) void openNote(selected);
  else if (e.key === "Delete" && selected) void trashNote(selected);
  else return;
  e.preventDefault();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "F5") e.preventDefault();
  if (e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "n") void invoke("note_new").catch((err) => showBanner(errorText(err)));
    else if (k === "f") search.focus();
    else if (k === "w") void invoke("note_list_close");
    else if (k !== "r") return;
    e.preventDefault();
  } else if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".menu")) {
    void invoke("note_list_close");
  }
});

// Listen følger med, når et ark kommer til, lukkes eller slettes, og når vinduet får fokus igen
// (noter skrevet i mellemtiden).
await listen("notes-changed", () => void load());
await listen("settings-changed", () => void reloadSettings().then(applySettings));
window.addEventListener("focus", () => void load());

await load();
search.focus();
