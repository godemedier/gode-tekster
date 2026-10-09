// Genvejsoversigten (F1): alle genveje ét sted, så de kan findes uden at stå på skærmen.
// shortcutsHelp.test.ts fejler, hvis en genvej i editor/shortcuts.ts mangler her.

import { isEnglish, tr } from "../i18n.ts";

// F7 og Shift+F7 (stiltjek og ordklasser) bygger på danske ordlister og findes kun på dansk.
const LANGUAGE_TOOLS: [string, string][] = isEnglish()
  ? []
  : [
      ["F7", "Stiltjek til og fra"],
      ["Shift+F7", "Ordklasser i farver til og fra"],
    ];

export const GROUPS: [string, [string, string][]][] = [
  [
    tr("Skriv", "Write"),
    [
      ["Ctrl+B", tr("Fed", "Bold")],
      ["Ctrl+I", tr("Kursiv", "Italic")],
      ["Ctrl+U", tr("Understreget", "Underline")],
      [tr("Ctrl+Shift+X eller Alt+Shift+5", "Ctrl+Shift+X or Alt+Shift+5"), tr("Gennemstreget", "Strikethrough")],
      ["Ctrl+Shift+D", tr("Dæmp", "Dim")],
      ["Ctrl+K", "Link"],
      [tr("Ctrl+1 til 3", "Ctrl+1 to 3"), tr("Overskrift", "Heading")],
      ["Ctrl+4", tr("Manchet", "Standfirst")],
      ["Ctrl+0", tr("Brødtekst", "Body text")],
      [tr("Ctrl+Shift+8 eller Ctrl+Shift+L", "Ctrl+Shift+8 or Ctrl+Shift+L"), tr("Punktliste", "Bulleted list")],
      ["Ctrl+Shift+7", tr("Nummereret liste", "Numbered list")],
      ["Ctrl+Shift+9", tr("Afkrydsningsliste", "Checklist")],
      ["Ctrl+Shift+Q", tr("Citat", "Quote")],
      ["Ctrl+Alt+F", tr("Fodnote", "Footnote")],
      ["Ctrl+Alt+N", tr("Kommentar til mig selv", "Comment to yourself")],
      ["Ctrl+Alt+X", tr("Flyt til fraklip", "Move to Clippings")],
      ["Ctrl+Alt+I", tr("Indsæt billede", "Insert image")],
      [tr("Ctrl+klik", "Ctrl+click"), tr("Åbn et link", "Open a link")],
      ["/", tr("Skabeloner og kommandoer (i starten af en linje eller efter et mellemrum)", "Templates and commands (at the start of a line or after a space)")],
      ["Ctrl+Shift+P", tr("Kommandoer på det markerede", "Commands on the selection")],
      ["Alt+↑ / Alt+↓", tr("Flyt afsnit (i en overskrift: hele sektionen)", "Move paragraph (in a heading: the whole section)")],
      ["Alt+Shift+← / →", tr("Fold sektionen sammen eller ud", "Fold or unfold the section")],
      ["Tab / Shift+Tab", tr("Ryk ind og ud (i en liste: underpunkt)", "Indent and outdent (in a list: sub-item)")],
    ],
  ],
  [
    "Find",
    [
      ["Ctrl+F", tr("Søg (igen lukker)", "Find (press again to close)")],
      ["Ctrl+H", tr("Søg og erstat", "Find and replace")],
      ["Ctrl+Shift+F", tr("Søg i alle tekster (eller / i søgefeltet)", "Search all texts (or / in the search box)")],
      ["Ctrl+J", tr("Disposition i venstre spalte", "Outline in the left panel")],
    ],
  ],
  [
    tr("Vis", "View"),
    [
      ["Ctrl+W", tr("Fastgør venstre panel", "Pin the left panel")],
      ["Ctrl+E", tr("Fastgør højre panel", "Pin the right panel")],
      ["Ctrl+D", tr("Fokus", "Focus")],
      ["Ctrl+T", tr("Teksten ruller som på en skrivemaskine", "Typewriter scrolling")],
      ...LANGUAGE_TOOLS,
      ["F11", tr("Ro på: fuld skærm, kun teksten (Esc går ud)", "Quiet mode: full screen, only the text (Esc to exit)")],
      ["Ctrl+N", tr("Nyt vindue (Ctrl+klik i biblioteket åbner en tekst i nyt vindue)", "New window (Ctrl+click in the Library opens a text in a new window)")],
      ["Ctrl+plus / Ctrl+minus", tr("Større og mindre skrift", "Larger and smaller text")],
      ["Ctrl+,", tr("Indstillinger", "Settings")],
      ["F1", tr("Genveje", "Shortcuts")],
    ],
  ],
  [
    tr("Filer", "Files"),
    [
      ["Ctrl+O", tr("Find en tekst", "Find a text")],
      ["Ctrl+Shift+O", tr("Åbn med Windows' dialog", "Open with the Windows dialog")],
      ["*", tr("Stjernemarkér en mappe eller fil i biblioteket, så den står øverst", "Star a folder or file in the Library so it stays at the top")],
      ["Ctrl+S", tr("Gem nu (det sker også af sig selv)", "Save now (it also happens automatically)")],
      ["Ctrl+P", tr("Udskriv, PDF og Word (Ctrl+P igen udskriver)", "Print, PDF and Word (Ctrl+P again prints)")],
      ["Ctrl+Shift+C", tr("Kopiér som formateret tekst", "Copy as formatted text")],
      ["Alt+F4", tr("Luk vinduet", "Close the window")],
      ["Ctrl+Q", tr("Afslut", "Quit")],
    ],
  ],
];

import { rememberFocus } from "./focus.ts";

let box: HTMLElement | null = null;
let restore: (() => void) | null = null;

export function toggleShortcuts(): void {
  if (box) return closeShortcuts();
  restore = rememberFocus();
  box = document.createElement("div");
  box.className = "keys";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", tr("Genveje", "Shortcuts"));
  box.tabIndex = -1;
  const sheet = document.createElement("div");
  sheet.className = "keys-sheet";
  for (const [title, rows] of GROUPS) {
    const sec = document.createElement("section");
    const h = document.createElement("h3");
    h.textContent = title;
    const dl = document.createElement("dl");
    for (const [key, what] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = what;
      const dd = document.createElement("dd");
      // Hver tast for sig som en lille knap; »eller«, »til« og »/« står imellem (visuel gennemgang 5/10).
      for (const part of key.split(/( eller | or | til | to | \/ )/)) {
        if (/^ (eller|or|til|to|\/) $/.test(part)) {
          const sep = document.createElement("span");
          sep.className = "keys-sep";
          sep.textContent = part.trim();
          dd.append(sep);
        } else if (part) {
          const kbd = document.createElement("kbd");
          kbd.textContent = part;
          dd.append(kbd);
        }
      }
      dl.append(dt, dd);
    }
    sec.append(h, dl);
    sheet.append(sec);
  }
  box.append(sheet);
  box.addEventListener("mousedown", (e) => {
    if (e.target === box) closeShortcuts();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeShortcuts();
  });
  document.body.append(box);
  box.focus();
}

function closeShortcuts(): void {
  box?.remove();
  box = null;
  restore?.();
  restore = null;
}
