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
$("m-op").setAttribute("aria-label", tr("Tilbage", "Back"));

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

// Systemets tilbage: fra skrivefladen eller Synkronisering til listen, ellers en mappe op.
window.addEventListener("popstate", (e: PopStateEvent) => {
  if (screens.liste.hidden) {
    void backToList();
    return;
  }
  openFolder((e.state as { mappe?: string } | null)?.mappe ?? "");
});
$("m-tilbage").addEventListener("click", () => history.back());
$("m-op").addEventListener("click", () => history.back());
$("m-synk-tilbage").addEventListener("click", () => history.back());

// --- listen ------------------------------------------------------------------------------------

let entries: IndexEntry[] = [];
/** Mappen, listen står i, relativt til biblioteket ("" er øverst). Som `IndexEntry.folder`. */
let cwd = "";

function openFolder(folder: string): void {
  cwd = folder;
  const name = folder.split("/").pop() ?? "";
  $("m-liste").querySelector(".m-title")!.textContent = name || tr("Tekster", "Texts");
  $("m-op").hidden = !folder;
  screens.liste.classList.toggle("i-mappe", !!folder);
  renderList();
  list.scrollTop = 0;
}

/** Gå ind i en mappe. Den kommer i historikken, så systemets tilbage går en mappe op. */
function enterFolder(folder: string): void {
  history.pushState({ mappe: folder }, "");
  openFolder(folder);
}

/** Tekster og mapper, der venter på papirkurven: de er væk fra listen, til fortryd-tiden er gået. */
const leaving = { texts: new Set<string>(), folders: new Set<string>() };

function visible(): IndexEntry[] {
  return entries.filter(
    (e) => !leaving.texts.has(e.path) && ![...leaving.folders].some((f) => e.folder === f || e.folder.startsWith(`${f}/`)),
  );
}

/** Mapperne lige under `cwd`: navn, fuld sti og antal tekster i alt under den. */
function subfolders(): Folder[] {
  const prefix = cwd ? `${cwd}/` : "";
  const found = new Map<string, number>();
  for (const e of visible()) {
    if (!e.folder.startsWith(prefix) || e.folder === cwd) continue;
    const name = e.folder.slice(prefix.length).split("/")[0];
    found.set(name, (found.get(name) ?? 0) + 1);
  }
  return [...found]
    .sort(([a], [b]) => a.localeCompare(b, "da"))
    .map(([name, count]) => ({ name, path: prefix + name, count }));
}

function folderItem(f: Folder): HTMLLIElement {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "m-item m-folder";
  const name = document.createElement("span");
  name.className = "m-item-name";
  name.textContent = f.name;
  const meta = document.createElement("span");
  meta.className = "m-item-meta";
  meta.textContent = f.count === 1 ? tr("1 tekst", "1 text") : tr(`${f.count} tekster`, `${f.count} texts`);
  b.append(name, meta);
  b.addEventListener("click", () => {
    if (b.dataset.trukket) return;
    enterFolder(f.path);
  });
  li.append(b);
  swipeable(li, b, tr("Flyt · Omdøb", "Move · Rename"), () => folderActions(f), () => folderTrash(f));
  return li;
}

type Folder = { name: string; path: string; count: number };

/** Mappens fulde sti. `f.path` er relativ til biblioteket, som `IndexEntry.folder`. */
async function folderPath(f: Folder): Promise<string> {
  return `${await libraryRoot()}/${f.path}`;
}

function parentOf(folder: string): string {
  return folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
}

function folderActions(f: Folder): void {
  openSheet(
    [
      {
        label: tr("Flyt til mappe", "Move to folder"),
        run: () => void folderPath(f).then((path) => moveSheet(path, parentOf(f.path), () => void loadList(), f.path)),
      },
      {
        label: tr("Omdøb", "Rename"),
        run: () => void folderPath(f).then((path) => renameSheet(path, () => void loadList(), { folder: true })),
      },
    ],
    f.name,
  );
}

function folderTrash(f: Folder): void {
  const what = f.count === 1 ? tr("1 tekst", "1 text") : tr(`${f.count} tekster`, `${f.count} texts`);
  openSheet(
    [
      {
        label: tr("Læg mappen i papirkurven", "Move the folder to trash"),
        danger: true,
        run: () => {
          leaving.folders.add(f.path);
          renderList();
          offerUndo(
            tr(`»${f.name}« er lagt i papirkurven.`, `“${f.name}” was moved to the trash.`),
            async () => {
              leaving.folders.delete(f.path);
              renderList();
            },
            async () => {
              leaving.folders.delete(f.path);
              await invoke("delete_entry", { path: await folderPath(f) });
            },
          );
        },
      },
      { label: tr("Annullér", "Cancel"), run: () => {} },
    ],
    tr(`Læg mappen »${f.name}« med ${what} i papirkurven?`, `Move the folder “${f.name}” with ${what} to the trash?`),
  );
}

function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("da-DK", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** Uden søgning: mapperne her og teksterne i mappen. Med søgning: alle tekster, uanset mappe. */
function renderList(): void {
  const q = search.value.trim().toLowerCase();
  const folders = q ? [] : subfolders();
  const all = visible();
  const shown = q
    ? all.filter((e) => e.name.toLowerCase().includes(q) || e.preview.toLowerCase().includes(q))
    : all.filter((e) => e.folder === cwd);
  if (!shown.length && !folders.length) {
    const li = document.createElement("li");
    li.className = "m-empty";
    li.textContent = q
      ? tr("Ingen tekster passer.", "No matching texts.")
      : cwd
        ? tr("Mappen er tom. Tryk på + for at skrive en tekst her.", "The folder is empty. Tap + to write a text here.")
        : tr("Ingen tekster endnu. Tryk på + for at skrive den første.", "No texts yet. Tap + to write the first.");
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...folders.map(folderItem),
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
      // Mappen står kun ved søgning. Ellers er man allerede i den.
      meta.textContent = [when(e.modifiedMs), q ? e.folder : ""].filter(Boolean).join(" · ");
      const preview = document.createElement("span");
      preview.className = "m-item-preview";
      preview.textContent = e.preview.replace(/[#*_>`[\]]/g, "").split("\n").find((l) => l.trim()) ?? "";
      b.append(name, preview, meta);
      b.addEventListener("click", () => {
        if (b.dataset.trukket) return;
        void openText(e.path);
      });
      li.append(b);
      swipeable(li, b, tr("Flyt · Del · Omdøb", "Move · Share · Rename"), () => actionSheet(e), () => trashSheet(e));
      return li;
    }),
  );
}

// --- træk i listen, som i mailappene ----------------------------------------------------------

/** Hvor langt fingeren skal trække, før handlingen sker, som andel af rækkens bredde. */
const SWIPE_AT = 0.35;

/** Mod højre: et ark med valgene (`right`, hvis navne står bagved). Mod venstre: papirkurven
 *  efter et ja. Gælder både tekster og mapper. */
function swipeable(li: HTMLLIElement, b: HTMLButtonElement, rightLabel: string, right: () => void, left: () => void): void {
  li.className = "m-swipe";
  const move = Object.assign(document.createElement("span"), { className: "m-swipe-flyt", textContent: rightLabel });
  const trash = Object.assign(document.createElement("span"), { className: "m-swipe-slet", textContent: tr("Papirkurv", "Trash") });
  move.setAttribute("aria-hidden", "true");
  trash.setAttribute("aria-hidden", "true");
  li.prepend(move, trash);
  let id = -1;
  let x0 = 0;
  let y0 = 0;
  let dx = 0;
  let mode: "?" | "x" | "y" = "?";
  b.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse") return;
    id = ev.pointerId;
    x0 = ev.clientX;
    y0 = ev.clientY;
    dx = 0;
    mode = "?";
  });
  b.addEventListener("pointermove", (ev) => {
    if (ev.pointerId !== id) return;
    const mx = ev.clientX - x0;
    const my = ev.clientY - y0;
    if (mode === "?") {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      mode = Math.abs(mx) > Math.abs(my) ? "x" : "y";
      if (mode === "x") {
        b.setPointerCapture(id);
        b.style.transition = "none";
      }
    }
    if (mode !== "x") return;
    dx = mx;
    b.style.transform = `translateX(${dx}px)`;
    li.dataset.retning = dx > 0 ? "hoejre" : "venstre";
    li.classList.toggle("m-swipe-klar", Math.abs(dx) > li.clientWidth * SWIPE_AT);
  });
  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    id = -1;
    if (mode !== "x") return;
    const done = Math.abs(dx) > li.clientWidth * SWIPE_AT;
    b.style.transition = "";
    b.style.transform = "";
    li.classList.remove("m-swipe-klar");
    // Trækket må ikke også åbne teksten eller mappen.
    b.dataset.trukket = "1";
    window.setTimeout(() => delete b.dataset.trukket, 400);
    if (!done) return;
    if (dx > 0) right();
    else left();
  };
  b.addEventListener("pointerup", end);
  b.addEventListener("pointercancel", end);
}

function plainName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? "").replace(/\.(md|markdown|txt)$/i, "");
}

async function libraryRoot(): Promise<string> {
  const libs = await invoke<Library[]>("list_libraries");
  const root = libs.find((l) => l.exists)?.path;
  if (!root) throw new Error(tr("Der er ingen mappe at gemme i.", "There is no folder to save in."));
  return root.replace(/[\\/]$/, "");
}

function actionSheet(e: IndexEntry): void {
  openSheet(
    [
      { label: tr("Flyt til mappe", "Move to folder"), run: () => moveSheet(e.path, e.folder, () => void loadList()) },
      { label: tr("Del", "Share"), run: () => void shareText(e.path) },
      { label: tr("Omdøb", "Rename"), run: () => renameSheet(e.path, () => void loadList()) },
    ],
    plainName(e.path),
  );
}

/** Androids delingsark (MainActivity.kt) med teksten, som den står på siden: uden markdown-tegn. */
async function shareText(path: string): Promise<void> {
  const bridge = (window as unknown as { GodeTeksterDeling?: { del(title: string, text: string): void } }).GodeTeksterDeling;
  try {
    if (!bridge) throw new Error(tr("Telefonen kan ikke dele herfra.", "The phone can't share from here."));
    const source = await invoke<string>("read_text", { path });
    const { markdownIt, prepare } = await import("./print/render.ts");
    const { plainText } = await import("./print/plain.ts");
    bridge.del(plainName(path), plainText(markdownIt(), prepare(source, false)).trim());
  } catch (err) {
    showBanner(errorText(err));
  }
}

/** Et nyt navn. En tekst beholder sin filtype, så et punktum i navnet ikke ændrer den. */
function renameSheet(path: string, after: (to: string) => void, opts: { open?: boolean; folder?: boolean } = {}): void {
  const ext = opts.folder ? "" : (/\.(md|markdown|txt)$/i.exec(path)?.[0] ?? ".md");
  const box = document.createElement("form");
  box.className = "m-sheet-box m-rename";
  const input = Object.assign(document.createElement("input"), { type: "text", value: plainName(path), enterKeyHint: "done" });
  input.setAttribute("aria-label", tr("Nyt navn", "New name"));
  const ok = Object.assign(document.createElement("button"), { type: "submit", textContent: tr("Omdøb", "Rename") });
  const cancel = Object.assign(document.createElement("button"), { type: "button", textContent: tr("Annullér", "Cancel") });
  cancel.addEventListener("click", closeSheet);
  box.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    closeSheet();
    if (!name || name === plainName(path)) return;
    // En åben tekst omdøbes gennem kernens dokument, så næste gem rammer den nye fil.
    const command = opts.open ? "rename_open_document" : "rename_entry";
    const before = path.split(/[\\/]/).pop() ?? "";
    void invoke<string>(command, { path, newName: name + ext })
      .then((to) => {
        after(to);
        offerUndo(tr(`Omdøbt til »${name}«.`, `Renamed to “${name}”.`), async () => {
          after(await invoke<string>(command, { path: to, newName: before }));
        });
      })
      .catch((err: unknown) => showBanner(errorText(err)));
  });
  box.append(input, ok, cancel);
  sheet.replaceChildren(box);
  sheet.hidden = false;
  input.focus();
  input.select();
}

function trashSheet(e: IndexEntry): void {
  openSheet(
    [
      {
        label: tr("Læg i papirkurven", "Move to trash"),
        danger: true,
        run: () => {
          leaving.texts.add(e.path);
          renderList();
          offerUndo(
            tr(`»${plainName(e.path)}« er lagt i papirkurven.`, `“${plainName(e.path)}” was moved to the trash.`),
            async () => {
              leaving.texts.delete(e.path);
              renderList();
            },
            async () => {
              leaving.texts.delete(e.path);
              await invoke("delete_entry", { path: e.path });
            },
          );
        },
      },
      { label: tr("Annullér", "Cancel"), run: () => {} },
    ],
    tr(`Læg »${plainName(e.path)}« i papirkurven?`, `Move “${plainName(e.path)}” to the trash?`),
  );
}

/** Alle mapper med tekster i, også dem, der kun har undermapper. */
function allFolders(): string[] {
  const found = new Set<string>();
  for (const e of visible()) {
    const parts = e.folder ? e.folder.split("/") : [];
    for (let i = 1; i <= parts.length; i++) found.add(parts.slice(0, i).join("/"));
  }
  return [...found].sort((a, b) => a.localeCompare(b, "da"));
}

/** Arket med mapperne. `after` får den nye sti. */
function moveSheet(path: string, from: string, after: (to: string) => void, self?: string): void {
  const back = path.slice(0, path.lastIndexOf("/"));
  const go = (folder: string) => async () => {
    try {
      const root = await libraryRoot();
      const to = await invoke<string>("move_entry", { path, dir: folder ? `${root}/${folder}` : root });
      after(to);
      const where = folder ? (folder.split("/").pop() ?? folder) : tr("Dokumenter", "Documents");
      offerUndo(tr(`Flyttet til »${where}«.`, `Moved to “${where}”.`), async () => {
        await invoke<string>("move_entry", { path: to, dir: back });
      });
    } catch (err) {
      showBanner(errorText(err));
    }
  };
  const items = [
    ...(from ? [{ label: tr("Øverst i Dokumenter", "Top of Documents"), run: go("") }] : []),
    ...allFolders()
      // En mappe kan ikke flyttes ind i sig selv eller sine undermapper.
      .filter((f) => f !== from && !(self && (f === self || f.startsWith(`${self}/`))))
      .map((f) => ({ label: f.split("/").join(" › "), run: go(f) })),
  ];
  openSheet(items, tr(`Flyt »${plainName(path)}« til`, `Move “${plainName(path)}” to`));
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
    const root = await libraryRoot();
    // Den nye tekst kommer i mappen, listen står i.
    const dir = cwd ? `${root}/${cwd}` : root;
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

// --- fortryd ----------------------------------------------------------------------------------

/** Så længe står Fortryd fremme. Material anbefaler 4-10 sekunder. */
const UNDO_MS = 6000;
const snack = $("m-fortryd");
let snackTimer: number | undefined;
/** Papirkurven venter, til fortryd-tiden er gået. Så kan Fortryd ikke komme for sent. */
let pending: (() => Promise<void>) | null = null;

async function runPending(): Promise<void> {
  const commit = pending;
  pending = null;
  if (!commit) return;
  try {
    await commit();
  } catch (err) {
    showBanner(errorText(err));
  }
  void loadList();
}

function hideSnack(): void {
  window.clearTimeout(snackTimer);
  snack.hidden = true;
  snack.replaceChildren();
}

/** Beskeden nederst med Fortryd. `commit` er det, der først sker, når tiden er gået. */
function offerUndo(message: string, undo: () => Promise<void>, commit?: () => Promise<void>): void {
  void runPending();
  hideSnack();
  pending = commit ?? null;
  const text = Object.assign(document.createElement("span"), { textContent: message });
  const button = Object.assign(document.createElement("button"), { type: "button", textContent: tr("Fortryd", "Undo") });
  button.addEventListener("click", () => {
    hideSnack();
    pending = null;
    void undo()
      .catch((err: unknown) => showBanner(errorText(err)))
      .finally(() => void loadList());
  });
  snack.append(text, button);
  snack.hidden = false;
  snackTimer = window.setTimeout(() => {
    hideSnack();
    void runPending();
  }, UNDO_MS);
}

// Appen kan lukkes, når den ikke ses. Det, der venter, sker før.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void runPending();
});

// --- menuen (ét ark fra bunden) ----------------------------------------------------------------

function closeSheet(): void {
  sheet.hidden = true;
  sheet.replaceChildren();
}

function openSheet(items: { label: string; run: () => void; danger?: boolean }[], heading?: string): void {
  const box = document.createElement("div");
  box.className = "m-sheet-box";
  if (heading) box.append(Object.assign(document.createElement("p"), { className: "m-sheet-heading", textContent: heading }));
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
    { label: tr("Synkronisering", "Sync"), run: openSynk },
    { label: tr("Synkronisér nu", "Sync now"), run: () => void invoke("synk_now") },
  ]),
);

$("m-skriv-mere").addEventListener("click", () =>
  openSheet([
    {
      label: tr("Del", "Share"),
      run: () => {
        const current = session;
        if (current) void current.flush().then(() => shareText(current.path));
      },
    },
    {
      label: tr("Omdøb", "Rename"),
      run: () => {
        const current = session;
        if (!current) return;
        void current.flush().then(() =>
          renameSheet(
            current.path,
            (to) => {
              current.renamed(to);
              showTitle();
            },
            { open: true },
          ),
        );
      },
    },
    {
      label: tr("Flyt til mappe", "Move to folder"),
      run: () => {
        const current = session;
        if (!current) return;
        void current.flush().then(() => {
          const from = entries.find((e) => e.path === current.path)?.folder ?? "";
          // Teksten er gemt. Efter flytningen står man i listen, som ved Tilbage.
          moveSheet(current.path, from, () => {
            session = null;
            history.back();
          });
        });
      },
    },
    {
      label: tr("Læg i papirkurven", "Move to trash"),
      danger: true,
      run: async () => {
        const current = session;
        if (!current) return;
        await current.flush().catch(() => {});
        // Som i listen: teksten er væk med det samme, men lægges først i papirkurven efter Fortryd.
        const path = current.path;
        leaving.texts.add(path);
        session = null;
        history.back();
        offerUndo(
          tr(`»${plainName(path)}« er lagt i papirkurven.`, `“${plainName(path)}” was moved to the trash.`),
          async () => {
            leaving.texts.delete(path);
            renderList();
          },
          async () => {
            leaving.texts.delete(path);
            await invoke("delete_entry", { path });
          },
        );
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
