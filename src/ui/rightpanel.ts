// Højre spalte (design runde 2-5): Fraklip er standardfanen, Fodnoter (id »noter«) er fodnoterne. Sprog og
// Input tilføjes af deres egne moduler med `addTab` (main.ts). Kommandoer bor i Indstillinger (7/10). Indholdet læses af dokumentet hver gang,
// så filen altid er sandheden (ADR-0003): fanerne er en visning af kommentarer og definitioner i
// teksten, ikke en kopi.

import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";

import { dimmedInBody, parkDimmedChanges } from "../editor/dimming.ts";
import { findParked, parkChanges, parkedBlock, splitClippings, type Parked } from "../editor/parked.ts";
import { footnoteDefinition, footnoteNumbers, footnoteRef } from "../editor/inline.ts";
import { cmd } from "../editor/shortcuts.ts";
import { findNotes } from "../editor/critic.ts";
import { expandParkRange, type Span } from "../editor/parkRange.ts";
/** Et afsnit med sin plads i teksten (kun fra test og senere kilder): så fjernes netop det afsnit. */
const PARAGRAPH_TYPE = "application/x-gt-afsnit";
import { showMenu } from "./menu.ts";
import { errorText, showBanner } from "./banner.ts";
import { tr } from "../i18n.ts";

type Tab = { id: string; label: string; secondary: boolean; render: (body: HTMLElement) => void };

const PARKED_TYPE = "application/x-gt-parkeret";

export class RightPanel {
  private view: EditorView;
  private tabsEl: HTMLElement;
  private body: HTMLElement;
  private tabs: Tab[] = [];
  private active = "fraklip";
  private timer: number | undefined;
  private docPath: () => string | null;
  private focusNote: string | null = null;
  /** Teksten er ændret, mens spalten var skjult. */
  private stale = false;

  constructor(root: HTMLElement, view: EditorView, footer: HTMLElement, docPath: () => string | null) {
    this.view = view;
    this.docPath = docPath;
    root.addEventListener("mouseenter", () => {
      if (this.stale) this.render();
    });
    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "rp-tabs";
    this.tabsEl.setAttribute("role", "tablist");
    this.body = document.createElement("div");
    this.body.className = "rp-body";
    root.append(this.tabsEl, this.body, footer);

    this.addTab({ id: "fraklip", label: tr("Fraklip", "Clippings"), secondary: false, render: (b) => this.renderClippings(b) });
    this.addTab({ id: "noter", label: tr("Fodnoter", "Footnotes"), secondary: false, render: (b) => this.renderNotes(b) });

    // Tekst trukket fra editoren over i spalten bliver et fraklip. Alt beholder en kopi i teksten.
    root.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("text/plain") && !e.dataTransfer.types.includes(PARKED_TYPE) && !e.dataTransfer.types.includes("application/x-gt-fil")) {
        e.preventDefault();
        root.classList.add("rp-drop");
      }
    });
    root.addEventListener("dragleave", (e) => {
      if (!root.contains(e.relatedTarget as Node)) root.classList.remove("rp-drop");
    });
    root.addEventListener("drop", (e) => {
      root.classList.remove("rp-drop");
      const text = e.dataTransfer?.getData("text/plain");
      if (!text || e.dataTransfer?.types.includes(PARKED_TYPE) || e.dataTransfer?.types.includes("application/x-gt-fil")) return;
      e.preventDefault();
      let paragraph: Span | undefined;
      try {
        paragraph = JSON.parse(e.dataTransfer?.getData(PARAGRAPH_TYPE) || "null") ?? undefined;
      } catch {
        paragraph = undefined;
      }
      this.parkDropped(text, e.altKey, paragraph);
    });
  }

  addTab(tab: Tab): void {
    this.tabs.push(tab);
    this.renderTabs();
  }

  show(id: string): void {
    this.active = id;
    this.renderTabs();
    this.render();
  }

  /** Kaldes, når teksten ændres. Lidt forsinket, så spalten ikke tegnes om ved hvert tastetryk. */
  docChanged(): void {
    this.stale = true;
    window.clearTimeout(this.timer);
    // Skjult spalte tegnes ikke for ingenting; den tegnes, når musen kommer (performance 2/10).
    if (!this.visible) return;
    this.timer = window.setTimeout(() => this.render(), 200);
  }

  private get visible(): boolean {
    const b = document.body.classList;
    return b.contains("right-open") || b.contains("right-pinned");
  }

  /** Ctrl+Alt+F: vis fanen Fodnoter med den nye note klar til at skrive i. */
  openNote(label: string): void {
    this.focusNote = label;
    this.show("noter");
  }

  private renderTabs(): void {
    const buttons = this.tabs.map((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(t.id === this.active));
      b.className = "rp-tab" + (t.secondary ? " rp-tab-secondary" : "");
      b.textContent = t.label;
      b.addEventListener("click", () => this.show(t.id));
      return b;
    });
    const first = this.tabs.findIndex((t) => t.secondary);
    if (first > 0) {
      const gap = document.createElement("span");
      gap.style.flexGrow = "1";
      buttons.splice(first, 0, gap as unknown as HTMLButtonElement);
    }
    this.tabsEl.replaceChildren(...buttons);
  }

  render(): void {
    this.stale = false;
    const tab = this.tabs.find((t) => t.id === this.active) ?? this.tabs[0];
    // Fanerne deler kroppen. Claude-fanen tegner også selv om, når et svar kommer, og skal vide, om det er dens tur.
    this.body.dataset.tab = tab.id;
    // Kun fanen Input med svar gør spalten bred (claudepanel.ts); de andre fanes er smalle.
    document.body.classList.remove("rp-wide");
    tab.render(this.body);
  }

  // --- Fraklip ---------------------------------------------------------------------------------

  private renderClippings(body: HTMLElement): void {
    const doc = this.view.state.doc.toString();
    const parked = findParked(doc);
    // Plusset er væk (4/10): menuen ligger på højreklik i fanen, og en tom fane siger hvordan.
    body.oncontextmenu = (e) => {
      if (body.dataset.tab !== "fraklip") return;
      e.preventDefault();
      void this.clippingMenu(e.clientX, e.clientY);
    };
    const cards = parked.map((p) => this.card(p));
    if (!cards.length) {
      const empty = document.createElement("p");
      empty.className = "rp-empty";
      empty.textContent = tr("Træk tekst hertil, eller markér og tryk Ctrl+Alt+X. Højreklik for flere valg.", "Drag text here, or select it and press Ctrl+Alt+X. Right-click for more options.");
      body.replaceChildren(empty);
      return;
    }
    body.replaceChildren(...cards);
  }

  private async clippingMenu(x: number, y: number): Promise<void> {
    const path = this.docPath();
    const files = path ? await invoke<{ name: string; path: string }[]>("sibling_clippings", { path }) : [];
    const doc = this.view.state.doc.toString();
    const dimmed = dimmedInBody(doc);
    showMenu(x, y, [
      { label: tr("Flyt markeringen hertil (Ctrl+Alt+X)", "Move the selection here (Ctrl+Alt+X)"), run: () => cmd.park(this.view) },
      // 2/10: ét sted, hvor al dæmpet tekst kan flyttes ud af teksten.
      ...(dimmed.length
        ? [{
            label: tr(
              `Flyt al dæmpet tekst hertil (${dimmed.length} ${dimmed.length === 1 ? "stykke" : "stykker"})`,
              `Move all dimmed text here (${dimmed.length} ${dimmed.length === 1 ? "piece" : "pieces"})`,
            ),
            run: () => this.view.dispatch({ changes: parkDimmedChanges(doc, dimmed), userEvent: "delete.park" }),
          }]
        : []),
      ...files.map((f) => ({ label: tr(`Hent ${f.name} ind`, `Bring in ${f.name}`), run: () => void this.importClippings(f.path) })),
    ]);
  }

  private card(p: Parked): HTMLElement {
    const card = document.createElement("div");
    card.className = "rp-card";
    if (p.color) card.setAttribute("data-color", p.color);
    card.draggable = true;

    const lines = p.text.trim().split(/\r?\n/);
    const first = lines[0] || "";
    let title = "";
    let body = p.text;
    const m = first.match(/^(\*\*|__)(.*?)\1$/);
    if (m) {
      title = m[2].trim();
      body = lines.slice(1).join("\n").trim();
    }

    card.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", p.text);
      e.dataTransfer?.setData(PARKED_TYPE, p.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
    });
    card.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes(PARKED_TYPE)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = card.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (e.clientY < mid) {
          card.classList.add("rp-drop-above");
          card.classList.remove("rp-drop-below");
        } else {
          card.classList.add("rp-drop-below");
          card.classList.remove("rp-drop-above");
        }
      }
    });
    card.addEventListener("dragleave", () => {
      card.classList.remove("rp-drop-above", "rp-drop-below");
    });
    card.addEventListener("drop", (e) => {
      card.classList.remove("rp-drop-above", "rp-drop-below");
      const draggedId = e.dataTransfer?.getData(PARKED_TYPE);
      if (draggedId && draggedId !== p.id) {
        e.preventDefault();
        e.stopPropagation();
        const rect = card.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        this.reorderParked(draggedId, p.id, e.clientY >= mid);
      }
    });

    if (title && !body) {
      card.className = "rp-group-header";
      card.textContent = title;
      card.addEventListener("dblclick", () => this.editCard(p, card));
      return card;
    }

    if (title) {
      const header = document.createElement("div");
      header.className = "rp-card-header";
      header.textContent = title;
      card.append(header);
    }

    const text = document.createElement("div");
    text.className = "rp-card-text";
    text.textContent = body;
    text.addEventListener("dblclick", () => this.editCard(p, text));
    
    const tools = document.createElement("div");
    tools.className = "rp-card-tools";

    // Farverne er skrivebordsnoternes (note.css), så de også følger mørk og aften.
    const colors = document.createElement("div");
    colors.className = "rp-colors";
    const COLORS: [string, string][] = [
      ["gul", tr("Gul", "Yellow")],
      ["groen", tr("Grøn", "Green")],
      ["blaa", tr("Blå", "Blue")],
      ["rosa", tr("Rosa", "Pink")],
    ];
    for (const [c, name] of COLORS) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "rp-dot";
      dot.dataset.color = c;
      dot.title = name;
      dot.setAttribute("aria-label", tr(`Farve: ${name}`, `Colour: ${name}`));
      dot.setAttribute("aria-pressed", String(p.color === c));
      dot.addEventListener("click", () => {
        const fresh = findParked(this.view.state.doc.toString()).find((x) => x.id === p.id);
        if (!fresh) return;
        const color = fresh.color === c ? undefined : c; // samme farve igen fjerner den
        this.view.dispatch({
          changes: { from: fresh.from, to: fresh.to, insert: parkedBlock(fresh.id, fresh.date, fresh.text, color) },
          userEvent: "input.park",
        });
      });
      colors.append(dot);
    }

    const back = document.createElement("button");
    back.type = "button";
    back.textContent = tr("Tilbage i teksten", "Back into the text");
    back.addEventListener("click", () => this.restore(p));

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = tr("Slet", "Delete");
    del.addEventListener("click", () => this.removeParked(p.id));

    tools.append(colors, back, del);
    card.append(text, tools);
    return card;
  }

  private editCard(p: Parked, el: HTMLElement): void {
    const area = document.createElement("textarea");
    area.className = "rp-edit";
    area.value = p.text;
    area.rows = Math.min(14, Math.max(3, p.text.split("\n").length + 1));
    el.replaceWith(area);
    area.focus();
    const done = () => {
      const fresh = findParked(this.view.state.doc.toString()).find((x) => x.id === p.id);
      if (fresh && area.value.trim() !== fresh.text) {
        this.view.dispatch({
          changes: { from: fresh.from, to: fresh.to, insert: parkedBlock(fresh.id, fresh.date, area.value, fresh.color) },
          userEvent: "input.park",
        });
      }
      this.render();
    };
    area.addEventListener("blur", done);
    area.addEventListener("keydown", (e) => {
      if (e.key === "Escape") area.blur();
    });
  }

  /** Lægger et fraklip tilbage ved markøren og fjerner kortet. */
  private restore(p: Parked): void {
    const pos = this.view.state.selection.main.head;
    const changes = [
      { from: pos, insert: p.text },
      { from: p.from, to: p.to, insert: "" },
    ];
    this.view.dispatch({ changes, userEvent: "input.park", scrollIntoView: true });
    this.view.focus();
  }

  removeParked(id: string): void {
    const p = findParked(this.view.state.doc.toString()).find((x) => x.id === id);
    if (p) this.view.dispatch({ changes: { from: p.from, to: p.to, insert: "" }, userEvent: "delete.park" });
  }

  private reorderParked(draggedId: string, targetId: string, after: boolean): void {
    const doc = this.view.state.doc.toString();
    const parked = findParked(doc);
    const dragged = parked.find((x) => x.id === draggedId);
    const target = parked.find((x) => x.id === targetId);
    if (!dragged || !target) return;

    const draggedContent = doc.slice(dragged.from, dragged.to);
    const insertPos = after ? target.to : target.from;
    
    this.view.dispatch({
      changes: [
        { from: dragged.from, to: dragged.to, insert: "" },
        { from: insertPos, insert: draggedContent }
      ],
      userEvent: "input.park"
    });
    this.render();
  }

  /**
   * Tekst trukket fra editoren: markeringen eller et afsnit med sin plads (PARAGRAPH_TYPE). Den
   * udvides til hele ord og hele noter (parkRange.ts) og fjernes fra teksten (Alt = kopi).
   */
  private parkDropped(text: string, keepCopy: boolean, paragraph?: Span): void {
    const state = this.view.state;
    const sel = state.selection.main;
    let span: Span | undefined;
    if (paragraph && state.sliceDoc(paragraph.from, paragraph.to) === text) span = paragraph;
    else if (!sel.empty && state.sliceDoc(sel.from, sel.to).trim() === text.trim()) span = expandParkRange(state, sel);
    if (span) text = state.sliceDoc(span.from, span.to);
    const remove = span && !keepCopy ? span : undefined;
    this.view.dispatch({
      changes: parkChanges(state.doc.toString(), [text], remove),
      userEvent: remove ? "delete.park" : "input.park",
    });
    this.show("fraklip");
  }

  private async importClippings(path: string): Promise<void> {
    let text: string;
    try {
      text = await invoke<string>("read_clipping", { path });
    } catch (e) {
      showBanner(errorText(e));
      return;
    }
    const pieces = splitClippings(text);
    if (pieces.length) {
      this.view.dispatch({ changes: parkChanges(this.view.state.doc.toString(), pieces), userEvent: "input.import" });
    }
    this.show("fraklip");
  }

  // --- Noter -----------------------------------------------------------------------------------

  private renderNotes(body: HTMLElement): void {
    const doc = this.view.state.doc.toString();
    const numbers = footnoteNumbers(doc);
    const defs = new Map([...numbers.keys()].map((label) => [label, footnoteDefinition(doc, label)]));
    const items = [...numbers.entries()].map(([label, n]) => {
      const row = document.createElement("div");
      row.className = "rp-note";
      const num = document.createElement("button");
      num.type = "button";
      num.className = "rp-note-num";
      num.textContent = String(n);
      num.title = tr("Gå til henvisningen", "Go to the reference");
      num.addEventListener("click", () => this.jumpToRef(label));
      const area = document.createElement("textarea");
      area.className = "rp-edit";
      area.rows = 2;
      area.value = defs.get(label)?.text ?? "";
      area.setAttribute("aria-label", tr(`Fodnote ${n}`, `Footnote ${n}`));
      // Feltet vokser med noten i stedet for at skære den over (visuel gennemgang 5/10).
      const fit = () => {
        area.style.height = "auto";
        area.style.height = `${area.scrollHeight + 2}px`;
      };
      area.addEventListener("input", fit);
      requestAnimationFrame(fit);
      area.addEventListener("change", () => this.setNote(label, area.value));
      area.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          area.blur();
        }
      });
      row.append(num, area);
      if (this.focusNote === label) {
        this.focusNote = null;
        window.setTimeout(() => area.focus(), 0);
      }
      return row;
    });
    body.replaceChildren(...items, ...this.myNotes(doc));
  }

  /** Noter til mig selv <!-- … --> (critic.ts), i den rækkefølge de står. Klik springer til noten. */
  private myNotes(doc: string): HTMLElement[] {
    const notes = findNotes(doc);
    if (!notes.length) return [];
    const title = document.createElement("h3");
    title.className = "rp-subhead";
    title.textContent = tr("Dine kommentarer", "Your comments");
    return [
      title,
      ...notes.map((n) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "rp-mynote";
        b.textContent = n.text || tr("(tom kommentar)", "(empty comment)");
        b.addEventListener("click", () => {
          this.view.dispatch({ selection: { anchor: n.from + 3 }, scrollIntoView: true });
          this.view.focus();
        });
        return b;
      }),
    ];
  }

  private setNote(label: string, text: string): void {
    const doc = this.view.state.doc.toString();
    const clean = text.replace(/\n+/g, " ").trim();
    const def = footnoteDefinition(doc, label);
    if (def) {
      this.view.dispatch({ changes: { from: def.from, to: def.to, insert: `[^${label}]: ${clean}` }, userEvent: "input.note" });
    } else {
      const parked = findParked(doc)[0];
      const at = parked ? parked.from : doc.length;
      const lead = doc.slice(0, at).endsWith("\n\n") ? "" : "\n\n";
      this.view.dispatch({ changes: { from: at, insert: `${lead}[^${label}]: ${clean}\n` }, userEvent: "input.note" });
    }
  }

  private jumpToRef(label: string): void {
    const doc = this.view.state.doc.toString();
    const ref = footnoteRef(doc, label);
    if (!ref) return;
    this.view.dispatch({ selection: { anchor: ref.to }, scrollIntoView: true });
    this.view.focus();
  }
}

