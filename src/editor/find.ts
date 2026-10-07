// Søg og erstat som i iA Writer (2/10): en linje øverst med søgefelt, antal fund, forrige,
// næste og luk, og en erstat-linje under. Ctrl+F åbner, Ctrl+H åbner med erstat, Esc lukker.
// Bygget på @codemirror/search, så fund markeres i teksten og søgningen følger med i fortryd.

import { type Extension } from "@codemirror/state";
import { EditorView, keymap, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  searchPanelOpen,
  search,
  searchKeymap,
  setSearchQuery,
} from "@codemirror/search";

import { tr } from "../i18n.ts";
import { LibraryResults } from "../ui/libraryResults.ts";

const MAX_COUNT = 9999;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, cls = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (cls) node.className = cls;
  return node;
}

function iconButton(label: string, path: string, run: () => void): HTMLButtonElement {
  const b = el("button", { type: "button", title: label }, "gt-find-icon");
  b.setAttribute("aria-label", label);
  b.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"></path></svg>`;
  b.addEventListener("click", run);
  return b;
}

/** Antal fund for den aktuelle søgning. */
export function countMatches(view: EditorView, query: SearchQuery): number {
  if (!query.valid || !query.search) return 0;
  const cursor = query.getCursor(view.state);
  let n = 0;
  while (!cursor.next().done && n < MAX_COUNT) n++;
  return n;
}

class FindPanel implements Panel {
  dom: HTMLElement;
  top = true;
  private view: EditorView;
  private countTimer: number | undefined;
  private findInput: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private replaceRow: HTMLElement;
  private mode: HTMLSelectElement;
  private count: HTMLElement;
  /** / foran søgeteksten: søg i alle tekster i stedet for i den åbne (2/10). */
  private results: LibraryResults;

  private get library(): boolean {
    return this.findInput.value.startsWith("/");
  }

  constructor(view: EditorView, withReplace: boolean) {
    this.view = view;
    const query = getSearchQuery(view.state);

    this.mode = el("select", {}, "gt-find-mode");
    this.mode.setAttribute("aria-label", tr("Søg eller erstat", "Find or replace"));
    this.mode.append(el("option", { value: "find", textContent: tr("Søg", "Find") }), el("option", { value: "replace", textContent: tr("Erstat", "Replace") }));
    this.mode.value = withReplace || query.replace ? "replace" : "find";
    this.mode.addEventListener("change", () => this.syncMode());

    this.findInput = el("input", { type: "text", value: openWithSlash ? "/" : query.search, placeholder: tr("Søg   ·   / foran søger i alle tekster", "Find   ·   start with / to search all texts") }, "gt-find-input");
    this.findInput.setAttribute("main-field", "true");
    this.findInput.setAttribute("aria-label", tr("Søg efter", "Find what"));
    this.count = el("span", {}, "gt-find-count");
    const findField = el("div", {}, "gt-find-field");
    findField.append(this.findInput, this.count);

    this.replaceInput = el("input", { type: "text", value: query.replace, placeholder: tr("Erstat med", "Replace with") }, "gt-find-input");
    this.replaceInput.setAttribute("aria-label", tr("Erstat med", "Replace with"));

    const row1 = el("div", {}, "gt-find-row");
    row1.append(
      this.mode,
      findField,
      iconButton(tr("Forrige (Shift+Enter)", "Previous (Shift+Enter)"), "M15 18l-6-6 6-6", () => findPrevious(this.view)),
      iconButton(tr("Næste (Enter)", "Next (Enter)"), "M9 18l6-6-6-6", () => findNext(this.view)),
      iconButton(tr("Luk (Esc)", "Close (Esc)"), "M6 6l12 12M18 6L6 18", () => closeSearchPanel(this.view)),
    );

    const replaceOne = el("button", { type: "button", textContent: tr("Erstat", "Replace") }, "gt-find-text");
    replaceOne.addEventListener("click", () => replaceNext(this.view));
    const replaceEvery = el("button", { type: "button", textContent: tr("Alle", "All") }, "gt-find-text");
    replaceEvery.addEventListener("click", () => replaceAll(this.view));
    this.replaceRow = el("div", {}, "gt-find-row");
    const label = el("span", { textContent: tr("Erstat", "Replace") }, "gt-find-label");
    this.replaceRow.append(label, this.replaceInput, replaceOne, replaceEvery);

    this.results = new LibraryResults((n) => (this.count.textContent = n === null ? "" : String(n)));

    this.dom = el("div", {}, "gt-find");
    this.dom.append(row1, this.replaceRow, this.results.el);
    this.dom.addEventListener("input", () => this.commit());
    this.dom.addEventListener("keydown", (e) => this.keydown(e));
    this.syncMode();
    this.updateCount();
  }

  private syncMode(): void {
    this.replaceRow.hidden = this.mode.value !== "replace";
    if (!this.replaceRow.hidden) this.replaceInput.focus();
  }

  private commit(): void {
    if (this.library) {
      // Ingen fund i den åbne tekst, mens der søges i alle.
      if (getSearchQuery(this.view.state).search) this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
      this.results.set(this.findInput.value.slice(1));
      return;
    }
    this.results.clear();
    const query = new SearchQuery({ search: this.findInput.value, replace: this.replaceInput.value });
    if (!query.eq(getSearchQuery(this.view.state))) {
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
  }

  private keydown(e: KeyboardEvent): void {
    if (this.library && e.target === this.findInput && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
      e.preventDefault();
      if (e.key === "Enter") this.results.open();
      else this.results.move(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter" && e.target === this.findInput) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.key === "Enter" && e.target === this.replaceInput) {
      e.preventDefault();
      replaceNext(this.view);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(this.view);
      this.view.focus();
    }
  }

  private updateCount(): void {
    if (this.library) return;
    const query = getSearchQuery(this.view.state);
    const n = countMatches(this.view, query);
    this.count.textContent = query.search ? String(n) : "";
  }

  mount(): void {
    this.findInput.focus();
    // Åbnet med / (Ctrl+Shift+F): markøren efter skråstregen, så den ikke overskrives.
    if (this.library) {
      this.findInput.setSelectionRange(this.findInput.value.length, this.findInput.value.length);
      this.results.set(this.findInput.value.slice(1));
    } else this.findInput.select();
  }

  update(u: ViewUpdate): void {
    for (const tr of u.transactions) {
      for (const e of tr.effects) {
        if (e.is(setSearchQuery) && !this.library && !e.value.eq(new SearchQuery({ search: this.findInput.value, replace: this.replaceInput.value }))) {
          this.findInput.value = e.value.search;
          this.replaceInput.value = e.value.replace;
        }
      }
    }
    const queryChanged = u.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)));
    if (!queryChanged && !u.docChanged) return;
    window.clearTimeout(this.countTimer);
    if (queryChanged) this.updateCount();
    // Skrives der i teksten, mens søgelinjen er åben, tælles først ved en pause (perf-review 2/10).
    else this.countTimer = window.setTimeout(() => this.updateCount(), 150);
  }

  destroy(): void {
    window.clearTimeout(this.countTimer);
    this.results.clear();
  }
}

let openWithReplace = false;
let openWithSlash = false;

/** Ctrl+Shift+F: søgelinjen med / skrevet, så der søges i alle tekster. */
export function openLibrarySearch(view: EditorView): boolean {
  openWithSlash = true;
  closeSearchPanel(view);
  const opened = openSearchPanel(view);
  openWithSlash = false;
  return opened;
}

export function openReplace(view: EditorView): boolean {
  openWithReplace = true;
  closeSearchPanel(view);
  const opened = openSearchPanel(view);
  openWithReplace = false;
  return opened;
}

/** Ctrl+F (2/10): første tryk åbner søgelinjen, andet tryk lukker den igen. */
export function toggleFind(view: EditorView): boolean {
  if (searchPanelOpen(view.state)) {
    closeSearchPanel(view);
    view.focus();
    return true;
  }
  return openSearchPanel(view);
}

export function findExtension(): Extension {
  return [
    search({ top: true, createPanel: (view) => new FindPanel(view, openWithReplace) }),
    // Ctrl+F og Ctrl+H fanges i main.ts for hele vinduet, så de også virker, når fokus står i
    // søgefeltet. Ellers når de ud til WebView2's egen søgelinje.
    keymap.of(searchKeymap.filter((b) => b.key !== "Mod-f")),
    EditorView.theme({
      ".cm-searchMatch": { backgroundColor: "var(--fund)", borderRadius: "2px" },
      ".cm-searchMatch-selected": { backgroundColor: "var(--fund-valgt)" },
      ".cm-panels-top": { borderBottom: "1px solid var(--streg)", backgroundColor: "var(--panel)" },
      ".gt-find-input::placeholder": { color: "var(--dæmpet)" },
      ".gt-find-results": { listStyle: "none", margin: "0", padding: "4px 6px 8px", maxHeight: "40vh", overflowY: "auto", fontFamily: "var(--ui)", fontSize: "13px" },
      ".gt-find-results li": { padding: "6px 10px", borderRadius: "8px", cursor: "pointer", display: "flex", flexDirection: "column", gap: "2px" },
      ".gt-find-results li[aria-selected='true']": { background: "var(--valgt)", boxShadow: "inset 3px 0 0 var(--blå)" },
      ".gt-find-hit-line": { color: "var(--svag)", fontSize: "12px" },
      ".gt-find-note": { color: "var(--svag)", cursor: "default" },
    }),
  ];
}
