// Højre spalte (design runde 2-5): Fraklip er standardfanen, Fodnoter (id »noter«) er fodnoterne. Sprog og
// AI-hjælp tilføjes af deres egne moduler med `addTab` (main.ts). Fanerne er en ikonbjælke i højre side i tre
// grupper, med tal på ikonerne (design 20/10, bud 2): otte fanenavne på to linjer var for uroligt.
// Kommandoer bor i Indstillinger (7/10). Indholdet læses af dokumentet hver gang, så filen altid er
// sandheden (ADR-0003): fanerne er en visning af kommentarer og definitioner i teksten, ikke en kopi.

import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";

import { dimmedInBody, parkDimmedChanges } from "../editor/dimming.ts";
import { findParked, parkChanges, parkedBlock, splitClippings, type Parked } from "../editor/parked.ts";
import { footnoteDefinitions, footnoteEdit, footnoteNumbers, footnoteRef } from "../editor/inline.ts";
import { cmd } from "../editor/shortcuts.ts";
import { findNotes } from "../editor/critic.ts";
import { visibleText } from "../editor/hidden.ts";
import { expandParkRange, parkPlan, type Span } from "../editor/parkRange.ts";
import { showMenu } from "./menu.ts";
import { ICON, iconButton } from "./icons.ts";
import { errorText, showBanner } from "./banner.ts";
import { tr } from "../i18n.ts";
import { preserveFocus } from "./focus.ts";

/** Teksten (Fraklip, Fodnoter, Kilder, Struktur), Hjælp (Sprog, AI-hjælp) og Andre (Deling, Lyd). */
export type TabGroup = "tekst" | "hjaelp" | "andre";
const GROUPS: TabGroup[] = ["tekst", "hjaelp", "andre"];

type Tab = {
  id: string;
  label: string;
  group: TabGroup;
  /** En konstant fra ICON, aldrig tekst udefra (den sættes med innerHTML). */
  icon: string;
  /** Linjen under overskriften. */
  hint?: string;
  /** Hvor mange der er (fraklip, fodnoter, kilder). Står diskret i overskriften, ikke på ikonet. */
  count?: () => number;
  /**
   * Hvor mange ting der venter på brugeren (nye forslag i Deling). Kun det giver en prik på ikonet:
   * tal for alt gjorde bjælken støjende, og man kunne ikke se, hvad der krævede noget (UX 20/10).
   */
  alert?: () => number;
  render: (body: HTMLElement) => void;
};

const PARKED_TYPE = "application/x-gt-parkeret";
/** Et afsnit med sin plads i teksten (kun fra test og senere kilder): så fjernes netop det afsnit. */
const PARAGRAPH_TYPE = "application/x-gt-afsnit";

export class RightPanel {
  private view: EditorView;
  private tabsEl: HTMLElement;
  /** Knapper under fanerne, der gør noget i stedet for at vise en fane (Udskriv/Eksportér). */
  private actionsEl: HTMLElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private titleCount: HTMLElement;
  private hint: HTMLElement;
  private buttons = new Map<string, { button: HTMLButtonElement; badge: HTMLElement }>();
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
    // Bjælken: fanerne er en tabliste (piletaster flytter mellem dem), Fastgør står uden for den.
    const rail = document.createElement("div");
    rail.className = "rp-rail";
    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "rp-tablist";
    this.tabsEl.setAttribute("role", "tablist");
    this.tabsEl.setAttribute("aria-orientation", "vertical");
    this.tabsEl.setAttribute("aria-label", tr("Vælg værktøj", "Choose a tool"));
    this.tabsEl.addEventListener("keydown", (e) => this.railKey(e));
    this.actionsEl = document.createElement("div");
    this.actionsEl.className = "rp-actions";
    rail.append(this.tabsEl, this.actionsEl, footer);
    const head = document.createElement("header");
    head.className = "rp-head";
    this.title = document.createElement("h2");
    this.title.className = "rp-title";
    this.title.id = "rp-title";
    this.titleCount = document.createElement("span");
    this.titleCount.className = "rp-title-count";
    this.hint = document.createElement("p");
    this.hint.className = "rp-hint";
    head.append(this.title, this.hint);
    this.body = document.createElement("div");
    this.body.className = "rp-body";
    this.body.id = "rp-panel";
    this.body.setAttribute("role", "tabpanel");
    this.body.setAttribute("aria-labelledby", "rp-title");
    const main = document.createElement("div");
    main.className = "rp-main";
    main.append(head, this.body);
    root.append(main, rail);

    this.addTab({
      id: "fraklip",
      label: tr("Fraklip", "Clippings"),
      group: "tekst",
      icon: ICON.scissors,
      hint: tr("Tekst, du har klippet fra, men vil gemme", "Text you cut but want to keep"),
      // Gruppeoverskrifterne (en fed linje alene) er ikke fraklip.
      count: this.perDoc((doc) => findParked(doc).filter((p) => !/^(\*\*|__).*\1$/.test(p.text.trim())).length),
      render: (b) => this.renderClippings(b),
    });
    this.addTab({
      id: "noter",
      label: tr("Fodnoter", "Footnotes"),
      group: "tekst",
      icon: ICON.footnote,
      hint: tr("Fodnoterne og dine kommentarer", "Footnotes and your comments"),
      // Samme tal som listen i fanen. Regnes kun ved ny tekst og i ro (perDoc, scheduleCounts).
      count: this.perDoc((doc) => footnoteNumbers(doc).size),
      render: (b) => this.renderNotes(b),
    });

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

  /** `before`: fanen står foran denne, også når den kommer senere (Deling før Lyd, 22/10). */
  addTab(tab: Tab, before?: string): void {
    if (this.tabs.some((t) => t.id === tab.id)) return;
    const at = before ? this.tabs.findIndex((t) => t.id === before) : -1;
    if (at >= 0) this.tabs.splice(at, 0, tab);
    else this.tabs.push(tab);
    this.renderTabs();
  }

  /**
   * En knap nederst i bjælken, der åbner noget andet end en fane (26/10: Ctrl+P som »Udskriv« og
   * »Eksportér« på hver sin linje). Den er ikke en fane og står derfor uden for tablisten.
   */
  addAction(icon: string, lines: string[], title: string, run: () => void): void {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rp-rail-btn rp-action";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = icon;
    for (const text of lines) {
      const label = document.createElement("span");
      label.className = "rp-rail-label";
      label.textContent = text;
      b.append(label);
    }
    b.addEventListener("click", run);
    const line = document.createElement("span");
    line.className = "rp-rail-line";
    line.setAttribute("aria-hidden", "true");
    this.actionsEl.append(line, b);
  }

  /** En fane, der kun gælder nogle gange (Deling uden synk). Står den åben, vises Fraklip. */
  removeTab(id: string): void {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.tabs = this.tabs.filter((t) => t.id !== id);
    if (this.active === id) this.show("fraklip");
    else this.renderTabs();
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
    // Grupperne i fast rækkefølge, så de ikke afhænger af, i hvilken rækkefølge modulerne tilføjer fanerne.
    const items: HTMLElement[] = [];
    this.buttons.clear();
    for (const group of GROUPS) {
      const tabs = this.tabs.filter((t) => t.group === group);
      if (!tabs.length) continue;
      if (items.length) {
        const line = document.createElement("span");
        line.className = "rp-rail-line";
        line.setAttribute("aria-hidden", "true");
        items.push(line);
      }
      for (const t of tabs) {
        const b = document.createElement("button");
        b.type = "button";
        b.setAttribute("role", "tab");
        const selected = t.id === this.active;
        b.setAttribute("aria-selected", String(selected));
        b.setAttribute("aria-controls", "rp-panel");
        // Kun den valgte fane er et Tab-stop. Piletasterne flytter mellem dem (railKey).
        b.tabIndex = selected ? 0 : -1;
        b.className = "rp-rail-btn";
        b.dataset.tab = t.id;
        // Navnet står under ikonet (21/10). Før kun som værktøjstip, og ikonerne var svære at afkode.
        b.innerHTML = t.icon;
        const label = document.createElement("span");
        label.className = "rp-rail-label";
        label.textContent = t.label;
        b.append(label);
        const badge = document.createElement("span");
        badge.className = "rp-badge";
        badge.setAttribute("aria-hidden", "true");
        badge.hidden = true;
        b.append(badge);
        b.addEventListener("click", () => this.show(t.id));
        this.buttons.set(t.id, { button: b, badge });
        items.push(b);
      }
    }
    this.tabsEl.replaceChildren(...items);
    this.scheduleCounts();
  }

  /** Pil op og ned, Home og End flytter mellem ikonerne. Enter og mellemrum vælger (knappens egne). */
  private railKey(e: KeyboardEvent): void {
    const buttons = [...this.buttons.values()].map((v) => v.button);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next =
      e.key === "ArrowDown" ? (at + 1) % buttons.length
      : e.key === "ArrowUp" ? (at - 1 + buttons.length) % buttons.length
      : e.key === "Home" ? 0
      : e.key === "End" ? buttons.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    buttons[at].tabIndex = -1;
    buttons[next].tabIndex = 0;
    buttons[next].focus();
  }

  /**
   * Et tal, der kun regnes om, når teksten er ny. Tallene er et overblik, så et hurtigt mønster er nok:
   * en scanning med fraklip- og fodnoteparseren i hver skrivepause kostede for meget i lange tekster
   * (kodegennemgang 20/10).
   */
  private perDoc(count: (doc: string) => number): () => number {
    let seen: unknown = null;
    let n = 0;
    return () => {
      const doc = this.view.state.doc;
      if (doc !== seen) {
        seen = doc;
        n = count(doc.toString());
      }
      return n;
    };
  }

  /** Tallene på ikonerne, når browseren har ro: aldrig midt mellem to tastetryk. */
  private countsPending = false;
  private scheduleCounts(): void {
    if (this.countsPending) return;
    this.countsPending = true;
    const run = () => {
      this.countsPending = false;
      this.updateCounts();
    };
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 1500 });
    else window.setTimeout(run, 300);
  }

  private updateCounts(): void {
    for (const t of this.tabs) {
      const el = this.buttons.get(t.id);
      if (!el) continue;
      const waiting = t.alert?.() ?? 0;
      el.badge.hidden = waiting <= 0;
      el.button.setAttribute(
        "aria-label",
        waiting > 0 ? tr(`${t.label}, ${waiting} venter på dig`, `${t.label}, ${waiting} waiting for you`) : t.label,
      );
      if (t.id === this.active) {
        const n = t.count?.() ?? 0;
        this.titleCount.textContent = n > 0 ? ` · ${n}` : "";
      }
    }
  }

  render(): void {
    this.stale = false;
    const tab = this.tabs.find((t) => t.id === this.active) ?? this.tabs[0];
    this.title.replaceChildren(tab.label, this.titleCount);
    this.titleCount.textContent = "";
    this.hint.textContent = tab.hint ?? "";
    this.hint.hidden = !tab.hint;
    this.scheduleCounts();
    // Fanerne deler kroppen. Claude-fanen tegner også selv om, når et svar kommer, og skal vide, om det er dens tur.
    const restore = preserveFocus(this.body);
    this.body.dataset.tab = tab.id;
    // En fane må ikke efterlade sine klasser til den næste (Struktur gjorde de andre faner urullelige).
    this.body.className = "rp-body";
    // Kun fanen AI-hjælp med svar gør spalten bred (claudepanel.ts); de andre fanes er smalle.
    document.body.classList.remove("rp-wide");
    tab.render(this.body);
    restore();
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
    
    // To små ikoner i hjørnet, når musen er over kortet. Farver og Slet ligger i menuen (også ved
    // højreklik). Før stod fire farveprikker og to links i en række, der gav hvert kort et tomt bånd
    // og prikker, der var for små at ramme (UX 20/10).
    const tools = document.createElement("div");
    tools.className = "rp-card-tools";
    const back = iconButton(ICON.undo, tr("Tilbage i teksten", "Back into the text"), () => this.restore(p));
    const more = iconButton(ICON.more, tr("Flere valg", "More options"), () => {
      const r = more.getBoundingClientRect();
      this.cardMenu(p, r.left, r.bottom + 4);
    });
    tools.append(back, more);
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cardMenu(p, e.clientX, e.clientY);
    });
    card.append(text, tools);
    return card;
  }

  /** Kortets menu: tilbage i teksten, farve (skrivebordsnoternes, så de følger mørk og aften), slet. */
  private cardMenu(p: Parked, x: number, y: number): void {
    const COLORS: [string, string][] = [
      ["gul", tr("Gul", "Yellow")],
      ["groen", tr("Grøn", "Green")],
      ["blaa", tr("Blå", "Blue")],
      ["rosa", tr("Rosa", "Pink")],
    ];
    const setColor = (c: string | undefined) => {
      const fresh = findParked(this.view.state.doc.toString()).find((x) => x.id === p.id);
      if (!fresh) return;
      this.view.dispatch({
        changes: { from: fresh.from, to: fresh.to, insert: parkedBlock(fresh.id, fresh.date, fresh.text, c) },
        userEvent: "input.park",
      });
    };
    showMenu(x, y, [
      { label: tr("Tilbage i teksten", "Back into the text"), run: () => this.restore(p) },
      { separator: true },
      ...COLORS.map(([c, name]) => ({ label: name, checked: p.color === c, run: () => setColor(p.color === c ? undefined : c) })),
      ...(p.color ? [{ label: tr("Ingen farve", "No colour"), run: () => setColor(undefined) }] : []),
      { separator: true },
      { label: tr("Slet", "Delete"), run: () => this.removeParked(p.id) },
    ]);
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
    // Trækket bærer markeringen uden de skjulte blokke (cleanCopy). 14/10 gik en markering hen over
    // en Struktur-del: teksten blev sammenlignet med blokkene i, var ikke ens, og intet blev fjernet.
    else if (!sel.empty && visibleText(state, sel.from, sel.to).trim() === text.trim()) span = expandParkRange(state, sel);
    const plan = span && parkPlan(state, span);
    if (plan) text = plan.text;
    const remove = plan && !keepCopy ? plan.remove : undefined;
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
    const defs = footnoteDefinitions(doc);
    const areas: HTMLTextAreaElement[] = [];
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
      areas.push(area);
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
    const mine = this.myNotes(doc);
    if (!items.length && !mine.length) {
      const empty = document.createElement("p");
      empty.className = "rp-empty";
      empty.textContent = tr("Ingen fodnoter endnu. Tryk Ctrl+Alt+F, hvor noten skal stå.", "No footnotes yet. Press Ctrl+Alt+F where the note should go.");
      body.replaceChildren(empty);
      return;
    }
    body.replaceChildren(...items, ...mine);
    // Alle højder i ét billede: først nulstilles de, så læses de, så sættes de. Én tvungen layout i
    // stedet for én pr. fodnote.
    requestAnimationFrame(() => {
      for (const a of areas) a.style.height = "auto";
      const heights = areas.map((a) => a.scrollHeight);
      areas.forEach((a, i) => (a.style.height = `${heights[i] + 2}px`));
    });
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
    const end = findParked(doc)[0]?.from ?? doc.length;
    this.view.dispatch({ changes: footnoteEdit(doc, label, text, end), userEvent: "input.note" });
  }

  private jumpToRef(label: string): void {
    const doc = this.view.state.doc.toString();
    const ref = footnoteRef(doc, label);
    if (!ref) return;
    this.view.dispatch({ selection: { anchor: ref.to }, scrollIntoView: true });
    this.view.focus();
  }
}

