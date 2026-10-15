// Gode Tekster på telefonen (ADR-0055). Bevidst enkel: en liste over teksterne og en skriveflade.
// Alt andet ligger i én menu. Markdown-tegnene vises aldrig: fed er fed, en overskrift er en
// overskrift. Filen er den samme markdown som på pc'en (ADR-0003), kun visningen er en anden.
//
// Ingen højre spalte, ingen faner, ingen genvejstaster, ingen AI. Systemets tilbage-bevægelse går
// fra skrivefladen til listen (historikken i WebView'en).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";

import { DocumentSession, type DocumentDto } from "./document.ts";
import { tr } from "./i18n.ts";
import { loadSettings, settings } from "./settings.ts";
import { setMarkMode } from "./editor/livePreview.ts";
import { setAuthorshipVisible } from "./editor/authorshipView.ts";
import { setStyleCheck } from "./editor/styleCheck.ts";
import { cmd } from "./editor/shortcuts.ts";
import { useTouchSurface } from "./editor/setup.ts";
import { followTheme } from "./ui/theme.ts";
import { fontStack } from "./ui/settingspanel.ts";
import { errorText, showBanner } from "./ui/banner.ts";
import { hasDefaultName, titleFromText } from "./ui/autoName.ts";
import { SynkPanel, installSynkNotices, type SynkStatus } from "./ui/synkPanel.ts";

type IndexEntry = { name: string; path: string; folder: string; modifiedMs: number; dimmed: boolean; preview: string };
type Library = { path: string; name: string; exists: boolean };

await loadSettings();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const screens = { liste: $("m-liste"), skriv: $("m-skriv"), synk: $("m-synk") };
const list = $<HTMLUListElement>("m-tekster");
const search = $<HTMLInputElement>("m-soeg");
const title = $("m-titel");
const saved = $("m-gemt");
const tools = $("m-vaerktoej");
const sheet = $("m-ark");

search.placeholder = tr("Søg i teksterne", "Search your texts");
$("m-liste").querySelector(".m-title")!.textContent = tr("Tekster", "Texts");
$("m-ny").setAttribute("aria-label", tr("Ny tekst", "New text"));

const s = settings();
followTheme(s.theme ?? (s.dark ? "moerk" : "lys"));
document.documentElement.style.setProperty("--skrift", fontStack(s.font));

useTouchSurface();
const view = new EditorView({ parent: $("editor") });
let session: DocumentSession | null = null;

/** Telefonens visning: aldrig markdown-tegn, ingen farver for forfatterskab eller stiltjek. */
function mobileLook(): void {
  setMarkMode(view, "skjul");
  setAuthorshipVisible(view, false);
  setStyleCheck(view, false);
}

// --- skærmene ----------------------------------------------------------------------------------

type Screen = keyof typeof screens;
function showScreen(name: Screen): void {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  closeSheet();
}

/** Tilbage: skrivefladen gemmes og lukkes. Kaldes af systemets tilbage og af pilen i toppen. */
async function backToList(): Promise<void> {
  if (session) {
    await session.flush().catch((e: unknown) => showBanner(errorText(e)));
    session = null;
  }
  view.contentDOM.blur();
  showScreen("liste");
  void loadList();
}

window.addEventListener("popstate", () => void backToList());
$("m-tilbage").addEventListener("click", () => history.back());
$("m-synk-tilbage").addEventListener("click", () => history.back());

// --- listen ------------------------------------------------------------------------------------

let entries: IndexEntry[] = [];

function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("da-DK", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

function renderList(): void {
  const q = search.value.trim().toLowerCase();
  const shown = entries.filter((e) => !q || e.name.toLowerCase().includes(q) || e.preview.toLowerCase().includes(q));
  if (!shown.length) {
    const li = document.createElement("li");
    li.className = "m-empty";
    li.textContent = q ? tr("Ingen tekster passer.", "No matching texts.") : tr("Ingen tekster endnu. Tryk på + for at skrive den første.", "No texts yet. Tap + to write the first.");
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...shown.slice(0, 300).map((e) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "m-item";
      const name = document.createElement("span");
      name.className = "m-item-name";
      name.textContent = e.name.replace(/\.(md|markdown|txt)$/i, "");
      const meta = document.createElement("span");
      meta.className = "m-item-meta";
      meta.textContent = [when(e.modifiedMs), e.folder].filter(Boolean).join(" · ");
      const preview = document.createElement("span");
      preview.className = "m-item-preview";
      preview.textContent = e.preview.replace(/[#*_>`[\]]/g, "").split("\n").find((l) => l.trim()) ?? "";
      b.append(name, preview, meta);
      b.addEventListener("click", () => void openText(e.path));
      li.append(b);
      return li;
    }),
  );
}

async function loadList(): Promise<void> {
  try {
    const all = await invoke<IndexEntry[]>("library_index");
    entries = all.filter((e) => !e.dimmed).sort((a, b) => b.modifiedMs - a.modifiedMs);
  } catch (e) {
    showBanner(errorText(e));
  }
  renderList();
}

search.addEventListener("input", renderList);

// --- skrivefladen ------------------------------------------------------------------------------

let nameTimer: number | undefined;
let naming = false;
let savedTimer: number | undefined;

function showTitle(): void {
  if (!session) return;
  const file = session.path.split(/[\\/]/).pop() ?? "";
  title.textContent = file.replace(/\.(md|markdown|txt)$/i, "") || tr("Uden titel", "Untitled");
}

/** En ny tekst får navn efter første linje, som på pc'en (autoName.ts). */
async function autoName(): Promise<void> {
  const current = session;
  if (!current || naming || !hasDefaultName(current.path)) return;
  const t = titleFromText(view.state.doc.toString());
  if (!t) return;
  naming = true;
  try {
    await current.flush();
    for (let i = 1; i <= 9; i++) {
      try {
        const to = await invoke<string>("rename_open_document", { path: current.path, newName: i === 1 ? t : `${t} ${i}` });
        current.renamed(to);
        showTitle();
        return;
      } catch (e) {
        if (!/findes allerede|already exists/i.test(errorText(e))) return;
      }
    }
  } finally {
    naming = false;
  }
}

function changed(): void {
  session?.changed();
  saved.textContent = "";
  window.clearTimeout(savedTimer);
  // Autosave gemmer efter 1,5 s (document.ts). Lidt efter står der, at teksten er gemt.
  savedTimer = window.setTimeout(() => (saved.textContent = tr("Gemt", "Saved")), 2200);
  if (session && hasDefaultName(session.path)) {
    window.clearTimeout(nameTimer);
    nameTimer = window.setTimeout(() => void autoName(), 1200);
  }
}

async function openText(path: string, focus = false): Promise<void> {
  try {
    const dto = await invoke<DocumentDto>("open_document", { path });
    session = DocumentSession.load(view, dto, changed);
    mobileLook();
    saved.textContent = "";
    showTitle();
    history.pushState({ skriv: true }, "");
    showScreen("skriv");
    if (focus) view.focus();
  } catch (e) {
    showBanner(errorText(e));
  }
}

$("m-ny").addEventListener("click", async () => {
  try {
    const libs = await invoke<Library[]>("list_libraries");
    const dir = libs.find((l) => l.exists)?.path;
    if (!dir) throw new Error(tr("Der er ingen mappe at gemme i.", "There is no folder to save in."));
    const path = await invoke<string>("create_file", { dir });
    await openText(path, true);
  } catch (e) {
    showBanner(errorText(e));
  }
});

// Telefonen kan lukke appen, så snart den ikke ses. Gem, før det sker.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void session?.flush();
});

// --- værktøjslinjen over tastaturet ------------------------------------------------------------

/** Aa: tekstens slags for linjen, som i Apple Notes. Overskrift 0 er brødtekst. */
function styleSheet(): void {
  const heading = (level: number) => () => {
    cmd.heading(level)(view);
    view.focus();
  };
  openSheet([
    { label: tr("Brødtekst", "Body text"), run: heading(0) },
    { label: tr("Overskrift", "Heading"), run: heading(1) },
    { label: tr("Underoverskrift", "Subheading"), run: heading(2) },
    {
      label: tr("Citat", "Quote"),
      run: () => {
        cmd.quote(view);
        view.focus();
      },
    },
  ]);
}

type Tool = { label: string; text: string; run: () => void; cls?: string; keepKeyboard?: boolean };
const toolList: Tool[] = [
  { label: tr("Tekstens slags", "Text style"), text: "Aa", run: styleSheet, keepKeyboard: false },
  { label: tr("Fed", "Bold"), text: "F", run: () => cmd.bold(view), cls: "m-bold" },
  { label: tr("Kursiv", "Italic"), text: "K", run: () => cmd.italic(view), cls: "m-italic" },
  { label: tr("Punktliste", "Bullet list"), text: "•", run: () => cmd.bullets(view) },
  { label: tr("Fortryd", "Undo"), text: "↶", run: () => undo(view) },
  { label: tr("Gentag", "Redo"), text: "↷", run: () => redo(view) },
  { label: tr("Luk tastaturet", "Hide keyboard"), text: "⌄", run: () => view.contentDOM.blur(), keepKeyboard: false },
];
for (const t of toolList) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = t.text;
  b.className = t.cls ?? "";
  b.setAttribute("aria-label", t.label);
  // Markeringen og tastaturet bliver, når knappen trykkes.
  b.addEventListener("pointerdown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    t.run();
    if (t.keepKeyboard !== false) view.focus();
  });
  tools.append(b);
}
view.contentDOM.addEventListener("focus", () => (tools.hidden = false));
view.contentDOM.addEventListener("blur", () => (tools.hidden = true));

// --- menuen (ét ark fra bunden) ----------------------------------------------------------------

function closeSheet(): void {
  sheet.hidden = true;
  sheet.replaceChildren();
}

function openSheet(items: { label: string; run: () => void; danger?: boolean }[]): void {
  const box = document.createElement("div");
  box.className = "m-sheet-box";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = it.label;
    if (it.danger) b.className = "m-danger";
    b.addEventListener("click", () => {
      closeSheet();
      it.run();
    });
    box.append(b);
  }
  sheet.replaceChildren(box);
  sheet.hidden = false;
}
sheet.addEventListener("click", (e) => {
  if (e.target === sheet) closeSheet();
});

const synkPanel = new SynkPanel();
function openSynk(): void {
  $("m-synk-indhold").replaceChildren(synkPanel.el);
  void synkPanel.refresh();
  history.pushState({ synk: true }, "");
  showScreen("synk");
}

$("m-liste-mere").addEventListener("click", () =>
  openSheet([
    { label: tr("Synk", "Sync"), run: openSynk },
    { label: tr("Synk nu", "Sync now"), run: () => void invoke("synk_now") },
  ]),
);

$("m-skriv-mere").addEventListener("click", () =>
  openSheet([
    {
      label: tr("Læg i papirkurven", "Move to trash"),
      danger: true,
      run: async () => {
        const current = session;
        if (!current) return;
        await current.flush().catch(() => {});
        try {
          await invoke("delete_entry", { path: current.path });
          session = null;
          history.back();
        } catch (e) {
          showBanner(errorText(e));
        }
      },
    },
  ]),
);

// Teksten blev hentet fra en anden enhed: listen viser den nye udgave.
void listen<SynkStatus>("synk-status", (e) => {
  if (!e.payload.running && screens.liste.hidden === false) void loadList();
});
installSynkNotices();

await loadList();
await invoke("app_ready").catch(() => {});
