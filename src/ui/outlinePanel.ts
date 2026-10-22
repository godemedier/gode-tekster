// Dispositionen i venstre spalte (2/10): fanen ved siden af Bibliotek. Overskrifterne står
// indrykket efter niveau, og sektionen med markøren er markeret som den åbne fil i biblioteket.
// Klik springer, træk en overskrift op eller ned for at flytte hele sektionen (relocatePlan).
// Ctrl+J åbner spalten her; piletasterne går mellem overskrifterne, Enter springer, Esc går tilbage.

import { EditorView } from "@codemirror/view";

import { bodyHeadings, relocatePlan, type Heading } from "../editor/outline.ts";
import { tr } from "../i18n.ts";

const SECTION_TYPE = "application/x-gt-sektion";

export type OutlineHooks = {
  /** Vises fanen lige nu? Ellers tegnes den først, når den vises. */
  visible(): boolean;
  /** Efter et spring eller Esc fra tastaturet: tilbage til teksten. */
  done(): void;
};

export class OutlinePanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private view: EditorView;
  private hooks: OutlineHooks;
  private items: Heading[] = [];
  private rows: HTMLButtonElement[] = [];
  private timer: number | undefined;
  private stale = true;

  constructor(view: EditorView, hooks: OutlineHooks) {
    this.view = view;
    this.hooks = hooks;
    this.el = document.createElement("div");
    this.el.className = "left-view outline";
    this.list = document.createElement("div");
    this.list.className = "lib-list";
    this.list.setAttribute("role", "list");
    this.list.addEventListener("keydown", (e) => this.key(e));
    this.el.append(this.list);
    // Rulles der med musen, følger markeringen med (højst én gang pr. billede).
    let frame = 0;
    view.scrollDOM.addEventListener(
      "scroll",
      () => {
        if (frame || this.stale || !this.hooks.visible()) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          this.highlight();
        });
      },
      { passive: true },
    );
  }

  /** Teksten er ændret: tegn om lidt forsinket, og kun hvis fanen ses. */
  docChanged(): void {
    this.stale = true;
    window.clearTimeout(this.timer);
    if (this.hooks.visible()) this.timer = window.setTimeout(() => this.render(), 200);
  }

  /** Markøren er flyttet: kun markeringen af den aktuelle sektion skifter. */
  selectionChanged(): void {
    if (this.hooks.visible() && !this.stale) this.highlight();
  }

  /** Fanen er lige blevet vist, eller en anden tekst er åbnet. */
  show(): void {
    if (this.stale) this.render();
    else this.highlight();
  }

  /** Ctrl+J: fokus på den sektion, markøren står i. */
  focusCurrent(): void {
    this.show();
    (this.rows[this.current()] ?? this.rows[0])?.focus();
  }

  /**
   * Sektionen, der skal markeres: markørens, når den kan ses, ellers den, brugeren kigger på (en
   * tredjedel nede i vinduet). Før fulgte den kun markøren og stod stille, når der blev rullet
   * med musen (2/10: »Disposition opdaterer sig ikke«).
   */
  private current(): number {
    const v = this.view;
    const box = v.scrollDOM.getBoundingClientRect();
    const head = v.state.selection.main.head;
    const caret = v.coordsAtPos(head);
    const onScreen = caret && caret.bottom > box.top && caret.top < box.bottom;
    const pos = onScreen ? head : (v.posAtCoords({ x: box.left + box.width / 2, y: box.top + box.height / 3 }, false) ?? head);
    let i = -1;
    for (let k = 0; k < this.items.length && this.items[k].from <= pos; k++) i = k;
    return i;
  }

  private highlight(): void {
    const c = this.current();
    this.rows.forEach((r, i) => r.classList.toggle("active", i === c));
    this.rows[c]?.scrollIntoView({ block: "nearest" });
  }

  private render(): void {
    this.stale = false;
    window.clearTimeout(this.timer);
    // Står fokus i listen (Ctrl+J), bliver det på samme plads, når listen tegnes om.
    const focused = this.rows.indexOf(document.activeElement as HTMLButtonElement);
    this.items = bodyHeadings(this.view.state.doc.toString());
    if (!this.items.length) {
      const empty = document.createElement("div");
      empty.className = "lib-empty";
      empty.textContent = tr(
        "Teksten har ingen overskrifter endnu. Skriv # og et mellemrum først på en linje for at lave en.",
        "The text has no headings yet. Type # and a space at the start of a line to make one.",
      );
      this.rows = [];
      this.list.replaceChildren(empty);
      return;
    }
    this.rows = this.items.map((h, i) => this.row(h, i));
    this.list.replaceChildren(...this.rows);
    this.highlight();
    if (focused >= 0) this.rows[Math.min(focused, this.rows.length - 1)]?.focus();
  }

  private row(h: Heading, i: number): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `lib-row outline-row outline-${Math.min(h.level, 3)}`;
    b.style.paddingLeft = `${16 + (h.level - 1) * 14}px`;
    b.textContent = h.text;
    b.title = tr("Klik for at gå hertil. Træk for at flytte sektionen", "Click to go here. Drag to move the section");
    b.draggable = true;
    b.addEventListener("click", (e) => this.jump(i, e.detail === 0));
    b.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(SECTION_TYPE, String(h.from));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      b.classList.add("dragging");
    });
    b.addEventListener("dragend", () => {
      b.classList.remove("dragging");
      this.clearDrop();
    });
    b.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(SECTION_TYPE)) return;
      e.preventDefault();
      this.clearDrop();
      b.classList.add(this.place(b, e) === "before" ? "drop-before" : "drop-after");
    });
    b.addEventListener("dragleave", () => b.classList.remove("drop-before", "drop-after"));
    b.addEventListener("drop", (e) => {
      const src = Number(e.dataTransfer?.getData(SECTION_TYPE));
      this.clearDrop();
      if (!e.dataTransfer?.types.includes(SECTION_TYPE) || Number.isNaN(src)) return;
      e.preventDefault();
      this.relocate(src, h.from, this.place(b, e));
    });
    return b;
  }

  /** Øverste halvdel af rækken: foran sektionen. Nederste: efter den. */
  private place(row: HTMLElement, e: DragEvent): "before" | "after" {
    const r = row.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  }

  private clearDrop(): void {
    for (const r of this.rows) r.classList.remove("drop-before", "drop-after");
  }

  private relocate(src: number, dest: number, place: "before" | "after"): void {
    const plan = relocatePlan(this.view.state.doc.toString(), src, dest, place);
    if (!plan) return;
    this.view.dispatch({
      changes: { from: plan.from, to: plan.to, insert: plan.insert },
      selection: { anchor: plan.cursor },
      effects: EditorView.scrollIntoView(plan.cursor, { y: "start", yMargin: 80 }),
      userEvent: "move.section",
    });
    this.render();
  }

  /** Gå til overskriften. Fra tastaturet (Enter) går fokus også tilbage til teksten. */
  private jump(i: number, keyboard: boolean): void {
    const h = this.items[i];
    if (!h) return;
    this.view.dispatch({
      selection: { anchor: h.from },
      effects: EditorView.scrollIntoView(h.from, { y: "start", yMargin: 80 }),
      userEvent: "select",
    });
    this.highlight();
    if (keyboard) this.hooks.done();
  }

  private key(e: KeyboardEvent): void {
    const i = this.rows.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(this.rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
      this.rows[next]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.hooks.done();
    }
  }
}
