// Ctrl+klik på et link (delbar udgave 3/10): en webadresse åbner i browseren, et link til en anden
// tekst åbner den i Gode Tekster. Velkomsthilsenen henviser til vejledningen på den måde, og testere
// forventer det fra Word og iA. Et almindeligt klik flytter bare markøren, så man kan rette i linket.

import { EditorView, ViewPlugin } from "@codemirror/view";

/** Linket under positionen `at` i linjen: målet i `[tekst](mål)` eller en løs webadresse. */
export function linkAt(line: string, at: number): string | null {
  for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const start = m.index ?? 0;
    if (at >= start && at <= start + m[0].length) return m[1];
  }
  for (const m of line.matchAll(/<?(https?:\/\/[^\s<>]+)>?/g)) {
    const start = m.index ?? 0;
    // Et punktum eller en parentes efter adressen hører til sætningen.
    const url = m[1].replace(/[.,;:!?)»"']+$/, "");
    if (at >= start && at <= start + url.length + 1) return url;
  }
  return null;
}

/**
 * Hånden ved Ctrl over et link (5/10): så man kan se, at et klik åbner det. Reagerer både,
 * når Ctrl trykkes med musen stille, og når musen flyttes med Ctrl nede.
 */
const linkCursor = ViewPlugin.fromClass(
  class {
    x = 0;
    y = 0;
    view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
    }
    set(ctrl: boolean): void {
      let over = false;
      if (ctrl) {
        const pos = this.view.posAtCoords({ x: this.x, y: this.y });
        if (pos != null) {
          const line = this.view.state.doc.lineAt(pos);
          over = linkAt(line.text, pos - line.from) !== null;
        }
      }
      this.view.contentDOM.classList.toggle("gt-link-hand", over);
    }
  },
  {
    eventHandlers: {
      mousemove(e) {
        this.x = e.clientX;
        this.y = e.clientY;
        this.set(e.ctrlKey || e.metaKey);
      },
      mouseleave() {
        this.set(false);
      },
      keydown(e) {
        if (e.key === "Control" || e.key === "Meta") this.set(true);
      },
      keyup(e) {
        if (e.key === "Control" || e.key === "Meta") this.set(false);
      },
      blur() {
        this.set(false);
      },
    },
  },
);

/** Ctrl+klik sender linket videre som `gt-open-link`; main.ts afgør, hvor det åbnes. */
const linkHandlers = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    const target = linkAt(line.text, pos - line.from);
    if (!target) return false;
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("gt-open-link", { detail: target }));
    return true;
  },
});

export function linkClicks() {
  return [linkCursor, linkHandlers];
}
