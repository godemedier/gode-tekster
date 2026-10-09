// Opstart: hent filen (fra »Åbn med« eller sidst åbne), tegn editoren, giv den fokus, og bed
// først derefter Rust om at vise vinduet (ADR-0014). Binder editor, paneler og bibliotek sammen.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { EditorView } from "@codemirror/view";

import { DocumentSession, type DocumentDto } from "./document.ts";
import { openLibrarySearch, openReplace, toggleFind } from "./editor/find.ts";
import { ICON, iconButton } from "./ui/icons.ts";
import { LibraryPanel } from "./ui/library.ts";
import { Panel } from "./ui/panels.ts";
import { openQuick } from "./ui/quickopen.ts";
import { clearTextBanners, errorText, hideBanner, notify, showBanner } from "./ui/banner.ts";
import { RightPanel } from "./ui/rightpanel.ts";
import { onSelectionChange } from "./editor/setup.ts";
import { Versions } from "./ui/versions.ts";
import { setAuthorshipVisible } from "./editor/authorshipView.ts";
import { loadSettings, onSettings, reloadSettings, settings, updateSettings, type Settings, bulletChar } from "./settings.ts";
import { setParagraphs } from "./editor/paragraphs.ts";
import { setBullet, setMarkMode } from "./editor/livePreview.ts";
import { FeedbackDialog } from "./ui/feedbackDialog.ts";
import { LanguagePanel } from "./ui/languagePanel.ts";
import { SettingsPanel, fontStack } from "./ui/settingspanel.ts";
import { setLineLength } from "./ui/lineWidth.ts";
import { followTheme } from "./ui/theme.ts";
import { installContextMenu } from "./ui/contextMenu.ts";
import { statusChange } from "./editor/textStatus.ts";
import { CountCorner } from "./ui/countcorner.ts";
import { setModes, setQuoteStyle } from "./editor/modes.ts";
import { setTransformQuotes } from "./commands/blocks.ts";
import { setWordClasses, setHiddenWordClasses } from "./editor/wordclasses.ts";
import { PrintPreview } from "./print/preview.ts";
import { ClaudePanel } from "./ui/claudepanel.ts";
import { resolveAll } from "./editor/revisionsView.ts";
import { toggleShortcuts } from "./ui/shortcutsHelp.ts";
import { setFocusFallback } from "./ui/focus.ts";
import { installScrollbars } from "./ui/scrollbars.ts";
import { OutlinePanel } from "./ui/outlinePanel.ts";
import { setCommaStyle, setStyleCheck } from "./editor/styleCheck.ts";
import { currentLang, isEnglish, tr } from "./i18n.ts";
import { hasDefaultName, titleFromText } from "./ui/autoName.ts";
import { setCommandHooks } from "./editor/setup.ts";
import { loadCommands } from "./commands/store.ts";
import { openCommandMenu } from "./commands/slashMenu.ts";
import type { CommandHooks } from "./commands/types.ts";
import { CommandsPanel } from "./ui/commandsPanel.ts";
import { showCommandResult } from "./ui/commandResults.ts";
import { renderPapers, type RecentDoc } from "./ui/recentPapers.ts";

// index.html er skrevet på dansk. Sproget og de faste tekster sættes her, før vinduet vises.
document.documentElement.lang = currentLang();
(document.getElementById("open-file") as HTMLElement).textContent = tr("Åbn en tekst", "Open a text");
document.getElementById("left")?.setAttribute("aria-label", tr("Bibliotek", "Library"));
document.getElementById("right")?.setAttribute("aria-label", tr("Fraklip og fodnoter", "Clippings and footnotes"));

const view = new EditorView({ parent: document.getElementById("editor") as HTMLElement });
// Højreklik: stilfund, tabel og »Tilføj« i WebView2's egen menu (contextmenu.rs, 9/10).
installContextMenu(view);
setFocusFallback(() => view.focus());
installScrollbars();
const empty = document.getElementById("empty") as HTMLElement;
let session: DocumentSession | null = null;

await loadSettings();

// --- kommandoer med »/« (commands/, 5/10) --------------------------------------------------------
// Sættes før første tekst, så menuen er med i editorens tilstand fra start.
const commandHooks: CommandHooks = {
  fileContext: () => {
    const path = session?.path ?? "";
    const file = path.slice(path.lastIndexOf("\\") + 1).replace(/\.(md|markdown|txt)$/i, "");
    const heading = /^#{1,6}\s+(.+)$/m.exec(view.state.doc.toString())?.[1]?.trim();
    return { name: settings().authorName ?? "", filename: file, title: heading || file };
  },
  showResult: (result) => showCommandResult(view, result),
  runAi: (command, text, offset) => void claude.runCommandAi(command, text, offset),
  newFile: async (text) => {
    // Ny tekst ved siden af den åbne (eller i første bibliotek), med skabelonen som indhold.
    const open = session?.path;
    const dir = open ? open.slice(0, open.lastIndexOf("\\")) : settings().libraries[0];
    if (!dir) return notify(tr("Der er ingen mappe at lægge den nye tekst i.", "There is no folder to put the new text in."));
    try {
      const path = await invoke<string>("create_file", { dir });
      await library.refresh();
      await openPath(path);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.command" });
      view.focus();
    } catch (e) {
      showBanner(errorText(e));
    }
  },
  notify,
};
setCommandHooks(commandHooks);
// En fejl i mappen med egne kommandoer må ikke stoppe programmet: de indbyggede virker stadig.
const reloadCommands = () => loadCommands().catch((e) => showBanner(errorText(e)));
await reloadCommands();

// --- paneler og bibliotek ---------------------------------------------------------------------

const leftEl = document.getElementById("left") as HTMLElement;
const rightEl = document.getElementById("right") as HTMLElement;
const left = new Panel("left", leftEl, document.getElementById("zone-left") as HTMLElement);
const right = new Panel("right", rightEl, document.getElementById("zone-right") as HTMLElement);

const leftFoot = document.createElement("div");
leftFoot.className = "panel-foot";
const leftPin = iconButton(ICON.pin, tr("Fastgør (Ctrl+W)", "Pin (Ctrl+W)"), () => left.togglePin());
const gear = iconButton(ICON.gear, tr("Indstillinger", "Settings"), () => settingsPanel.toggle());
const spacer = document.createElement("span");
spacer.style.flexGrow = "1";
// Diskret feedback (3/10): en lille formular, der sendes til Gode Medier (feedbackDialog.ts).
const feedbackDialog = new FeedbackDialog();
const feedback = iconButton(ICON.feedback, tr("Skriv til Gode Medier om fejl og ønsker", "Write to Gode Medier about bugs and wishes"), () => feedbackDialog.open());
leftFoot.append(gear, feedback, spacer, leftPin);

// »Bygget af Gode Medier« nederst i venstre spalte, som i Prismet (3/10). Kun tekst, uden husets
// orange mærke (7/10). Klik åbner godemedier.dk.
const credit = document.createElement("button");
credit.type = "button";
credit.className = "gm-credit";
credit.title = "godemedier.dk";
credit.textContent = tr("Bygget af Gode Medier", "Built by Gode Medier");
credit.addEventListener("click", () => void invoke("open_url", { url: "https://godemedier.dk" }));
left.registerPin(leftPin);

// Venstre spalte: Bibliotek, Disposition og Versioner (2/10, Versioner herover 6/10: »det giver
// bedre mening«, Kommandoer flyttede til højre). Valget huskes pr. maskine.
type LeftTab = "bibliotek" | "disposition" | "versioner";
const versions = new Versions({
  view,
  path: () => session?.path ?? null,
  pause: async (on) => {
    await session?.pause(on);
  },
});

const leftTabs = document.createElement("div");
leftTabs.className = "rp-tabs";
leftTabs.setAttribute("role", "tablist");
const libraryBox = document.createElement("div");
libraryBox.className = "left-view";
const library = new LibraryPanel(libraryBox, {
  open: (path) => void openPath(path),
  openNew: (path) => void invoke("new_window", { path }),
  activePath: () => session?.path ?? null,
  moved: (from, to) => void fileMoved(from, to),
  // Statussen på den åbne tekst skiftes i editoren og gemmes med det samme (ADR-0038).
  setActiveStatus: (id) => {
    view.dispatch({ changes: statusChange(view.state.doc.toString(), id), userEvent: "input.status" });
    window.dispatchEvent(new Event("gt-save-now"));
  },
});
await library.init();
// Indekset over alle biblioteker bygges i baggrunden, når vinduet har fået ro (ADR-0038).
window.setTimeout(() => library.warm(), 20_000);
const outline = new OutlinePanel(view, {
  visible: () => left.visible && leftTab === "disposition",
  done: () => {
    view.focus();
    if (!left.docked) left.close();
  },
});
// Ny version klar (updater.rs): én linje under krediteringen. Klik genstarter med den nye version.
const updateLine = document.createElement("button");
updateLine.type = "button";
updateLine.className = "gt-update";
updateLine.hidden = true;
updateLine.addEventListener("click", () => void invoke("install_update_now"));
const showUpdate = (version: string | null) => {
  if (!version) return;
  updateLine.textContent = tr(`Version ${version} er klar. Genstart nu`, `Version ${version} is ready. Restart now`);
  updateLine.title = tr(
    "Teksten gemmes, og Gode Tekster starter igen med den nye version. Ellers sker det, næste gang du afslutter.",
    "Your text is saved, and Gode Tekster restarts with the new version. Otherwise it happens the next time you quit.",
  );
  updateLine.hidden = false;
};
void invoke<string | null>("update_ready").then(showUpdate);
void listen<string>("update-ready", (e) => showUpdate(e.payload));
const commandsPanel = new CommandsPanel(view, commandHooks);
const versionsBox = document.createElement("div");
versionsBox.className = "left-view lv-versions";
leftEl.append(leftTabs, libraryBox, outline.el, versionsBox, credit, updateLine, leftFoot);
/** Versionerne tegnes, når fanen ses: ved skift, når spalten glider frem, ved gem og ny tekst. */
const showVersions = () => {
  if (leftTab === "versioner" && left.visible) void versions.render(versionsBox);
};
let leftTab: LeftTab = "bibliotek";
try {
  const saved = localStorage.getItem("gt-left-tab");
  if (saved === "disposition" || saved === "versioner") leftTab = saved;
} catch {
  // Lagringen kan være spærret. Så starter spalten på Bibliotek.
}
function showLeftTab(tab: LeftTab): void {
  leftTab = tab;
  try {
    localStorage.setItem("gt-left-tab", tab);
  } catch {
    // Valget gælder så kun denne kørsel.
  }
  libraryBox.hidden = tab !== "bibliotek";
  outline.el.hidden = tab !== "disposition";
  versionsBox.hidden = tab !== "versioner";
  leftTabs.replaceChildren(
    ...(["bibliotek", "disposition", "versioner"] as const).map((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rp-tab";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(t === tab));
      b.textContent = t === "bibliotek" ? tr("Bibliotek", "Library") : t === "disposition" ? tr("Disposition", "Outline") : tr("Versioner", "Versions");
      b.title =
        t === "disposition"
          ? tr("Overskrifterne i teksten (Ctrl+J)", "The headings in your text (Ctrl+J)")
          : t === "versioner"
            ? tr("Tidligere udgaver af teksten", "Earlier versions of the text")
            : tr("Mapper og filer", "Folders and files");
      b.addEventListener("click", () => showLeftTab(t));
      return b;
    }),
  );
  if (tab === "disposition") outline.show();
  showVersions();
}
showLeftTab(leftTab);
left.onShow(() => {
  if (leftTab === "disposition") outline.show();
  showVersions();
});

const settingsPanel = new SettingsPanel();
// Kommandoer er en fane i Indstillinger (7/10, før i højre spalte). Fanen har sin egen tilstand
// (en halvskrevet beskrivelse, en åben formular), så den samme flade flyttes ind, når vinduet tegnes.
settingsPanel.addTab({
  id: "kommandoer",
  label: tr("Kommandoer", "Commands"),
  mount: (host) => {
    host.replaceChildren(commandsPanel.el);
    commandsPanel.refresh();
  },
});
// Højreklik på en markering › »Gem som skabelon …«: fanen Kommandoer med forslaget klar (9/10).
window.addEventListener("gt-template-from-selection", () => {
  if (!settingsPanel.isOpen) settingsPanel.open("kommandoer");
  commandsPanel.selectionAsTemplate();
});
// Fanen Input og beskeder om AI-hjælpen kan åbne indstillingerne, eventuelt på en bestemt fane.
window.addEventListener("gt-open-settings", (e) => {
  if (!settingsPanel.isOpen) settingsPanel.open((e as CustomEvent<string | undefined>).detail ?? "generelt");
});

const rightFoot = document.createElement("div");
rightFoot.className = "panel-foot";
const rightSpacer = document.createElement("span");
rightSpacer.style.flexGrow = "1";
const rightPin = iconButton(ICON.pin, tr("Fastgør (Ctrl+E)", "Pin (Ctrl+E)"), () => right.togglePin());
rightFoot.append(rightSpacer, rightPin);
right.registerPin(rightPin);
const rightPanel = new RightPanel(rightEl, view, rightFoot, () => session?.path ?? null);

// Tekst trukket mod højre kant: spalten glider frem, så teksten kan slippes i Fraklip, uanset
// hvilken fane der vises (2/10). Musens hover-signal kommer ikke under et træk, så kantzonen
// lytter efter dragenter. Slippes teksten et andet sted, glider spalten væk igen.
const draggingText = (e: DragEvent) =>
  !!e.dataTransfer?.types.includes("text/plain") && !e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes("application/x-gt-fil");
document.getElementById("zone-right")?.addEventListener("dragenter", (e) => {
  if (draggingText(e)) right.open();
});
document.addEventListener("dragend", () => {
  if (!right.docked) right.scheduleClose();
});
// Et træk fra en anden app giver ingen dragend her: luk, når trækket forlader spalten igen.
rightEl.addEventListener("dragleave", (e) => {
  const to = e.relatedTarget as Node | null;
  if (!right.docked && !rightEl.contains(to) && to !== document.getElementById("zone-right")) right.scheduleClose();
});

const claude = new ClaudePanel(view, () => session?.path ?? null, () => {
  rightPanel.show("claude");
  right.open();
});
// Sprog (4/10): ordklasser, stiltjek og hvem skrev hvad slås til her, med forklaring og overblik.
const language = new LanguagePanel(view);
rightPanel.addTab({ id: "sprog", label: tr("Sprog", "Language"), secondary: true, render: (b) => language.render(b) });
window.addEventListener("gt-style", () => language.refresh());
// Testkørsler (measure.ts): vis en bestemt fane i højre spalte.
window.addEventListener("gt-test-tab", (e) => {
  rightPanel.show((e as CustomEvent<string>).detail);
  right.open();
});
// Testkørsler: begge spalter frem eller væk på én gang, uden at fastgøre dem (fastgørelsen huskes).
window.addEventListener("gt-test-panels", (e) => {
  const d = (e as CustomEvent<{ left?: "bibliotek" | "disposition"; right?: string }>).detail;
  if (d.left) {
    showLeftTab(d.left);
    left.open();
  } else left.close();
  if (d.right) {
    rightPanel.show(d.right);
    right.open();
  } else right.close();
});
onSettings(() => language.refresh());
rightPanel.addTab({ id: "claude", label: "Input", secondary: true, render: (b) => claude.render(b) });
window.addEventListener("gt-claude", (e) => {
  const what = (e as CustomEvent<string>).detail;
  if (what === "cut") void claude.cut(false);
  else if (what === "clean") void claude.clean();
  else if (what === "factcheck") void claude.factcheck();
  else {
    rightPanel.show("claude");
    right.open();
  }
});
window.addEventListener("gt-versions", showVersions);
// Efter et nedbrud spørger hovedvinduet én gang, om fejlloggen må sendes til Gode Medier (feedback.rs).
if (getCurrentWindow().label === "main") {
  void invoke<boolean>("crash_pending").then((pending) => {
    if (!pending) return;
    const answer = (send: boolean) =>
      invoke("answer_crash", { send })
        .then(() => send && notify(tr("Tak. Fejlloggen er sendt.", "Thanks. The error log has been sent.")))
        .catch((e) => showBanner(errorText(e)));
    showBanner(
      tr(
        "Gode Tekster gik ned sidste gang. Må fejlloggen sendes til Gode Medier? Den indeholder ingen tekst fra dine dokumenter.",
        "Gode Tekster crashed last time. May the error log be sent to Gode Medier? It contains no text from your documents.",
      ),
      [
        { label: "Send", run: () => void answer(true) },
        { label: tr("Nej tak", "No thanks"), run: () => void answer(false) },
      ],
    );
  });
}

// AI-hjælpen: udbyderne tjekkes først, når den bruges (Claudes login-tjek er et program på 250 MB
// i 5 s, for dyrt ved hver start), og igen, når valget skifter i indstillingerne.
window.addEventListener("gt-ai-changed", () => void claude.refreshAi(true));

// --- indstillingerne slår igennem med det samme -----------------------------------------------

const printing = new PrintPreview(view, () => session?.path ?? null);

const counter = new CountCorner(document.getElementById("count") as HTMLElement, view);
onSelectionChange(() => {
  counter.schedule();
  outline.selectionChanged();
});
window.addEventListener("gt-style", () => counter.schedule());

function applySettings(s: Settings): void {
  const root = document.documentElement.style;
  root.setProperty("--skrift", fontStack(s.font));
  void setLineLength(s.lineLength, fontStack(s.font));
  // Udseendet og titellinjen i samme farve som skrivefladen (ui/theme.ts, ADR-0037).
  followTheme(s.theme ?? (s.dark ? "moerk" : "lys"));
  // »Hvem skrev hvad« vises ikke, til funktionen er gentænkt (4/10). Data bevares i filen.
  setAuthorshipVisible(view, false);
  setModes(view, { focus: s.focusMode, typewriter: s.typewriter });
  setQuoteStyle(s.quotes);
  setTransformQuotes(s.quotes);
  counter.setAlways(s.alwaysShowCount);
  // Ordklasser og stiltjek bygger på danske ordlister: på engelsk er de slået fra, også selv om
  // indstillingerne (fra en dansk kørsel) siger til.
  void setWordClasses(view, s.wordClasses && !isEnglish());
  setCommaStyle(view, s.commaStyle ?? "start");
  setStyleCheck(view, s.styleCheck && !isEnglish());
  setParagraphs(view, s.paragraphs === "indryk");
  setBullet(view, bulletChar(s));
  setMarkMode(view, s.markMode ?? (s.hideMarks ? "skjul" : "markoer"));
  setHiddenWordClasses(view, s.hiddenWordClasses ?? []);
}
applySettings(settings());
onSettings(applySettings);

/** Vis højre spalte et øjeblik, når noget er lagt i den, med mindre den er fastgjort. */
function peekRight(tab: string): void {
  rightPanel.show(tab);
  right.open();
  right.scheduleClose();
}

window.addEventListener("gt-parked", () => peekRight("fraklip"));
window.addEventListener("gt-note", (e) => {
  rightPanel.openNote((e as CustomEvent<string>).detail);
  right.open();
});



// --- dokumentet -------------------------------------------------------------------------------

function show(dto: DocumentDto | null): void {
  if (!dto) {
    session = null;
    empty.hidden = false;
    view.dom.hidden = true;
    void library.reveal(null);
    void showPapers();
    return;
  }
  empty.hidden = true;
  view.dom.hidden = false;
  let current: DocumentSession | null = null;
  current = DocumentSession.load(view, dto, () => {
    current?.changed();
    scheduleAutoName();
    rightPanel.docChanged();
    outline.docChanged();
    counter.schedule();
  });
  session = current;
  // setState nulstiller tilstandene, så de sættes igen for den nye tekst.
  applySettings(settings());
  clearTextBanners();
  claude.docOpened(dto.path);
  outline.docChanged();
  rightPanel.render();
  showVersions();
  counter.update();
  void library.reveal(dto.path);
  view.focus();
}

/**
 * En Word-fil kan ikke redigeres her. Tilbyd en markdown-kopi ved siden af (del G). Har filen
 * redaktørens sporede ændringer eller kommentarer, kommer de med som rettelser og noter, der
 * godtages eller afvises ét ad gangen (import/tracked.ts).
 */
async function offerImport(path: string): Promise<void> {
  const name = path.slice(path.lastIndexOf("\\") + 1);
  let bytes: ArrayBuffer;
  let changes = 0;
  let comments = 0;
  try {
    bytes = await invoke<ArrayBuffer>("read_docx", { path });
    const { inspect } = await import("./import/tracked.ts");
    const t = await inspect(bytes);
    changes = t.changes;
    comments = t.comments.size;
  } catch (e) {
    showBanner(tr(`Word-filen kunne ikke læses. ${errorText(e)}`, `The Word file could not be read. ${errorText(e)}`));
    return;
  }
  const tracked = changes + comments > 0;
  const parts = [
    changes ? tr(`${changes} rettelser`, changes === 1 ? "1 tracked change" : `${changes} tracked changes`) : "",
    comments ? tr(`${comments} kommentarer`, comments === 1 ? "1 comment" : `${comments} comments`) : "",
  ]
    .filter(Boolean)
    .join(tr(" og ", " and "));
  const message = tracked
    ? tr(
        `${name} har ${parts}. Du kan få en markdown-kopi, hvor de står som forslag, du godtager eller afviser.`,
        `${name} has ${parts}. You can get a markdown copy where they appear as suggestions you accept or reject.`,
      )
    : tr(
        `${name} er en Word-fil. Den kan ikke redigeres her, men du kan få en markdown-kopi ved siden af.`,
        `${name} is a Word file. It can't be edited here, but you can get a markdown copy next to it.`,
      );
  const id = showBanner(message, [
    {
      label: tracked ? tr("Hent ind med rettelser", "Import with tracked changes") : tr("Lav en markdown-kopi", "Make a markdown copy"),
      run: () => {
        hideBanner(id);
        void importDocx(path, bytes, tracked);
      },
    },
    { label: tr("Nej tak", "No thanks"), run: () => hideBanner(id) },
  ]);
}

async function importDocx(path: string, bytes: ArrayBuffer, tracked: boolean): Promise<void> {
  try {
    const { docxToMarkdown } = await import("./import/docx.ts");
    let markdown: string;
    let warnings: string[];
    if (tracked) {
      const { inspect, versions, placeComments } = await import("./import/tracked.ts");
      const { withRevisions } = await import("./editor/critic.ts");
      const { comments } = await inspect(bytes);
      const v = await versions(bytes);
      const before = await docxToMarkdown(v.rejected);
      const after = await docxToMarkdown(v.accepted);
      const edits = await invoke<{ from: number; to: number; insert: string }[]>("word_diff", { old: before.markdown, new: after.markdown });
      markdown = placeComments(withRevisions(before.markdown, edits), comments);
      warnings = before.warnings;
    } else {
      ({ markdown, warnings } = await docxToMarkdown(bytes));
    }
    const created = await invoke<string>("create_import", { source: path, text: markdown });
    await library.refresh();
    await openPath(created);
    if (tracked) {
      const id = showBanner(tr("Redaktørens rettelser er markeret i teksten. Klik i en for at godtage eller afvise den.", "The editor's changes are marked in the text. Click one to accept or reject it."), [
        { label: tr("Godtag alle", "Accept all"), run: () => (resolveAll(view, true), hideBanner(id)) },
        { label: tr("Afvis alle", "Reject all"), run: () => (resolveAll(view, false), hideBanner(id)) },
        { label: tr("Ét ad gangen", "One at a time"), run: () => hideBanner(id) },
      ], { perText: true });
    } else if (warnings.length) {
      notify(
        tr(
          `Kopien er lavet. ${warnings.length} ting fra Word-filen kunne ikke komme med, for eksempel særlige typografier.`,
          `The copy is ready. ${warnings.length === 1 ? "1 thing" : `${warnings.length} things`} from the Word file could not be included, such as special styles.`,
        ),
      );
    }
  } catch (e) {
    showBanner(tr(`Word-filen kunne ikke hentes ind. ${errorText(e)}`, `The Word file could not be imported. ${errorText(e)}`));
  }
}

/**
 * Skift tekst. Al åbning går herigennem: en gammel version og Claudes resultater hører til den
 * forrige tekst, og den forrige gemmes (eller lægges i backup), før den nye vises.
 */
async function switchTo(load: () => Promise<DocumentDto | null>): Promise<void> {
  // Trykprøven 3/10: et tastetryk, mens den nye tekst blev indlæst, endte i den gamle tekst, efter
  // at den var gemt, og forsvandt. Nu læses den nye tekst først (der skrives videre i den gamle, som
  // så gemmes med), og skrivefladen tager ikke imod tastetryk i de millisekunder, selve skiftet tager.
  const block = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const kinds = ["keydown", "beforeinput", "paste", "drop"];
  try {
    await versions.back();
    const dto = await load();
    if (!dto) return;
    kinds.forEach((k) => view.dom.addEventListener(k, block, true));
    claude.reset();
    await session?.close();
    show(dto);
  } catch (e) {
    showBanner(errorText(e));
  } finally {
    kinds.forEach((k) => view.dom.removeEventListener(k, block, true));
  }
}

async function openPath(path: string): Promise<void> {
  if (/\.docx$/i.test(path)) return void offerImport(path);
  if (session && session.path.toLowerCase() === path.toLowerCase()) return;
  // Ét vindue pr. tekst: er den åben i et andet vindue, hentes det frem i stedet.
  if (await invoke<boolean>("focus_if_open", { path })) return;
  await switchTo(() => invoke<DocumentDto>("open_document", { path }));
}

/** Åbn en tekst og spring til en position (søgning i hele biblioteket). */
// Et fund i »søg i alle tekster« (libraryResults.ts).
// Den åbne fil er omdøbt udefra og fulgt (document.ts): biblioteket viser det nye navn.
window.addEventListener("gt-moved", () => void library.refresh());

// Ctrl+klik på et link (links.ts): webadresser i browseren, andre tekster ved siden af den åbne.
window.addEventListener("gt-open-link", (e) => {
  const target = (e as CustomEvent<string>).detail;
  if (/^https?:\/\//i.test(target)) return void invoke("open_url", { url: target });
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return;
  let rel = target;
  try {
    rel = decodeURIComponent(target);
  } catch {
    // Et procenttegn uden kode: brug linket, som det står.
  }
  const here = session?.path;
  const abs = /^[a-z]:[\\/]/i.test(rel) || !here ? rel : `${here.replace(/[\\/][^\\/]*$/, "")}\\${rel.replace(/\//g, "\\")}`;
  void openPath(abs).catch((err) => showBanner(errorText(err)));
});

window.addEventListener("gt-open-at", (e) => {
  const { path, pos } = (e as CustomEvent<{ path: string; pos: number }>).detail;
  void openAt(path, pos);
});

async function openAt(path: string, pos: number): Promise<void> {
  await openPath(path);
  if (session?.path.toLowerCase() !== path.toLowerCase()) return;
  view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) }, scrollIntoView: true });
  view.focus();
}

async function pick(): Promise<void> {
  await switchTo(() => invoke<DocumentDto | null>("pick_document"));
}

/** En åben fil er omdøbt eller flyttet i biblioteket, eller lagt i papirkurven. */
// --- nye tekster får navn efter første linje (ui/autoName.ts, 5/10) -----------------------------

let nameTimer = 0;
let naming = false;

function scheduleAutoName(): void {
  if (!session || !hasDefaultName(session.path)) return;
  window.clearTimeout(nameTimer);
  nameTimer = window.setTimeout(() => void autoName(), 1200);
}

async function autoName(): Promise<void> {
  const s = session;
  if (!s || naming || !hasDefaultName(s.path)) return;
  const title = titleFromText(view.state.doc.toString());
  if (!title) return;
  naming = true;
  try {
    await s.flush();
    // Findes navnet allerede i mappen, prøves »navn 2«, »navn 3« …
    for (let i = 1; i <= 9; i++) {
      const from = s.path;
      try {
        const to = await invoke<string>("rename_open_document", { path: from, newName: i === 1 ? title : `${title} ${i}` });
        s.renamed(to);
        window.dispatchEvent(new CustomEvent("gt-moved", { detail: { from, to } }));
        return;
      } catch (e) {
        if (!/findes allerede|already exists/i.test(errorText(e))) return;
      }
    }
  } finally {
    naming = false;
  }
}

async function fileMoved(from: string, to: string | null): Promise<void> {
  if (!session || session.path.toLowerCase() !== from.toLowerCase()) return;
  if (to) return switchTo(() => invoke<DocumentDto>("open_document", { path: to }));
  await session.close();
  session = null;
  show(null);
}

document.getElementById("open-file")?.addEventListener("click", () => openQuick((p) => void openPath(p)));

/** De seneste tekster som papirark på den tomme flade (ADR-0030). */
async function showPapers(): Promise<void> {
  const docs = await invoke<RecentDoc[]>("recent_documents").catch(() => []);
  // Er en tekst nået at blive åbnet imens, skal arkene ikke tegnes oven på den.
  if (session) return;
  renderPapers(document.getElementById("papers") as HTMLElement, docs, (p) => void openPath(p));
}

// --- tastatur ---------------------------------------------------------------------------------

/** Tekststørrelsen (Ctrl+plus/minus), 70-200 %. Et valg pr. maskine som knappenålene, ikke data. */
let zoom = 1;
function setZoom(z: number): void {
  zoom = Math.round(Math.min(2, Math.max(0.7, z)) * 10) / 10;
  document.documentElement.style.setProperty("--zoom", String(zoom));
  try {
    localStorage.setItem("gt-zoom", String(zoom));
  } catch {
    // Lagringen kan være spærret; størrelsen gælder så kun denne kørsel.
  }
  view.requestMeasure();
}
try {
  setZoom(Number(localStorage.getItem("gt-zoom")) || 1);
} catch {
  setZoom(1);
}

// Fanges før editoren (capture): Ctrl+F og Ctrl+H skal også virke, når fokus står i søgefeltet,
// og Ctrl+W/Ctrl+E fastgør panelerne (ADR-0015). Andet tryk på Ctrl+F lukker søgelinjen.
window.addEventListener(
  "keydown",
  (e) => {
    if (!e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (key === "f" && !e.shiftKey) {
      stop();
      toggleFind(view);
    } else if (key === "h" && !e.shiftKey) {
      stop();
      openReplace(view);
    } else if (key === "w" && !e.shiftKey) {
      // Ctrl+W venstre spalte, Ctrl+E højre: to taster ved siden af hinanden (5/10). Vinduet
      // lukkes med krydset, Alt+F4 eller Ctrl+Q.
      // I Ro på henter tasterne spalten frem i stedet for at fastgøre den (6/10).
      stop();
      if (document.body.classList.contains("ro")) left.toggleOpen();
      else left.togglePin();
    } else if (key === "e" && !e.shiftKey) {
      stop();
      if (document.body.classList.contains("ro")) right.toggleOpen();
      else right.togglePin();
    } else if (key === "o" && !e.shiftKey) {
      stop();
      openQuick((p) => void openPath(p));
    } else if (key === "o" && e.shiftKey) {
      stop();
      void pick();
    } else if (key === "f" && e.shiftKey) {
      stop();
      openLibrarySearch(view);
    } else if (key === "j" && !e.shiftKey) {
      stop();
      showLeftTab("disposition");
      left.open();
      outline.focusCurrent();
    } else if (key === "c" && e.shiftKey) {
      stop();
      void import("./print/copyRich.ts").then((m) => m.copyRich(view));
    } else if (key === "q" && !e.shiftKey) {
      // Alle vinduer gemmer, før programmet lukker (windows.rs).
      stop();
      void invoke("request_quit");
    } else if (key === "n" && !e.shiftKey) {
      // Ctrl+N: et nyt, tomt vindue (ét vindue pr. tekst, 3/10).
      stop();
      void invoke("new_window", { path: null });
    } else if (key === "p" && e.shiftKey) {
      // Ctrl+Shift+P: kommandomenuen uden at skrive »/«, med markeringen i behold.
      stop();
      openCommandMenu(view);
    } else if (key === "p" && !e.shiftKey) {
      // Ctrl+P åbner forhåndsvisningen, hvor man vælger udskrift, PDF eller Word (9/10: én indgang).
      // Står den allerede åben, udskrives der, som i en browser.
      stop();
      if (printing.isOpen) void printing.print();
      else void printing.open();
    } else if (key === "d" && !e.shiftKey) {
      stop();
      void updateSettings({ focusMode: !settings().focusMode });
    } else if (key === "t" && !e.shiftKey) {
      stop();
      void updateSettings({ typewriter: !settings().typewriter });
    } else if (key === "+" || key === "=" || key === "-") {
      // Tekststørrelse (WCAG 1.4.4): browserens egen zoom er spærret, så skriften ændres her.
      stop();
      setZoom(zoom + (key === "-" ? -0.1 : 0.1));
    } else if (key === "," && !e.shiftKey) {
      stop();
      settingsPanel.toggle();
    }
  },
  { capture: true },
);

// Browserens egne genveje må aldrig nå WebView2: Ctrl+R og F5 genindlæser siden, Ctrl+P åbner
// browserens print, Ctrl+U viser kildekoden, Ctrl+plus/minus zoomer. Editorens genveje er
// allerede håndteret, når hændelsen når hertil (bubble), så her spærres kun resten.
const BROWSER_KEYS = new Set(["r", "p", "u", "j", "n", "t", "l", "d", "g", "+", "-", "=", "0"]);
window.addEventListener("keydown", (e) => {
  // F1: genvejsoversigten. Ikke Ctrl+/, for på et dansk tastatur er det Ctrl+Shift+7 (nummereret liste).
  if (e.key === "F1") {
    e.preventDefault();
    toggleShortcuts();
    return;
  }
  // F11: Ro på til og fra (5/10, før: kun fuld skærm). Esc går også ud.
  if (e.key === "F11" || (e.key === "Escape" && document.body.classList.contains("ro") && !e.defaultPrevented)) {
    if (e.key === "Escape" && document.querySelector(".cm-panels, .menu, #overlay:not([hidden]), .settings:not([hidden]), .keys")) return;
    e.preventDefault();
    void setRo(!document.body.classList.contains("ro"));
    return;
  }
  // F7: stiltjek til og fra, som Words stave- og grammatiktjek. Shift+F7: ordklasser i farver, også
  // et sprogværktøj (i Word er Shift+F7 synonymordbogen).
  if (e.key === "F7") {
    e.preventDefault();
    // Stiltjek og ordklasser kender kun dansk.
    if (isEnglish()) return void notify("Style check and word classes are only available in Danish.");
    if (e.shiftKey) void updateSettings({ wordClasses: !settings().wordClasses });
    else void updateSettings({ styleCheck: !settings().styleCheck });
    return;
  }
  const key = e.key.toLowerCase();
  if (e.key === "F5" || e.key === "F3" || e.key === "F7" || (e.ctrlKey && BROWSER_KEYS.has(key))) {
    e.preventDefault();
  }
});

// --- gem og ændringer udefra -------------------------------------------------------------------

window.addEventListener("blur", () => void session?.flush());
window.addEventListener("gt-save-now", () => void session?.flush());
// Når vinduet får fokus igen: notify kan have tabt en hændelse (research), så tjek selv.
window.addEventListener("focus", () => {
  void invoke<boolean>("check_open_file").then((changed) => {
    if (changed) void session?.externalChange();
  });
});

// Hændelser til netop dette vindue (emit_to i Rust) lyttes på vinduet. `listen` alene hører hændelser
// til alle vinduer: så lukkede et ekstra vindue også hovedvinduet (8/10).
const here = getCurrentWebviewWindow();
await here.listen<string>("open-path", (e) => void openPath(e.payload));
await listen("flush-requested", () => void session?.flush());
/** Ctrl+Q og »Afslut« i bakken: gem (eller læg i backup), og luk så programmet helt. */
async function quit(): Promise<void> {
  try {
    await session?.close();
  } finally {
    // Også hvis gem og backup fejler: Ctrl+Q skal lukke (backuppen fra sidste gem ligger der).
    await invoke("quit_app");
  }
}

await listen("quit-requested", () => void quit());
// Alle vinduer får besked; kun det vindue, der har teksten, reagerer.
await listen<string>("file-changed", (e) => {
  if (session && session.path.toLowerCase() === e.payload.toLowerCase()) void session.externalChange();
});
// Et andet vindue har ændret indstillinger eller biblioteker.
await listen("settings-changed", () =>
  void reloadSettings().then(async () => {
    await library.init();
    // Et andet sprog (i18n.ts): gem, og tegn vinduet forfra på det nye sprog.
    if ((await invoke<string>("ui_language").catch(() => currentLang())) !== currentLang()) {
      await session?.flush();
      location.reload();
    }
  }),
);
// Et ekstra vindue lukkes: gem (eller læg i backup), og luk så.
// Luk: et ekstra vindue gemmer og lukker helt; hovedvinduet gemmer og skjules, så næste tekst åbner
// med det samme. Første gang forklares det, med »Afslut helt« ved siden af (delbar udgave 3/10).
async function closeThisWindow(): Promise<void> {
  try {
    if (getCurrentWindow().label === "main") await session?.flush();
    else await session?.close();
  } finally {
    await invoke("close_window");
  }
}
function explainCloseOnce(): boolean {
  try {
    if (localStorage.getItem("gt-luk-forklaret")) return false;
    localStorage.setItem("gt-luk-forklaret", "1");
  } catch {
    return false;
  }
  showBanner(
    tr(
      "Vinduet lukker, men Gode Tekster bliver klar i baggrunden ved uret, så næste tekst åbner med det samme. Afslut helt med Ctrl+Q eller fra ikonet.",
      "The window closes, but Gode Tekster stays ready in the background by the clock, so your next text opens right away. Quit completely with Ctrl+Q or from the icon.",
    ),
    [
      { label: tr("Luk vinduet", "Close the window"), run: () => void closeThisWindow() },
      { label: tr("Afslut helt", "Quit completely"), run: () => void invoke("request_quit") },
    ],
  );
  return true;
}
// --- Ro på (5/10) -----------------------------------------------------------------------------
// Fuld skærm uden spalter, musemarkøren væk, mens der skrives, og wifi slukket, hvis det er valgt
// under Indstillinger (ro.rs tænder det igen). Esc eller F11 bringer det hele tilbage.

async function setRo(on: boolean): Promise<void> {
  const b = document.body.classList;
  b.toggle("ro", on);
  b.toggle("fullscreen", on);
  b.remove("ro-typing");
  // Spalterne starter skjult i Ro på og kan hentes frem ved kanten eller med Ctrl+W og Ctrl+E.
  left.close();
  right.close();
  await invoke("ro_set", { on }).catch(() => {});
  if (on) notify(tr("Ro på. Esc bringer det hele tilbage.", "Quiet mode. Esc brings everything back."));
  view.requestMeasure();
  view.focus();
}
// Wifi-knappen nederst til venstre i Ro på (6/10: valget under Indstillinger var svært at
// finde). Den forsvinder sammen med musemarkøren, mens der skrives. Valget gemmes og virker straks.
const roWifi = iconButton(ICON.wifi, "", () => void toggleRoWifi());
roWifi.id = "ro-wifi";
document.body.append(roWifi);
function showRoWifi(): void {
  const off = settings().roWifi ?? false;
  const label = off ? tr("Wifi er slukket i Ro på. Klik for at tænde det igen.", "Wi-Fi is off in Quiet mode. Click to turn it back on.") : tr("Sluk wifi, mens Ro på er slået til", "Turn off Wi-Fi while Quiet mode is on");
  roWifi.innerHTML = off ? ICON.wifiOff : ICON.wifi;
  roWifi.title = label;
  roWifi.setAttribute("aria-label", label);
  roWifi.setAttribute("aria-pressed", String(off));
}
async function toggleRoWifi(): Promise<void> {
  const off = !(settings().roWifi ?? false);
  await updateSettings({ roWifi: off }).catch((e) => notify(errorText(e)));
  if (document.body.classList.contains("ro")) await invoke("ro_wifi", { off }).catch(() => {});
  showRoWifi();
  notify(off ? tr("Wifi er slukket, til du går ud af Ro på.", "Wi-Fi is off until you leave Quiet mode.") : tr("Wifi er tændt igen.", "Wi-Fi is back on."));
  view.focus();
}
showRoWifi();
onSettings(showRoWifi);
// Markøren forsvinder ved første tast og kommer igen, når musen flyttes for alvor (Chromium sender
// også »flytninger« uden bevægelse, når teksten ruller under markøren).
view.contentDOM.addEventListener("keydown", (e) => {
  if (document.body.classList.contains("ro") && !e.ctrlKey && !e.altKey && (e.key.length === 1 || e.key === "Enter" || e.key === "Backspace")) {
    document.body.classList.add("ro-typing");
  }
});
window.addEventListener("mousemove", (e) => {
  if ((e.movementX || e.movementY) && document.body.classList.contains("ro-typing")) document.body.classList.remove("ro-typing");
});

await here.listen("close-requested", () => {
  // Vinduet lukkes: ud af Ro på først, så wifi er tændt igen, og vinduet ikke gemmes væk i fuld skærm.
  if (document.body.classList.contains("ro")) void setRo(false);
  if (getCurrentWindow().label === "main" && explainCloseOnce()) return;
  void closeThisWindow();
});
// Fejl i fladen havner i loggen (aldrig teksten), så en bruger kan sende den med.
window.addEventListener("error", (e) => void invoke("log_line", { text: `FEJL i fladen: ${e.message} (${(e.filename ?? "").split("/").pop()}:${e.lineno})` }));
window.addEventListener("unhandledrejection", (e) => void invoke("log_line", { text: `FEJL i fladen: ${String((e.reason as Error)?.message ?? e.reason)}` }));
await listen("folder-changed", () => {
  void library.refresh();
  // Kommandomappen kan være den, der ændrede sig (en fil rettet i hånden eller udefra).
  void reloadCommands();
});

// Én venlig hilsen efter 14 dages brug, og aldrig igen (3/10). Datoerne ligger på maskinen.
function greetOnce(): void {
  try {
    const first = localStorage.getItem("gt-foerste-start");
    if (!first) return void localStorage.setItem("gt-foerste-start", String(Date.now()));
    if (localStorage.getItem("gt-hilsen-vist") || Date.now() - Number(first) < 14 * 24 * 3600 * 1000) return;
    localStorage.setItem("gt-hilsen-vist", "1");
  } catch {
    return;
  }
  const id = showBanner(
    tr(
      "Gode Tekster er lavet af Gode Medier, der også bygger værktøjer til medier og organisationer. Har du en idé, så skriv til troels@godemedier.dk.",
      "Gode Tekster is made by Gode Medier, which also builds tools for media and organizations. If you have an idea, write to troels@godemedier.dk.",
    ),
    [
      { label: tr("Skriv til Gode Medier", "Write to Gode Medier"), run: () => void invoke("write_feedback_mail", { subject: "Gode Tekster" }) },
      { label: tr("Luk", "Close"), run: () => hideBanner(id) },
    ],
  );
}

const testMode = await invoke<{ panels: boolean; measure: boolean; scenario: string | null }>("test_mode");
if (!testMode.measure && !testMode.scenario) window.setTimeout(greetOnce, 4000);
// Kun hovedvinduet kører testscenariet; et ekstra vindue arver testtilstanden.
if (testMode.scenario && getCurrentWindow().label === "main") window.setTimeout(() => void import("./measure.ts").then((m) => m.runScenario(testMode.scenario as string, view, session?.path ?? null)), 800);
if (testMode.panels) {
  left.showForTest();
  right.showForTest();
}

try {
  show(await invoke<DocumentDto | null>("initial_document"));
} catch {
  show(null);
}

if (testMode.measure)
  window.setTimeout(
    () =>
      void import("./measure.ts").then((m) =>
        view.state.doc.length > 200_000 ? m.measurePerf(view) : m.measureJumps(view).then(() => m.measureTypewriter(view)).then(() => m.measureUi(view)).then(() => m.measureCaret(view)).then(() => m.measureLook()),
      ),
    800,
  );
requestAnimationFrame(() => void invoke("app_ready"));
