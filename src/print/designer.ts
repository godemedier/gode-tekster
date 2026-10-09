// Side-designeren i forhåndsvisningen (9/10): brikker (forfatter, dato, titel, sidetal, tal, egen
// tekst) trækkes til faste pladser i sidehoved og sidefod, margener og skrift sættes, og opsætningen
// kan gemmes som skabelon. Logikken bor i layout.ts. Her er kun fladen: træk med pointer events, og
// det samme med tastaturet (Enter løfter, piletasterne vælger plads, Enter sætter, Esc fortryder).
// Pladsen under brikken lyser op i stiplet vermilion, slippemarkeringen fra ADR-0037.

import type { Meta, PrintOptions } from "./render.ts";
import {
  MARGIN_LIMITS,
  nextTarget,
  parseCm,
  pieceOn,
  place,
  placed,
  remove,
  slotsFor,
  withFirstDifferent,
  type From,
  type Margins,
  type PageFont,
  type PageLayout,
  type PageView,
  type Piece,
  type PieceKind,
  type SavedTemplate,
  type Slot,
  type Target,
} from "./layout.ts";
import { tr } from "../i18n.ts";

export type DesignerHost = {
  layout: () => PageLayout;
  /** Gem den nye opsætning og tegn forhåndsvisningen igen (som kalder `mount`). */
  setLayout: (l: PageLayout) => void;
  options: () => PrintOptions;
  templates: () => SavedTemplate[];
  /** Navnet på den valgte gemte skabelon, hvis der er en. */
  selected: () => string | undefined;
  saveAs: (name: string) => void;
  deleteSelected: () => void;
  reset: () => void;
};

const pieceLabel = (k: PieceKind): string =>
  ({
    author: tr("Forfatter", "Author"),
    date: tr("Dato", "Date"),
    title: tr("Titel", "Title"),
    pageNumber: tr("Sidetal", "Page number"),
    counts: tr("Antal tegn og ord", "Characters and words"),
    text: tr("Egen tekst", "Own text"),
  })[k];

const targetLabel = (t: Target): string =>
  ({
    "top-left": tr("Øverst til venstre", "Top left"),
    "top-center": tr("Øverst i midten", "Top centre"),
    "top-right": tr("Øverst til højre", "Top right"),
    title: tr("Titlen", "The title"),
    "bottom-left": tr("Nederst til venstre", "Bottom left"),
    "bottom-center": tr("Nederst i midten", "Bottom centre"),
    "bottom-right": tr("Nederst til højre", "Bottom right"),
  })[t];

const LIST: PieceKind[] = ["author", "date", "title", "pageNumber", "counts"];
const ROWS: [Slot, Slot, Slot][] = [
  ["top-left", "top-center", "top-right"],
  ["bottom-left", "bottom-center", "bottom-right"],
];

type Carry = { piece: Piece; from?: From; target: Target; key: string };

export class Designer {
  private host: DesignerHost;
  private view: PageView = "first";
  private carry: Carry | null = null;
  /** Pladsen under markøren, mens en brik trækkes med musen. */
  private over: Target | null = null;
  private dragging: Piece | null = null;
  private suppressClick = false;
  private naming = false;
  private customText = "";
  private pendingFocus: string | null = null;
  private paper: HTMLElement | null = null;
  private live: HTMLElement | null = null;
  private meta: Meta | null = null;

  constructor(host: DesignerHost) {
    this.host = host;
    // Et klik et andet sted end på en plads eller brikken lægger den løftede brik tilbage.
    window.addEventListener("pointerdown", (e) => {
      if (!this.carry) return;
      const el = e.target as HTMLElement;
      if (el.closest("[data-slot]") || el.closest(`[data-key="${this.carry.key}"]`)) return;
      this.cancel();
    });
  }

  /** Siden, der redigeres: første side eller de andre, når første side er anderledes. */
  private get page(): PageView {
    return this.host.layout().firstDifferent ? this.view : "pages";
  }

  /** Tegn pladserne på papiret og panelet ved siden af. Kaldes efter hver tegning af forhåndsvisningen. */
  mount(paper: HTMLElement, side: HTMLElement, meta: Meta): void {
    const active = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const focusKey = this.pendingFocus ?? (side.contains(document.activeElement) || paper.contains(document.activeElement) ? active : undefined);
    this.pendingFocus = null;
    this.carry = null;
    this.paper = paper;
    this.meta = meta;
    const l = this.host.layout();
    const rest = l.firstDifferent && this.view === "pages";
    paper.classList.add("pv-design-paper");
    paper.classList.toggle("pv-view-rest", rest);
    this.drawSlots(paper, l, meta, rest);
    this.drawSide(side, l);
    if (focusKey) (side.querySelector<HTMLElement>(`[data-key="${focusKey}"]`) ?? paper.querySelector<HTMLElement>(`[data-key="${focusKey}"]`))?.focus();
  }

  unmount(paper: HTMLElement, side: HTMLElement): void {
    this.carry = null;
    paper.classList.remove("pv-design-paper", "pv-view-rest");
    paper.querySelectorAll(".pv-design-only").forEach((el) => el.remove());
    side.replaceChildren();
  }

  // --- papiret ------------------------------------------------------------------------------

  private drawSlots(paper: HTMLElement, l: PageLayout, meta: Meta, rest: boolean): void {
    paper.querySelectorAll(".pv-design-only").forEach((el) => el.remove());
    const map = slotsFor(l, !rest);
    const m = l.margins;
    ROWS.forEach((slots, i) => {
      const row = document.createElement("div");
      row.className = "pv-slots pv-design-only";
      row.style.left = `${m.left}cm`;
      row.style.right = `${m.right}cm`;
      if (i === 0) {
        row.style.top = "0";
        row.style.height = `${m.top}cm`;
      } else {
        row.style.bottom = "0";
        row.style.height = `${m.bottom}cm`;
      }
      for (const slot of slots) {
        const el = document.createElement("div");
        el.className = `pv-slot pv-slot-${slot.split("-")[1]}`;
        el.dataset.slot = slot;
        el.setAttribute("aria-label", targetLabel(slot));
        const pieces = map[slot] ?? [];
        el.classList.toggle("is-empty", pieces.length === 0);
        pieces.forEach((p, index) => el.append(this.pieceButton(p, { view: this.page, target: slot, index }, meta, rest)));
        el.addEventListener("click", () => this.carry && this.drop(slot));
        row.append(el);
      }
      paper.append(row);
    });
    // Titlen er tekstens egen overskrift. Den kan slås fra ved at trække Titel-brikken ud.
    if (!meta.startsWithTitle || rest) return;
    const article = paper.querySelector(".pv-article");
    const head = paper.querySelector<HTMLElement>(".pv-head");
    if (head) {
      head.dataset.slot = "title";
      head.classList.add("pv-slot-title");
      head.addEventListener("click", () => this.carry && this.drop("title"));
      const b = this.pieceButton({ kind: "title" }, { view: this.page, target: "title", index: 0 }, meta, rest);
      b.classList.add("pv-design-only", "pv-title-chip");
      head.prepend(b);
    } else if (article) {
      const empty = document.createElement("div");
      empty.className = "pv-slot pv-slot-title is-empty pv-design-only";
      empty.dataset.slot = "title";
      empty.setAttribute("aria-label", targetLabel("title"));
      empty.addEventListener("click", () => this.carry && this.drop("title"));
      article.prepend(empty);
    }
  }

  private pieceButton(p: Piece, from: From, meta: Meta, rest: boolean): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pv-piece";
    b.dataset.key = `p:${from.target}:${from.index}`;
    const value = valueFor(p, meta, rest);
    b.textContent = from.target === "title" ? pieceLabel("title") : value || pieceLabel(p.kind);
    const off = !pieceOn(p, this.host.options());
    b.classList.toggle("is-off", off);
    b.setAttribute(
      "aria-label",
      `${pieceLabel(p.kind)}${value && from.target !== "title" ? `: ${value}` : ""}, ${targetLabel(from.target).toLowerCase()}${off ? `. ${tr("Slået fra under Indhold", "Turned off under Content")}` : ""}`,
    );
    b.title = off ? tr("Slået fra under Indhold", "Turned off under Content") : tr("Træk for at flytte. Træk ud for at fjerne.", "Drag to move. Drag out to remove.");
    this.draggable(b, () => p, from);
    b.addEventListener("keydown", (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && !this.carry) {
        e.preventDefault();
        this.removeAt(from, p);
      }
    });
    return b;
  }

  // --- træk og slip ---------------------------------------------------------------------------

  /** Mus, pen og finger trækker. Enter og mellemrum løfter og sætter, piletasterne vælger plads. */
  private draggable(el: HTMLElement, piece: () => Piece | null, from?: From): void {
    el.addEventListener("pointerdown", (e) => this.startDrag(e, el, piece, from));
    el.addEventListener("click", (e) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      // Tastaturet klarer sig selv i keydown. Et klik med musen løfter eller sætter, som Enter.
      if (e.detail === 0) return;
      // Bærer man en anden brik, er et klik på en brik på siden et klik på dens plads.
      if (this.carry && this.carry.key !== el.dataset.key && el.closest("[data-slot]")) return;
      this.toggleCarry(el, piece, from);
    });
    el.addEventListener("keydown", (e) => {
      const key = el.dataset.key ?? "";
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.toggleCarry(el, piece, from);
        return;
      }
      if (!this.carry || this.carry.key !== key) return;
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const next = nextTarget(this.carry.target, e.key, this.carry.piece.kind === "title" && this.titleAvailable());
        if (next !== this.carry.target) {
          this.carry.target = next;
          this.paint();
          this.say(targetLabel(next));
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
        this.say(tr("Brikken blev, hvor den var.", "The piece stayed where it was."));
      }
    });
  }

  private toggleCarry(el: HTMLElement, piece: () => Piece | null, from?: From): void {
    const key = el.dataset.key ?? "";
    if (this.carry && this.carry.key === key) return this.drop(this.carry.target);
    const p = piece();
    if (!p) return;
    this.carry = { piece: p, from, target: this.firstTarget(p, from), key };
    this.paint();
    this.say(
      `${pieceLabel(p.kind)}: ${tr("Vælg en plads med piletasterne og tryk Enter. Esc fortryder.", "Choose a place with the arrow keys and press Enter. Esc cancels.")} ${targetLabel(this.carry.target)}.`,
    );
  }

  private firstTarget(p: Piece, from?: From): Target {
    if (from) return from.target;
    const l = this.host.layout();
    if (p.kind === "title" && this.titleAvailable() && !l.title) return "title";
    const map = l[this.page];
    return ROWS.flat().find((s) => !(map[s] ?? []).length) ?? "top-center";
  }

  private startDrag(e: PointerEvent, el: HTMLElement, piece: () => Piece | null, from?: From): void {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let ghost: HTMLElement | null = null;
    let p: Piece | null = null;
    const move = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        p = piece();
        if (!p) return stop();
        this.carry = null;
        this.dragging = p;
        ghost = document.createElement("div");
        ghost.className = "pv-ghost";
        ghost.textContent = pieceLabel(p.kind);
        document.body.append(ghost);
        document.body.classList.add("pv-dragging");
      }
      ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 12}px)`;
      // Nær kanten ruller forhåndsvisningen med, så sidefoden kan nås i et lavt vindue.
      const edge = ev.clientY > window.innerHeight - 48 ? 16 : ev.clientY < 72 ? -16 : 0;
      if (edge) this.paper?.closest("#print-root")?.scrollBy(0, edge);
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-slot]");
      const t = hit && this.paper?.contains(hit) ? (hit.dataset.slot as Target) : null;
      this.over = t && p && this.accepts(t, p) ? t : null;
      this.paint();
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    const up = () => {
      stop();
      if (!ghost || !p) return;
      ghost.remove();
      document.body.classList.remove("pv-dragging");
      this.suppressClick = true;
      window.setTimeout(() => (this.suppressClick = false), 0);
      const over = this.over;
      this.over = null;
      this.dragging = null;
      if (over) {
        this.carry = { piece: p, from, target: over, key: el.dataset.key ?? "" };
        this.drop(over);
      } else if (from) this.removeAt(from, p);
      else this.paint();
    };
    const cancel = () => {
      stop();
      ghost?.remove();
      document.body.classList.remove("pv-dragging");
      this.over = null;
      this.dragging = null;
      this.paint();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  private titleAvailable(): boolean {
    return !!this.meta?.startsWithTitle && !(this.host.layout().firstDifferent && this.view === "pages");
  }

  private accepts(t: Target, p: Piece): boolean {
    return t === "title" ? p.kind === "title" && this.titleAvailable() : true;
  }

  /** Lys pladserne op: alle, der kan tage brikken, og stiplet vermilion om den valgte. */
  private paint(): void {
    const piece = this.carry?.piece ?? this.dragging;
    const target = this.carry?.target ?? this.over;
    this.paper?.querySelectorAll<HTMLElement>("[data-slot]").forEach((el) => {
      const t = el.dataset.slot as Target;
      el.classList.toggle("pv-droppable", !!piece && this.accepts(t, piece));
      el.classList.toggle("pv-target", !!piece && t === target);
    });
    document.querySelectorAll<HTMLElement>(".pv-side [data-key], .pv-paper [data-key]").forEach((el) => {
      el.classList.toggle("is-lifted", !!this.carry && el.dataset.key === this.carry.key);
    });
  }

  private cancel(): void {
    this.carry = null;
    this.paint();
  }

  private drop(target: Target): void {
    const c = this.carry;
    this.carry = null;
    if (!c || !this.accepts(target, c.piece)) return this.paint();
    const before = this.host.layout();
    const l = place(before, this.page, c.piece, target, c.from);
    if (l === before) return this.paint();
    // Fokus følger brikken: en brik fra listen bliver i listen, en flyttet brik følger med.
    this.pendingFocus = c.from ? (target === "title" ? "p:title:0" : `p:${target}:${(l[this.page][target]?.length ?? 1) - 1}`) : c.key;
    this.say(`${pieceLabel(c.piece.kind)}: ${targetLabel(target).toLowerCase()}.`);
    this.host.setLayout(l);
  }

  private removeAt(from: From, p: Piece): void {
    this.pendingFocus = `chip:${p.kind}`;
    this.say(tr(`${pieceLabel(p.kind)} er fjernet.`, `${pieceLabel(p.kind)} removed.`));
    this.host.setLayout(remove(this.host.layout(), from));
  }

  private say(text: string): void {
    if (this.live) this.live.textContent = text;
  }

  // --- panelet ------------------------------------------------------------------------------

  private drawSide(side: HTMLElement, l: PageLayout): void {
    const said = this.live?.textContent ?? "";
    const parts: HTMLElement[] = [];

    if (l.firstDifferent) {
      const seg = segmented(
        tr("Hvilken side", "Which page"),
        [
          ["first", tr("Første side", "First page")],
          ["pages", tr("De andre sider", "Other pages")],
        ],
        this.view,
        (v) => {
          this.view = v as PageView;
          this.pendingFocus = `view:${v}`;
          this.host.setLayout(this.host.layout());
        },
        "view",
      );
      parts.push(seg);
    }

    // Brikkerne.
    const pieces = section(tr("Brikker", "Pieces"));
    const hint = document.createElement("p");
    hint.className = "pv-hint";
    hint.textContent = tr(
      "Træk en brik til en plads på siden. Træk den ud igen for at fjerne den. Med tastaturet løfter Enter brikken, og piletasterne vælger pladsen.",
      "Drag a piece to a place on the page. Drag it out again to remove it. With the keyboard, Enter lifts the piece and the arrow keys choose the place.",
    );
    const list = document.createElement("div");
    list.className = "pv-chips";
    // Uden overskrift i teksten kan Titel stadig stå i sidehovedet (så er det filnavnet).
    for (const kind of LIST) {
      const b = chip(pieceLabel(kind), `chip:${kind}`, placed(l, this.page, kind));
      this.draggable(b, () => ({ kind }));
      list.append(b);
    }
    // Egen tekst: brikken bærer det, der står i feltet.
    const own = document.createElement("div");
    own.className = "pv-own";
    const ownChip = chip(`${pieceLabel("text")} …`, "chip:text", false);
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 80;
    input.value = this.customText;
    input.dataset.key = "own-text";
    input.placeholder = tr("Skriv teksten her", "Type the text here");
    input.setAttribute("aria-label", pieceLabel("text"));
    input.addEventListener("input", () => (this.customText = input.value));
    this.draggable(ownChip, () => {
      const text = this.customText.trim();
      if (text) return { kind: "text", text };
      this.say(tr("Skriv teksten i feltet først.", "Type the text in the field first."));
      input.focus();
      return null;
    });
    own.append(ownChip, input);
    list.append(own);
    this.live = document.createElement("p");
    this.live.className = "pv-live";
    this.live.setAttribute("aria-live", "polite");
    this.live.textContent = said;
    pieces.append(hint, list, this.live);
    parts.push(pieces);

    // Margener.
    const margins = section(tr("Margener", "Margins"));
    const grid = document.createElement("div");
    grid.className = "pv-margins";
    const names: [keyof Margins, string][] = [
      ["top", tr("Top", "Top")],
      ["bottom", tr("Bund", "Bottom")],
      ["left", tr("Venstre", "Left")],
      ["right", tr("Højre", "Right")],
    ];
    for (const [k, name] of names) {
      const label = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = name;
      const field = document.createElement("span");
      field.className = "pv-cm";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.inputMode = "decimal";
      inp.dataset.key = `m:${k}`;
      inp.value = cm(l.margins[k]);
      const [min, max] = MARGIN_LIMITS[k];
      inp.addEventListener("change", () => {
        const n = parseCm(inp.value, min, max);
        if (n === null) {
          inp.setAttribute("aria-invalid", "true");
          this.say(tr(`Skriv et tal mellem ${cm(min)} og ${cm(max)} cm.`, `Enter a number between ${min} and ${max} cm.`));
          return;
        }
        const now = this.host.layout();
        this.host.setLayout({ ...now, margins: { ...now.margins, [k]: n } });
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") inp.dispatchEvent(new Event("change"));
      });
      const unit = document.createElement("span");
      unit.textContent = "cm";
      unit.setAttribute("aria-hidden", "true");
      field.append(inp, unit);
      label.append(span, field);
      grid.append(label);
    }
    margins.append(grid);
    parts.push(margins);

    // Skrift.
    const font = section(tr("Skrift", "Typeface"));
    font.append(
      segmented(
        tr("Skrift", "Typeface"),
        [
          ["skaerm", tr("Som på skærmen", "As on screen")],
          ["newsreader", "Newsreader"],
          ["grotesk", "Grotesk"],
        ],
        l.font,
        (v) => {
          this.pendingFocus = `font:${v}`;
          this.host.setLayout({ ...this.host.layout(), font: v as PageFont });
        },
        "font",
      ),
    );
    parts.push(font);

    // Første side anderledes.
    const sw = document.createElement("label");
    sw.className = "pv-switch";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = l.firstDifferent;
    box.dataset.key = "first";
    box.addEventListener("change", () => {
      this.view = "first";
      this.pendingFocus = "first";
      this.host.setLayout(withFirstDifferent(this.host.layout(), box.checked));
    });
    const text = document.createElement("span");
    const strong = document.createElement("span");
    strong.textContent = tr("Første side anderledes", "Different first page");
    const small = document.createElement("small");
    small.textContent = tr("For eksempel antal tegn nederst i stedet for sidetal", "For example character count at the bottom instead of a page number");
    text.append(strong, small);
    sw.append(box, text);
    parts.push(sw);

    parts.push(this.templateActions());
    side.replaceChildren(...parts);
  }

  private templateActions(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "pv-actions";
    const selected = this.host.selected();
    if (this.naming) {
      const label = document.createElement("label");
      label.className = "pv-name";
      const span = document.createElement("span");
      span.textContent = tr("Navn på skabelonen", "Template name");
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 40;
      input.dataset.key = "name";
      input.value = selected ?? "";
      label.append(span, input);
      const save = () => {
        const name = input.value.trim();
        if (!name) return input.focus();
        this.naming = false;
        this.pendingFocus = "save";
        this.host.saveAs(name);
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") {
          e.stopPropagation();
          this.naming = false;
          this.pendingFocus = "save";
          this.host.setLayout(this.host.layout());
        }
      });
      const ok = Object.assign(actionButton(tr("Gem", "Save"), "name-ok", save), { className: "pv-primary" });
      const no = actionButton(tr("Annullér", "Cancel"), "name-no", () => {
        this.naming = false;
        this.pendingFocus = "save";
        this.host.setLayout(this.host.layout());
      });
      const buttons = document.createElement("div");
      buttons.className = "pv-row";
      buttons.append(ok, no);
      wrap.append(label, buttons);
      window.setTimeout(() => input.focus(), 0);
      return wrap;
    }
    const row = document.createElement("div");
    row.className = "pv-row";
    row.append(
      actionButton(tr("Gem som skabelon …", "Save as template …"), "save", () => {
        this.naming = true;
        this.host.setLayout(this.host.layout());
      }),
      actionButton(tr("Nulstil", "Reset"), "reset", () => {
        this.pendingFocus = "reset";
        this.host.reset();
      }),
    );
    wrap.append(row);
    if (selected) {
      const del = actionButton(tr(`Slet »${selected}«`, `Delete “${selected}”`), "delete", () => {
        this.pendingFocus = "save";
        this.host.deleteSelected();
      });
      del.classList.add("pv-quiet");
      wrap.append(del);
    }
    return wrap;
  }
}

/** Det, en brik viser på papiret. Sidetallet er 1 på første side og 2 på de andre. */
function valueFor(p: Piece, meta: Meta, rest: boolean): string {
  switch (p.kind) {
    case "author":
      return meta.author;
    case "date":
      return meta.date;
    case "title":
      return meta.title;
    case "pageNumber":
      return rest ? "2" : "1";
    case "counts":
      return meta.countLine;
    case "text":
      return p.text ?? "";
  }
}

function cm(n: number): string {
  return String(n).replace(".", ",");
}

function section(title: string): HTMLElement {
  const s = document.createElement("section");
  s.className = "pv-section";
  const h = document.createElement("h2");
  h.textContent = title;
  s.append(h);
  return s;
}

function chip(label: string, key: string, isPlaced: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pv-chip";
  b.dataset.key = key;
  b.textContent = label;
  if (isPlaced) b.classList.add("is-placed");
  b.setAttribute("aria-description", isPlaced ? tr("Står på siden", "On the page") : tr("Ikke på siden", "Not on the page"));
  return b;
}

function actionButton(label: string, key: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.dataset.key = key;
  b.addEventListener("click", run);
  return b;
}

function segmented(label: string, choices: [string, string][], value: string, pick: (v: string) => void, key: string): HTMLElement {
  const seg = document.createElement("div");
  seg.className = "pv-seg";
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", label);
  for (const [v, text] of choices) {
    const b = actionButton(text, `${key}:${v}`, () => pick(v));
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(v === value));
    seg.append(b);
  }
  return seg;
}
