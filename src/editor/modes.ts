// Skrivetilstande (plan 2-9 del D): fokus dæmper alt uden for afsnittet med markøren, fast rulning
// holder linjen med markøren midt i vinduet som iA Writer, og danske anførselstegn sættes, mens man skriver.
// Fokus og fast rulning slås til og fra uden at bygge editoren om (Compartment).

import { Compartment, EditorState, type Extension, type Range, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

// --- fokus -------------------------------------------------------------------------------------

/** Afsnittet med markøren: linjerne mellem to tomme linjer. */
export function paragraphAt(state: EditorState, pos: number): { from: number; to: number } {
  const doc = state.doc;
  let first = doc.lineAt(pos);
  let last = first;
  if (first.text.trim() === "") return { from: first.from, to: first.to };
  while (first.number > 1) {
    const prev = doc.line(first.number - 1);
    if (prev.text.trim() === "") break;
    first = prev;
  }
  while (last.number < doc.lines) {
    const next = doc.line(last.number + 1);
    if (next.text.trim() === "") break;
    last = next;
  }
  return { from: first.from, to: last.to };
}

const dimLine = Decoration.line({ class: "gt-unfocus" });

function focusDecorations(view: EditorView): DecorationSet {
  const { from, to } = paragraphAt(view.state, view.state.selection.main.head);
  const out: Range<Decoration>[] = [];
  for (const r of view.visibleRanges) {
    for (let pos = r.from; pos <= r.to; ) {
      const line = view.state.doc.lineAt(pos);
      if (line.to < from || line.from > to) out.push(dimLine.range(line.from));
      pos = line.to + 1;
    }
  }
  return Decoration.set(out);
}

const focusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = focusDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = focusDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const focusTheme = EditorView.theme({
  ".gt-unfocus": { opacity: "0.28", transition: "opacity 200ms ease" },
});

// --- fast rulning ------------------------------------------------------------------------------

// Som iA Writers typewriter-rulning: linjen med markøren står fast midt i vinduet, og teksten
// glider op under den. Der er en halv skærm luft over første og under sidste linje, så også
// dokumentets begyndelse og slutning står i midten. Klik og træk med musen flytter ikke teksten,
// det gør først næste tastetryk (Ulysses' »variable«). Hjulet ruller frit.

const MOUSE_EVENTS = ["select.pointer", "input.drop", "move.drop"];

/** Skal transaktionen sætte linjen i midten? Kun når der er skrevet eller flyttet med tastaturet. */
export function movesCaret(tr: Transaction): boolean {
  if (!tr.docChanged && !tr.selection) return false;
  return !MOUSE_EVENTS.some((e) => tr.isUserEvent(e));
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const typewriterPlugin = ViewPlugin.fromClass(
  class {
    view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      this.pad();
      this.center(false);
    }
    update(u: ViewUpdate) {
      if (u.geometryChanged) this.pad();
      if (u.transactions.some(movesCaret)) this.center(true);
    }
    /** Luften over og under: en halv skærm minus en halv linje, så linjen står præcis i midten. */
    pad() {
      this.view.requestMeasure({
        key: "gt-typewriter-pad",
        read: (v) => `${Math.max(0, Math.round(v.scrollDOM.clientHeight / 2 - v.defaultLineHeight / 2))}px`,
        write: (px, v) => {
          if (v.contentDOM.style.paddingTop === px) return;
          v.contentDOM.style.paddingTop = px;
          v.contentDOM.style.paddingBottom = px;
        },
      });
    }
    center(smooth: boolean) {
      this.view.requestMeasure({
        key: "gt-typewriter",
        read: (v) => {
          const head = v.state.selection.main.head;
          const c = v.coordsAtPos(head);
          if (!c) return { head, top: null };
          const box = v.scrollDOM.getBoundingClientRect();
          return { head, top: v.scrollDOM.scrollTop + (c.top + c.bottom) / 2 - (box.top + box.height / 2) };
        },
        write: ({ head, top }, v) => {
          // Et langt spring (Ctrl+End, søgning, disposition) går CodeMirrors vej: den måler linjerne
          // undervejs og retter rulningen, hvilket ville afbryde en blød rulning midt i (målt 2/10).
          if (top === null || Math.abs(top - v.scrollDOM.scrollTop) > v.scrollDOM.clientHeight / 3) {
            window.setTimeout(() => v.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) }));
            return;
          }
          if (Math.abs(top - v.scrollDOM.scrollTop) < 1) return;
          v.scrollDOM.scrollTo({ top, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
        },
      });
    }
    destroy() {
      this.view.contentDOM.style.paddingTop = "";
      this.view.contentDOM.style.paddingBottom = "";
    }
  },
);

// --- danske anførselstegn ----------------------------------------------------------------------

/** »…«, ”…” eller „…“ (det traditionelle danske: 99 nede og 66 oppe, 6/10). */
export type QuoteStyle = "guillemets" | "curly" | "low";

/** Hvilket tegn et " skal være. Efter mellemrum, linjestart eller en åbningsparentes åbnes der. */
export function smartQuote(before: string, style: QuoteStyle, single: boolean): string {
  const opening = before === "" || /[\s([{—–-]/.test(before);
  if (single) {
    // ' midt i et ord er en apostrof (»Niels' tekst«, »dét's«).
    if (!opening) return "’";
    return style === "guillemets" ? "›" : style === "low" ? "‚" : "’";
  }
  if (style === "guillemets") return opening ? "»" : "«";
  if (style === "low") return opening ? "„" : "“";
  return "”";
}

const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "CodeText", "CodeMark", "URL", "HTMLBlock", "Comment"]);

function insideCode(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

let quoteStyle: QuoteStyle = "guillemets";
export function setQuoteStyle(style: QuoteStyle): void {
  quoteStyle = style;
}

const smartQuotes = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '"' && text !== "'") return false;
  if (view.composing || insideCode(view.state, from)) return false;
  const before = from > 0 ? view.state.sliceDoc(from - 1, from) : "";
  const insert = smartQuote(before, quoteStyle, text === "'");
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: "input.type",
  });
  return true;
});

// --- slå til og fra ----------------------------------------------------------------------------

const focusSlot = new Compartment();
const typewriterSlot = new Compartment();

export function modeExtensions(): Extension[] {
  return [focusSlot.of([]), typewriterSlot.of([]), smartQuotes];
}

export function setModes(view: EditorView, modes: { focus: boolean; typewriter: boolean }): void {
  view.dispatch({
    effects: [
      focusSlot.reconfigure(modes.focus ? [focusPlugin, focusTheme] : []),
      typewriterSlot.reconfigure(modes.typewriter ? typewriterPlugin : []),
    ],
  });
}
