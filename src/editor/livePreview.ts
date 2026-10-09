// Live preview (ADR-0002, plan 1 trin 4): markdown-tegnene skjules og vises igen, hvor markøren står.
//
// Regler, der holder teksten i ro (research: Obsidians hovedklage er, at linjer hopper):
// - Overskrifter og citater får deres linjeklasse ALTID, også når tegnene vises. Højden ændrer sig
//   derfor ikke, når markøren går ind i dem. Kun en lille vandret forskydning, når `# ` dukker op.
// - Tegn skjules med `Decoration.replace`, aldrig med CSS, så markøren ikke træder usynligt gennem dem.
// - Mens musen er nede, bygges intet om (ellers flytter teksten sig under et klik). Under IME-
//   komposition flyttes dekorationerne kun med, de bygges ikke om.
// - Ingen dekoration skriver i dokumentet, undtagen afkrydsningsfeltet i en opgave, som brugeren klikker.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { findDimmed, findFootnoteRefs, footnoteNumbers } from "./inline.ts";
import { TextMemo } from "./touches.ts";
import { tr } from "../i18n.ts";

/** Dæmpet tekst i hele teksten. Flyttes med ved skrivning, findes forfra kun ved `{--` og `--}`. */
const dimmed = new TextMemo(
  ["{--", "--}"],
  (doc) => findDimmed(doc),
  (found, ch) =>
    found.map((d) => {
      const m = (f: { from: number; to: number }) => ({ from: ch.mapPos(f.from, 1), to: ch.mapPos(f.to, -1) });
      return { open: m(d.open), body: { from: ch.mapPos(d.body.from, 1), to: ch.mapPos(d.body.to, 1) }, close: m(d.close) };
    }),
  (found) => found.map((d) => ({ from: d.open.from, to: d.close.to })),
);

/** Fodnotenumrene afhænger kun af rækkefølgen af `[^…]`, ikke af positioner. */
const footnoteMemo = new TextMemo(
  ["[^"],
  (doc) => footnoteNumbers(doc),
  (n) => n,
  () => [],
);

const hide = Decoration.replace({});
const line = (cls: string) => Decoration.line({ class: cls });

/** Punkttegnet i lister (Indstillinger, Punkttegn; 5/10). */
let bulletChar = "–";
const relist = StateEffect.define<null>();
export function setBullet(view: EditorView, ch: string): void {
  if (ch === bulletChar) return;
  bulletChar = ch;
  view.dispatch({ effects: relist.of(null) });
}
const mark = (cls: string) => Decoration.mark({ class: cls });

class TextWidget extends WidgetType {
  private text: string;
  private cls: string;
  constructor(text: string, cls: string) {
    super();
    this.text = text;
    this.cls = cls;
  }
  eq(other: TextWidget): boolean {
    return other.text === this.text && other.cls === this.cls;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  private checked: boolean;
  private at: number;
  constructor(checked: boolean, at: number) {
    super();
    this.checked = checked;
    this.at = at;
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.at === this.at;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "gt-task";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? tr("Opgave klaret", "Task done") : tr("Opgave", "Task"));
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", () => {
      view.dispatch({
        changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? " " : "x" },
        userEvent: "input.toggle",
      });
    });
    return box;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Visning af markdown (Indstillinger, 7/10). »skjul«: tegnene kommer aldrig frem, fed er bare fed
 * som i Word (6/10). »markoer«: tegnene vises, hvor markøren står (standard). »alle«: tegnene står
 * der altid, men teksten er stadig formateret. »raa«: kun ren markdown, ingen live preview og
 * ingen tabeller som tabeller. Filen er den samme i alle fire.
 */
export type MarkMode = "skjul" | "markoer" | "alle" | "raa";
let mode: MarkMode = "markoer";
export const currentMarkMode = (): MarkMode => mode;
/** Sendes, når visningen skifter, så tabeller og live preview tegnes om. */
export const markModeChanged = StateEffect.define<null>();
export function setMarkMode(view: EditorView, next: MarkMode): void {
  view.dom.classList.toggle("gt-raw", next === "raa");
  if (next === mode) return;
  mode = next;
  view.dispatch({ effects: [relist.of(null), markModeChanged.of(null)] });
}

/** Rører en markering/markøren intervallet? Kanten tæller med, så tegnene kommer frem ved kanten. */
function touched(state: EditorState, from: number, to: number): boolean {
  if (mode === "skjul") return false;
  if (mode === "alle") return true;
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/** Står markøren på en af linjerne i intervallet? */
function onLines(state: EditorState, from: number, to: number): boolean {
  if (mode === "skjul") return false;
  if (mode === "alle") return true;
  const a = state.doc.lineAt(from).number;
  const b = state.doc.lineAt(to).number;
  return state.selection.ranges.some((r) => {
    const l1 = state.doc.lineAt(r.from).number;
    const l2 = state.doc.lineAt(r.to).number;
    return l1 <= b && l2 >= a;
  });
}

function inCode(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "InlineCode" || n.name === "FencedCode" || n.name === "CodeBlock") return true;
  }
  return false;
}

/** Skjul et mærke og mellemrummet lige efter det (`# `, `> `). */
function hideWithSpace(state: EditorState, from: number, to: number, out: Range<Decoration>[]): void {
  const next = state.doc.sliceString(to, to + 1);
  out.push(hide.range(from, next === " " ? to + 1 : to));
}

function build(view: EditorView): DecorationSet {
  if (mode === "raa") return Decoration.none;
  const { state } = view;
  const out: Range<Decoration>[] = [];
  const numbers = footnoteMemo.get(state.doc);

  // Dæmpet tekst kan gå over flere afsnit (»Skær meget« foreslår hele afsnit), så den findes i hele
  // teksten og markeres, hvor den er synlig (personatjek 2/10: før kun inden for én linje).
  for (const d of dimmed.get(state.doc)) {
    const visible = view.visibleRanges.some((r) => d.close.to >= r.from && d.open.from <= r.to);
    if (!visible || inCode(state, d.open.from)) continue;
    if (d.body.to > d.body.from) out.push(mark("gt-dim").range(d.body.from, d.body.to));
    if (!touched(state, d.open.from, d.close.to)) {
      out.push(hide.range(d.open.from, d.open.to));
      out.push(hide.range(d.close.from, d.close.to));
    }
  }

  for (const { from, to } of view.visibleRanges) {
    const openU: number[] = [];
    syntaxTree(state).iterate({
      from,
      to,
      enter: (n) => {
        const name = n.name;

        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          out.push(line(`gt-h${heading[1]}`).range(state.doc.lineAt(n.from).from));
          const markNode = n.node.firstChild;
          if (markNode?.name === "HeaderMark") {
            if (!onLines(state, n.from, n.to)) {
              hideWithSpace(state, markNode.from, markNode.to, out);
            } else {
              const next = state.doc.sliceString(markNode.to, markNode.to + 1);
              const to = next === " " ? markNode.to + 1 : markNode.to;
              out.push(mark("gt-hmark").range(markNode.from, to));
            }
          }
          return;
        }

        if (name === "Blockquote") {
          const first = state.doc.lineAt(n.from).number;
          const last = state.doc.lineAt(n.to).number;
          const active = onLines(state, n.from, n.to);
          for (let i = first; i <= last; i++) {
            const l = state.doc.line(i);
            const prefix = /^\s*>\s?/.exec(l.text)?.[0].length ?? 0;
            const body = l.text.slice(prefix);
            const cls = ["gt-quote"];
            if (i === first) cls.push("gt-quote-first");
            if (i === last) cls.push("gt-quote-last");
            const isCite = /^[–-]\s/.test(body);
            if (isCite) cls.push("gt-quote-cite");
            out.push(line(cls.join(" ")).range(l.from));
            // Navnelinjen (»– Stefan«) vises uden tankestreg, som i citat A (ADR-0015).
            if (isCite && !active) out.push(hide.range(l.from + prefix, l.from + prefix + 2));
          }
          if (!active) {
            n.node.cursor().iterate((c) => {
              if (c.name === "QuoteMark") hideWithSpace(state, c.from, c.to, out);
            });
          }
          return;
        }

        if (name === "Emphasis" || name === "StrongEmphasis" || name === "Strikethrough" || name === "InlineCode") {
          if (touched(state, n.from, n.to)) return;
          const markName = name === "Strikethrough" ? "StrikethroughMark" : name === "InlineCode" ? "CodeMark" : "EmphasisMark";
          for (let c = n.node.firstChild; c; c = c.nextSibling) {
            if (c.name === markName) out.push(hide.range(c.from, c.to));
          }
          if (name === "InlineCode") out.push(mark("gt-code").range(n.from, n.to));
          return;
        }

        if (name === "Link") {
          const marks: SyntaxNode[] = [];
          for (let c = n.node.firstChild; c; c = c.nextSibling) if (c.name === "LinkMark") marks.push(c);
          // Kun [tekst](url). Referencelinks og fodnoter håndteres andre steder.
          if (marks.length >= 3 && !touched(state, n.from, n.to)) {
            out.push(hide.range(marks[0].from, marks[0].to));
            out.push(mark("gt-link").range(marks[0].to, marks[1].from));
            out.push(hide.range(marks[1].from, n.to));
          }
          return false;
        }

        // Fortsættelseslinjer i et punkt (Shift+Enter, eller et nyt afsnit i punktet) flugter med
        // punktets tekst (6/10). Markdowns indrykning skjules op til tekstens kolonne, så
        // linjen ikke står med mellemrum foran og falder tilbage til margenen, når den brydes.
        if (name === "ListItem") {
          const markNode = n.node.getChild("ListMark");
          const first = state.doc.lineAt(n.from);
          if (!markNode) return;
          const indent = markNode.from - first.from;
          const lead = indent + (markNode.to - markNode.from) + 1;
          for (let c = n.node.firstChild; c; c = c.nextSibling) {
            if (c.name !== "Paragraph") continue;
            for (let i = state.doc.lineAt(c.from).number; i <= state.doc.lineAt(c.to).number; i++) {
              const l = state.doc.line(i);
              if (l.number === first.number) continue;
              const ws = /^[ \t]*/.exec(l.text)?.[0].length ?? 0;
              out.push(line("gt-li-cont").range(l.from));
              const a = l.from + Math.min(ws, indent);
              const b = l.from + Math.min(ws, lead);
              if (b > a) out.push(hide.range(a, b));
            }
          }
          return;
        }

        if (name === "ListMark") {
          const text = state.doc.sliceString(n.from, n.to);
          // En opgave (»- [ ] …«) viser kun afkrydsningsfeltet, ikke også en prik foran.
          const isTask = n.node.nextSibling?.name === "Task";
          if (isTask && !onLines(state, n.from, n.to)) {
            hideWithSpace(state, n.from, n.to, out);
            return;
          }
          // Listepunkter rykkes let ind med hængende indrykning (5/10).
          out.push(line("gt-li").range(state.doc.lineAt(n.from).from));
          if (/^[-*+]$/.test(text)) {
            // Markdownens »-« står i samme faste bredde som punkttegnet, så teksten ikke rykker,
            // når markøren går ind på linjen (6/10: listen hoppede).
            if (onLines(state, n.from, n.to)) out.push(mark("gt-bullet gt-bullet-raw").range(n.from, n.to));
            else out.push(Decoration.replace({ widget: new TextWidget(bulletChar, "gt-bullet") }).range(n.from, n.to));
          }
          return;
        }

        if (name === "TaskMarker") {
          if (!touched(state, n.from, n.to)) {
            const checked = /x/i.test(state.doc.sliceString(n.from, n.to));
            out.push(Decoration.replace({ widget: new CheckboxWidget(checked, n.from) }).range(n.from, n.to));
          }
          return;
        }

        if (name === "HorizontalRule") {
          out.push(line("gt-hr").range(state.doc.lineAt(n.from).from));
          if (!onLines(state, n.from, n.to)) {
            out.push(Decoration.replace({ widget: new TextWidget("· · ·", "gt-hr-mark") }).range(n.from, n.to));
          }
          return;
        }

        if (name === "HTMLTag") {
          const tag = state.doc.sliceString(n.from, n.to).toLowerCase();
          if (tag === "<u>") openU.push(n.from);
          if (tag === "</u>" && openU.length > 0) {
            const start = openU.pop() as number;
            if (!touched(state, start, n.to)) {
              out.push(hide.range(start, start + 3));
              out.push(mark("gt-u").range(start + 3, n.from));
              out.push(hide.range(n.from, n.to));
            }
          }
          return;
        }

        if (name === "FencedCode" || name === "CodeBlock") {
          const a = state.doc.lineAt(n.from).number;
          const b = state.doc.lineAt(n.to).number;
          for (let i = a; i <= b; i++) out.push(line("gt-codeblock").range(state.doc.line(i).from));
          return false;
        }

        if (name === "CommentBlock") {
          const a = state.doc.lineAt(n.from).number;
          const b = state.doc.lineAt(n.to).number;
          for (let i = a; i <= b; i++) out.push(line("gt-comment").range(state.doc.line(i).from));
          return false;
        }

        if (name === "Table") {
          const a = state.doc.lineAt(n.from).number;
          const b = state.doc.lineAt(n.to).number;
          for (let i = a; i <= b; i++) out.push(line("gt-table").range(state.doc.line(i).from));
          return;
        }
        if (name === "TableDelimiter") {
          out.push(mark("gt-pipe").range(n.from, n.to));
          return;
        }
        return;
      },
    });

    // Det, parseren ikke kender: dæmpet tekst, fodnotehenvisninger og -definitioner.
    for (let pos = from; pos <= to; ) {
      const l = state.doc.lineAt(pos);
      for (const f of findFootnoteRefs(l.text)) {
        const a = l.from + f.ref.from;
        const b = l.from + f.ref.to;
        if (inCode(state, a) || touched(state, a, b)) continue;
        const n = numbers.get(f.label) ?? 0;
        out.push(Decoration.replace({ widget: new TextWidget(String(n), "gt-fnref") }).range(a, b));
      }
      pos = l.to + 1;
    }
  }
  return Decoration.set(out, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private frozen = false;
    private view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
      this.decorations = build(view);
    }

    update(u: ViewUpdate): void {
      dimmed.advance(u);
      footnoteMemo.advance(u);
      if (u.view.composing) {
        this.decorations = this.decorations.map(u.changes);
        return;
      }
      if (this.frozen && !u.docChanged) {
        return;
      }
      const treeChanged = syntaxTree(u.state) !== syntaxTree(u.startState) || u.transactions.some((t) => t.effects.some((e) => e.is(relist)));
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || treeChanged) {
        this.decorations = build(u.view);
      }
    }

    /** Ventende optøning. Et nyt klik aflyser den, så markeringen ikke flytter sig midt i et dobbeltklik. */
    thawTimer = 0;

    freeze(): void {
      window.clearTimeout(this.thawTimer);
      this.frozen = true;
    }

    // 400 ms er CodeMirrors vindue for dobbelt- og trippelklik. Før var det 100 ms og uden aflysning, så
    // »##« dukkede op mellem to klik, teksten rykkede tre tegn, og andet klik ramte et andet ord
    // (4/10, genskabt med scenariet dobbeltklik: sigtet på »er«, markeret »Jeg«).
    thaw(): void {
      window.clearTimeout(this.thawTimer);
      this.thawTimer = window.setTimeout(() => {
        this.frozen = false;
        this.decorations = build(this.view);
        this.view.dispatch({});
      }, 400);
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(this: { freeze(): void; thaw(): void }) {
        this.freeze();
        const up = () => {
          window.removeEventListener("mouseup", up, true);
          this.thaw();
        };
        window.addEventListener("mouseup", up, true);
      },
    },
  },
);

export const livePreviewTheme = EditorView.theme({
  ".gt-h1, .gt-h2, .gt-h3, .gt-h4, .gt-h5, .gt-h6": { position: "relative" },
  ".gt-hmark": { 
    position: "absolute", 
    right: "100%", 
    color: "var(--dæmpet)",
    fontWeight: "normal",
    whiteSpace: "pre"
  },
  ".gt-h1": { fontSize: "1.75em", lineHeight: "1.3", fontWeight: "700", paddingTop: "0.5em" },
  ".gt-h2": { fontSize: "1.35em", lineHeight: "1.35", fontWeight: "700", paddingTop: "0.9em" },
  ".gt-h3": { fontSize: "1.12em", fontWeight: "700", paddingTop: "0.8em" },
  ".gt-h4": { fontSize: "1.12em", lineHeight: "1.65", color: "var(--manchet)" },
  ".gt-h5, .gt-h6": { fontWeight: "700" },
  // Citat, variant A (2/10, »det mest rolige«): klassisk mørk streg til venstre, citatet i
  // kursiv, navnet under i almindelig skrift. Stregen er en kant på hver linje, så den er
  // sammenhængende. Kun padding, aldrig margin: CodeMirror måler linjehøjder uden margin, og
  // forkerte højder får teksten til at hoppe.
  ".gt-quote": { borderLeft: "3px solid var(--blæk)", paddingLeft: "26px", fontSize: "1.18em", lineHeight: "1.6", fontStyle: "italic", color: "var(--blæk)" },
  ".gt-quote-first": { paddingTop: "0.15em" },
  ".gt-quote-last": { paddingBottom: "0.15em" },
  ".gt-quote-cite": { fontSize: "0.85em", fontStyle: "normal", color: "var(--svag)", paddingTop: "0.35em" },
  ".gt-link": { textDecoration: "underline", textDecorationColor: "var(--pynt)", textUnderlineOffset: "4px" },
  ".gt-u": { textDecoration: "underline", textUnderlineOffset: "4px" },
  ".gt-code": { backgroundColor: "var(--kode-flade)", borderRadius: "4px", padding: "0 3px" },
  ".gt-codeblock": { backgroundColor: "var(--kode-flade)", fontSize: "0.9em" },
  ".gt-bullet": { color: "var(--svag)", display: "inline-block", width: "0.8em", textIndent: "0" },
  ".cm-line.gt-li": { paddingLeft: "1.6em", textIndent: "-1.05em" },
  ".cm-line.gt-li-cont": { paddingLeft: "1.6em", textIndent: "0" },
  ".gt-task": { margin: "0 0.4em 0 0", accentColor: "var(--blæk)", verticalAlign: "-1px" },
  ".gt-hr": { textAlign: "center" },
  ".gt-hr-mark": { color: "var(--pynt)", letterSpacing: "0.6em" },
  ".gt-dim": { color: "var(--dæmpet)" },
  ".gt-fnref": { fontSize: "0.7em", verticalAlign: "super", color: "var(--link)", padding: "0 1px" },
  ".gt-comment": { fontSize: "0.85em", color: "var(--dæmpet)" },
  ".gt-table": { fontSize: "0.92em" },
  ".gt-pipe": { color: "var(--pynt)" },
});
