// Skrivetilstande: fokus dæmper alt uden for afsnittet med markøren, fast rulning
// holder linjen med markøren midt i vinduet som iA Writer, og danske anførselstegn sættes, mens man skriver.
// Fokus og fast rulning slås til og fra uden at bygge editoren om (Compartment).

import { Compartment, EditorState, type Extension, type Range, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { isolateHistory } from "@codemirror/commands";

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

// En tabelcelle har sin egen DOM-markør. CodeMirrors markør står stadig i brødteksten.
const editingTable = (view: EditorView): boolean => !!view.contentDOM.querySelector(".gt-tablebox :focus");

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
          if (editingTable(v)) return null;
          const head = v.state.selection.main.head;
          const c = v.coordsAtPos(head);
          if (!c) return { head, top: null };
          const box = v.scrollDOM.getBoundingClientRect();
          return { head, top: v.scrollDOM.scrollTop + (c.top + c.bottom) / 2 - (box.top + box.height / 2) };
        },
        write: (position, v) => {
          if (!position) return;
          const { head, top } = position;
          // Et langt spring (Ctrl+End, søgning, disposition) går CodeMirrors vej: den måler linjerne
          // undervejs og retter rulningen, hvilket ville afbryde en blød rulning midt i (målt 2/10).
          if (top === null || Math.abs(top - v.scrollDOM.scrollTop) > v.scrollDOM.clientHeight / 3) {
            window.setTimeout(() => {
              if (!editingTable(v)) v.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
            });
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

const OPEN = { guillemets: ["»", "›"], low: ["„", "‚"], curly: ["”", "’"] } as const;
const CLOSE = { guillemets: ["«", "‹"], low: ["“", "‘"], curly: ["”", "’"] } as const;

/** Er der et åbent anførselstegn af den slags i linjen, som endnu ikke er lukket? */
function openQuote(before: string, style: QuoteStyle, single: boolean): boolean {
  const i = single ? 1 : 0;
  const open = OPEN[style][i];
  const close = CLOSE[style][i];
  if (open === close) return [...before].filter((c) => c === open).length % 2 === 1;
  return before.split(open).length > before.split(close).length;
}

/**
 * Hvilket tegn et " eller ' skal være. `before` er linjens tekst før markøren. Efter mellemrum,
 * linjestart, en åbningsparentes eller `/` åbnes der. Markdowns tegn (`**`, `_`, `{++`, `[`) springes
 * over først, så `**"citat"**` åbner med » og ikke « (fejljagt F2-B6). Efter et tal er " tommer, når
 * intet citat er åbent (27″). Et indlejret ' lukkes med ‹, ellers er det en apostrof (F2-B7).
 */
export function smartQuote(before: string, style: QuoteStyle, single: boolean): string {
  const bare = before.replace(/(?:\{\+\+|\{--|\{~~|\{>>|\{==|[*_~>[])+$/, "");
  const last = bare.slice(-1);
  const opening = bare === "" || /[\s([{—–/-]/.test(last);
  if (single) {
    if (opening) return OPEN[style][1];
    // Et åbent ›…: dette lukker det. Ellers er ' en apostrof (»Niels' tekst«, »80'erne«).
    return style !== "curly" && openQuote(bare, style, true) ? CLOSE[style][1] : "’";
  }
  if (opening) return OPEN[style][0];
  if (/\d/.test(last) && !openQuote(bare, style, false)) return "″";
  return CLOSE[style][0];
}

/** Står markøren i en kodestump, der endnu ikke er lukket? Et ulige antal ` før den på linjen. */
export function inOpenCode(before: string): boolean {
  return ((before.match(/`/g) ?? []).length & 1) === 1;
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
  const line = view.state.doc.lineAt(from);
  const before = view.state.sliceDoc(line.from, from);
  if (inOpenCode(before)) return false;
  const insert = smartQuote(before, quoteStyle, text === "'");
  // Først det lige tegn, så ombytningen som sit eget trin: Ctrl+Z giver det lige tegn tilbage, som i
  // Word. Før forsvandt det skrevne med, og et lige " kunne kun sættes ind (fejljagt F2-B7).
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" });
  if (insert !== text) {
    view.dispatch({
      changes: { from, to: from + text.length, insert },
      selection: { anchor: from + insert.length },
      userEvent: "input.type.quote",
      annotations: isolateHistory.of("full"),
    });
  }
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
