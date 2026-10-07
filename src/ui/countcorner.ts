// Ordtallet nederst til højre (ADR-0015): usynligt, til musen er i hjørnet, eller altid, hvis
// brugeren har valgt det. Holdes musen over, vises anslag, normalsider og læsetid. Er der en
// markering, tælles kun den.

import type { EditorView } from "@codemirror/view";

import type { Text } from "@codemirror/state";
import { count, formatCount, type Count } from "../editor/count.ts";
import { currentLix } from "../editor/styleCheck.ts";
import { tr } from "../i18n.ts";

export class CountCorner {
  private el: HTMLElement;
  private view: EditorView;
  private timer: number | undefined;

  /** Teksten er ændret, mens tallet var skjult. Det tælles, når musen kommer til hjørnet. */
  private stale = true;

  constructor(el: HTMLElement, view: EditorView) {
    this.el = el;
    this.view = view;
    el.addEventListener("mouseenter", () => {
      if (this.stale) this.update();
    });
  }

  private get visible(): boolean {
    return this.el.classList.contains("always") || this.el.matches(":hover");
  }

  setAlways(on: boolean): void {
    this.el.classList.toggle("always", on);
    if (on && this.stale) this.update();
  }

  /** Kaldes ved ændringer i teksten eller markeringen. Tælles lidt forsinket. */
  schedule(): void {
    this.stale = true;
    window.clearTimeout(this.timer);
    // En lang tekst tælles ikke for ingenting: kun når tallet faktisk vises.
    if (this.visible) this.timer = window.setTimeout(() => this.update(), 250);
  }

  private whole: { doc: Text; count: Count } | null = null;

  update(): void {
    this.stale = false;
    const state = this.view.state;
    const sel = state.selection.main;
    const selected = !sel.empty;
    // Hele teksten tælles kun forfra, når den er ændret, ikke ved hver markørflytning (perf-review 2/10).
    let c: Count;
    if (selected) c = count(state.sliceDoc(sel.from, sel.to));
    else {
      if (this.whole?.doc !== state.doc) this.whole = { doc: state.doc, count: count(state.doc.toString()) };
      c = this.whole.count;
    }
    const f = formatCount(c);
    const short = document.createElement("span");
    short.className = "count-short";
    short.textContent = selected ? tr(`${f.short} markeret`, `${f.short} selected`) : f.short;
    const long = document.createElement("span");
    long.className = "count-long";
    const lix = currentLix();
    long.textContent = [...f.long.slice(1), ...(lix ? [`LIX ${Math.round(lix.lix)} (${lix.label})`] : [])].join(" · ");
    this.el.replaceChildren(long, short);
  }
}
