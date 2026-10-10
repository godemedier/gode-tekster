// En note på skrivebordet (ADR-0039): én .md-fil i Noter-mappen i et lille rammeløst vindue, med
// samme editor og autosave som teksterne. Rust ejer filen (document.rs) og arkets placering (notes.rs).
//
// Ctrl+N laver en ny note, Ctrl+W lukker arket (en tom note efterlader ingen fil), Ctrl+D lægger
// noten i papirkurven. Dobbeltklik på toppen ruller arket op til første linje.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { EditorView } from "@codemirror/view";

import { DocumentSession, type DocumentDto } from "./document.ts";
import { tr } from "./i18n.ts";
import { loadSettings, reloadSettings, settings } from "./settings.ts";
import { colorChange, findColor, NOTE_COLORS, type NoteColor } from "./editor/textStatus.ts";
import { withoutParked } from "./editor/parked.ts";
import { fontStack } from "./ui/settingspanel.ts";
import { followTheme } from "./ui/theme.ts";
import { showMenu } from "./ui/menu.ts";
import { errorText, showBanner } from "./ui/banner.ts";

await loadSettings();
const body = document.body;
const top = document.querySelector<HTMLElement>(".note-top")!;
const title = document.querySelector<HTMLElement>(".note-title")!;
const tools = document.querySelector<HTMLElement>(".note-tools")!;
const view = new EditorView({ parent: document.getElementById("editor")! });

function applySettings(): void {
  const s = settings();
  document.documentElement.lang = s.textLanguage || document.documentElement.lang;
  document.documentElement.style.setProperty("--skrift", fontStack(s.font));
  followTheme(s.theme ?? (s.dark ? "moerk" : "lys"));
}
applySettings();

const SVG = {
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  pin: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M8 3h8l-1 6 3 3v2H6v-2l3-3z"/></svg>',
  more: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
};
const COLOR_NAMES: Record<NoteColor, string> = {
  gul: tr("Gul", "Yellow"),
  groen: tr("Grøn", "Green"),
  blaa: tr("Blå", "Blue"),
  rosa: tr("Rosa", "Pink"),
  papir: tr("Papir", "Paper"),
  graa: tr("Grå", "Grey"),
};

function button(svg: string, label: string, run: (b: HTMLButtonElement) => void, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.innerHTML = svg;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    run(b);
  });
  return b;
}

// --- teksten -----------------------------------------------------------------------------------

const dto = await invoke<DocumentDto | null>("initial_document").catch((e) => {
  showBanner(errorText(e));
  return null;
});
let session: DocumentSession | null = null;
let lookTimer: number | undefined;
if (dto) session = DocumentSession.load(view, dto, () => changed());

/** Det, noten siger, uden den skjulte farvelinje. */
const words = () => withoutParked(view.state.doc.toString()).trim();

function changed(): void {
  session?.changed();
  window.clearTimeout(lookTimer);
  lookTimer = window.setTimeout(showLook, 150);
}

/** Farven og navnet i toppen (vises, når arket er rullet op). */
function showLook(): void {
  showColor();
  title.textContent = words().split("\n")[0]?.replace(/^#+\s*/, "") || tr("Tom note", "Empty note");
}

// --- farve, hold øverst, rul op ----------------------------------------------------------------

function showColor(): void {
  body.dataset.farve = findColor(view.state.doc.toString())?.color ?? "gul";
}

const palette = document.createElement("div");
palette.className = "note-colors";
palette.hidden = true;
palette.setAttribute("role", "group");
palette.setAttribute("aria-label", tr("Farve", "Colour"));
for (const c of NOTE_COLORS) {
  const b = document.createElement("button");
  b.type = "button";
  b.title = COLOR_NAMES[c];
  b.setAttribute("aria-label", COLOR_NAMES[c]);
  b.dataset.farve = c;
  b.addEventListener("click", () => {
    view.dispatch({ changes: colorChange(view.state.doc.toString(), c), userEvent: "input.color" });
    palette.hidden = true;
    view.focus();
  });
  palette.append(b);
}
document.body.append(palette);
function paintPalette(): void {
  for (const b of palette.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String(b.dataset.farve === body.dataset.farve));
}

const swatch = button('<span class="note-swatch"></span>', tr("Farve", "Colour"), () => {
  paintPalette();
  palette.hidden = !palette.hidden;
});

let pinned = false;
const pin = button(SVG.pin, tr("Hold øverst", "Keep on top"), () => void setPinned(!pinned), "note-pin");
async function setPinned(on: boolean): Promise<void> {
  pinned = on;
  body.classList.toggle("pinned", on);
  pin.setAttribute("aria-pressed", String(on));
  pin.title = on ? tr("Holdes øverst. Klik for at slippe", "Kept on top. Click to release") : tr("Hold øverst", "Keep on top");
  await invoke("note_on_top", { on });
}

let rolled = false;
async function setRolled(on: boolean): Promise<void> {
  rolled = on;
  body.classList.toggle("rolled", on);
  await invoke("note_roll", { rolled: on });
  if (!on) view.focus();
}
// Træk i toppen flytter arket. Dobbeltklik ruller det op (Tauris egen trækzone ville maksimere).
top.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.detail > 1 || (e.target as HTMLElement).closest("button")) return;
  void getCurrentWindow().startDragging();
});
top.addEventListener("dblclick", (e) => {
  if ((e.target as HTMLElement).closest("button")) return;
  void setRolled(!rolled);
});

// --- luk, slet, åbn som tekst ------------------------------------------------------------------

async function closeNote(): Promise<void> {
  document.body.inert = true;
  try {
    await session?.close();
    await invoke("note_close", { empty: words() === "" });
  } catch (e) {
    document.body.inert = false;
    showBanner(errorText(e));
  }
}

async function openAsText(): Promise<void> {
  document.body.inert = true;
  try {
    await session?.saveForHandoff();
    await invoke("note_as_text");
  } catch (e) {
    document.body.inert = false;
    showBanner(errorText(e));
  }
}

async function deleteNote(): Promise<void> {
  try {
    if (!await invoke<boolean>("confirm_note_delete")) return;
    document.body.inert = true;
    await session?.saveForHandoff();
    await invoke("note_delete");
  } catch (e) {
    document.body.inert = false;
    showBanner(errorText(e));
  }
}

const more = button(SVG.more, tr("Mere", "More"), (b) => {
  const r = b.getBoundingClientRect();
  showMenu(Math.max(4, r.right - 200), r.bottom + 4, [
    { label: tr("Ny note (Ctrl+N)", "New note (Ctrl+N)"), run: () => void invoke("note_new") },
    { label: tr("Åbn som tekst", "Open as text"), run: () => void openAsText() },
    { separator: true },
    { label: tr("Rul op (dobbeltklik på toppen)", "Roll up (double-click the top)"), run: () => void setRolled(!rolled) },
    { label: tr("Luk (Ctrl+W)", "Close (Ctrl+W)"), run: () => void closeNote() },
    { label: tr("Læg i papirkurven (Ctrl+D)", "Move to Recycle Bin (Ctrl+D)"), run: () => void deleteNote() },
  ]);
});

tools.append(button(SVG.plus, tr("Ny note (Ctrl+N)", "New note (Ctrl+N)"), () => void invoke("note_new")), swatch, pin, more);

window.addEventListener("keydown", (e) => {
  if (!e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "r") {
    e.preventDefault();
    return;
  }
  if (k === "n") void invoke("note_new");
  else if (k === "w") void closeNote();
  else if (k === "d") void deleteNote();
  else return;
  e.preventDefault();
  e.stopPropagation();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "F5") e.preventDefault();
  if (e.key === "Escape" && !palette.hidden) palette.hidden = true;
});
window.addEventListener("blur", () => void session?.flush());

// Kun hændelser til dette ark (emit_to): `listen` alene hører alle vinduers.
const here = getCurrentWebviewWindow();
await here.listen("close-requested", () => void closeNote());
await listen("quit-requested", () => {
  document.body.inert = true;
  void (async () => {
    try {
      await session?.prepareExit();
      await invoke("quit_app");
    } catch (e) {
      document.body.inert = false;
      await invoke("cancel_quit");
      showBanner(errorText(e));
    }
  })();
});
await listen("quit-cancelled", () => { document.body.inert = false; });
await listen<string>("file-changed", (e) => {
  if (session && session.path.toLowerCase() === e.payload.toLowerCase()) void session.externalChange().then(showLook);
});
await listen("settings-changed", () => void reloadSettings().then(applySettings));

// Testkørsler (measure.ts, scenariet »noter«): hovedvinduet skriver i noten, sætter farve, holder
// den øverst, ruller den op eller lukker den. Kun når programmet kører et scenarie.
type TestStep = { text?: string; color?: NoteColor; pin?: boolean; roll?: boolean; close?: boolean; audit?: boolean };
if ((await invoke<{ scenario: string | null }>("test_mode").catch(() => ({ scenario: null }))).scenario) {
  await getCurrentWebviewWindow().listen<TestStep>("gt-test-note", async (e) => {
    const s = e.payload;
    if (s.text) view.dispatch({ changes: { from: 0, insert: s.text }, userEvent: "input.type" });
    if (s.color) view.dispatch({ changes: colorChange(view.state.doc.toString(), s.color), userEvent: "input.color" });
    if (s.pin) await setPinned(true);
    if (s.roll) await setRolled(true);
    if (s.audit) {
      const padding = parseFloat(getComputedStyle(document.getElementById("editor")!).paddingBottom);
      const gap = window.innerHeight - view.dom.getBoundingClientRect().bottom;
      await invoke("log_line", { text: `scenarie: audit ${padding >= 12 && gap >= 11 ? "OK" : "FAIL"} note bundmargen ${padding}/${gap}` });
      await session?.saveForHandoff();
      await invoke("log_line", { text: "scenarie: audit OK note gemt" });
    }
    if (s.close) await closeNote();
  });
}

// --- klar ----------------------------------------------------------------------------------------

const [wasRolled, wasPinned] = await invoke<[boolean, boolean]>("note_state").catch(() => [false, false] as [boolean, boolean]);
showLook();
if (wasPinned) {
  pinned = true;
  body.classList.add("pinned");
  pin.setAttribute("aria-pressed", "true");
}
if (wasRolled) {
  rolled = true;
  body.classList.add("rolled");
}
await invoke("app_ready");
// Markøren sidst i teksten, før den skjulte farvelinje.
if (!wasRolled) {
  const doc = view.state.doc.toString();
  const color = findColor(doc);
  view.dispatch({ selection: { anchor: color ? doc.slice(0, color.from).trimEnd().length : doc.length } });
  view.focus();
}
