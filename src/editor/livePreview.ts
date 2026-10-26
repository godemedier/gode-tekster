// Live preview (ADR-0002): markdown-tegnene skjules og vises igen, hvor markøren står.
//
// Regler, der holder teksten i ro (research: Obsidians hovedklage er, at linjer hopper):
// - Overskrifter og citater får deres linjeklasse ALTID, også når tegnene vises. Højden ændrer sig
//   derfor ikke, når markøren går ind i dem. Kun en lille vandret forskydning, når `# ` dukker op.
// - Tegn skjules med `Decoration.replace`, aldrig med CSS. I »skjul« er de også atomiske (hiddenMarkAtoms),
//   ellers træder markøren stadig usynligt gennem dem.
// - Mens musen er nede, bygges intet om (ellers flytter teksten sig under et klik). Under IME-
//   komposition flyttes dekorationerne kun med, de bygges ikke om.
// - Ingen dekoration skriver i dokumentet, undtagen afkrydsningsfeltet i en opgave, som brugeren klikker.

import { syntaxTree } from "@codemirror/language";
import { EditorState, type Range, EditorSelection, Facet, Prec, RangeSet, StateEffect, Transaction, findClusterBreak } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { findDimmed, findFootnoteRefs, footnoteNumbers } from "./inline.ts";
import { noBreakMarks } from "./noBreak.ts";
import { keepMarks } from "./keepMarks.ts";
import { TextMemo } from "./touches.ts";
import { findCitations, findReferences, formatter, type Formatter, type ReferenceBlock } from "./references.ts";
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

/** Kildelisten sidst i filen (ADR-0049). Findes forfra, når en ændring rører blokken. */
const referenceMemo = new TextMemo<ReferenceBlock | null>(
  ["gt:kilder"],
  (doc) => findReferences(doc),
  (b, ch) => b && { ...b, from: ch.mapPos(b.from, 1), to: ch.mapPos(b.to, -1) },
  (b) => (b ? [{ from: b.from, to: b.to }] : []),
);
const formatters = new WeakMap<ReferenceBlock, Formatter>();
function citeFormatter(block: ReferenceBlock): Formatter {
  let f = formatters.get(block);
  if (!f) formatters.set(block, (f = formatter(block.refs, document.documentElement.lang === "en" ? "en" : "da")));
  return f;
}

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

export function build(view: EditorView): DecorationSet {
  if (mode === "raa") return Decoration.none;
  const { state } = view;
  const out: Range<Decoration>[] = [];
  const numbers = footnoteMemo.get(state.doc);
  const sources = referenceMemo.get(state.doc);

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

        // Sideskift (26/10): `+++` på en linje for sig, som i iA Writer. Print og Word skifter side
        // (print/render.ts). Her en stiplet streg med ordet, til markøren kommer ind på linjen.
        // Linje for linje, for print tæller også en `+++` lige op ad en tekstlinje.
        if (name === "Paragraph" && n.node.parent?.name === "Document" && state.doc.sliceString(n.from, n.to).includes("+++")) {
          for (let i = state.doc.lineAt(n.from).number; i <= state.doc.lineAt(n.to).number; i++) {
            const l = state.doc.line(i);
            if (l.text.trim() !== "+++") continue;
            out.push(line("gt-pagebreak").range(l.from));
            if (!onLines(state, l.from, l.to)) out.push(Decoration.replace({ widget: new TextWidget(tr("Sideskift", "Page break"), "gt-pagebreak-mark") }).range(l.from, l.to));
          }
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

        // »4\. maj«: escapen holder datoen ude af en liste (notLists.ts) og vises ikke.
        if (name === "Escape") {
          if (!touched(state, n.from, n.to)) out.push(hide.range(n.from, n.from + 1));
          return;
        }

        if (name === "Link") {
          const marks: SyntaxNode[] = [];
          for (let c = n.node.firstChild; c; c = c.nextSibling) if (c.name === "LinkMark") marks.push(c);
          // Kun [tekst](url). Referencelinks og fodnoter håndteres andre steder. I »skjul« står et link
          // råt, mens adressen er tom, eller markøren står i den: ellers skrev Ctrl+K adressen uden
          // for linket (fejljagt F1-B6).
          const writingUrl = mode === "skjul" && marks.length >= 3 && (marks.length < 4 || marks[3].from === marks[2].to || state.selection.ranges.some((r) => r.from >= marks[2].to && r.to <= marks[3].from));
          if (marks.length >= 3 && !writingUrl && !touched(state, n.from, n.to)) {
            out.push(hide.range(marks[0].from, marks[0].to));
            // Et tomt led (»[]()« fra Ctrl+K) får intet mærke: tomme mærker får CodeMirror til at slå hele
            // live preview fra resten af sessionen (fejljagt 19/10).
            if (marks[1].from > marks[0].to) out.push(mark("gt-link").range(marks[0].to, marks[1].from));
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
              if (n.from > start + 3) out.push(mark("gt-u").range(start + 3, n.from));
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
      // Henvisninger til kilder: »(Hansen, 2024, s. 42)«, og rå tekst, når markøren står i dem.
      for (const c of findCitations(l.text, l.from)) {
        if (inCode(state, c.from)) continue;
        const text = sources ? citeFormatter(sources).cite(c) : null;
        if (text === null) out.push(Decoration.mark({ class: "gt-cite-unknown", attributes: { title: tr("Ukendt kilde. Tilføj den i fanen Kilder.", "Unknown source. Add it in the Sources tab.") } }).range(c.from, c.to));
        else if (!touched(state, c.from, c.to)) out.push(Decoration.replace({ widget: new TextWidget(text, "gt-cite") }).range(c.from, c.to));
        else out.push(mark("gt-cite-raw").range(c.from, c.to));
      }
      pos = l.to + 1;
    }
  }
  out.push(...noBreakMarks(state.doc, out));
  return Decoration.set(out, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private frozen = false;
    private composed = false;
    private view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
      this.decorations = build(view);
    }

    update(u: ViewUpdate): void {
      dimmed.advance(u);
      footnoteMemo.advance(u);
      referenceMemo.advance(u);
      if (u.view.composing) {
        this.decorations = this.decorations.map(u.changes);
        this.composed = true;
        return;
      }
      // Når kompositionen slutter, kalder CodeMirror update uden ændringer. Uden ombygning stod
      // `*fed*` med stjerner, til markøren flyttede sig (fejljagt F2-B9, vigtigst med Gboard).
      if (this.composed) {
        this.composed = false;
        this.decorations = build(u.view);
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

    afterComposition(): void {
      window.setTimeout(() => {
        if (this.view.composing || !this.composed) return;
        this.composed = false;
        this.decorations = build(this.view);
        this.view.dispatch({});
      });
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
      // CodeMirror melder ikke altid, når en komposition slutter. Byg om lige efter (fejljagt F2-B9).
      compositionend(this: { afterComposition(): void }) {
        this.afterComposition();
      },
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

/** De skjulte tegn som intervaller, kun i visningen »skjul«. Linjeklasser og formatering tæller ikke. */
/**
 * Andre udvidelsers skjulte tekst, der også skal være atomisk i »skjul«: rettelsernes gamle tekst,
 * når de vises roligt (revisionsView.ts). Ellers trådte markøren usynligt gennem den.
 */
export const extraHidden = Facet.define<(view: EditorView) => DecorationSet>();

function hiddenAtoms(view: EditorView): DecorationSet {
  if (mode !== "skjul") return Decoration.none;
  const decos = view.plugin(livePreview)?.decorations ?? Decoration.none;
  const own = decos.update({ filter: (from, to, value) => value.point && to > from });
  const extra = view.state.facet(extraHidden);
  return extra.length ? RangeSet.join([own, ...extra.map((f) => f(view))]) : own;
}

/**
 * Første synlige position før (eller efter) `pos`: forbi de skjulte tegn, der støder op til den. En
 * widget (fodnotens tal, punkttegn, afkrydsningsfelt) er synlig og bliver slettet som ét tegn af
 * CodeMirror selv. Før sprang Backspace over fodnoten og slettede bogstavet foran (fejljagt 19/10).
 */
function pastHidden(atoms: DecorationSet, pos: number, forward: boolean): number {
  for (let moved = true; moved; ) {
    moved = false;
    atoms.between(pos, pos, (from, to, value) => {
      if (value.spec.widget) return;
      if (forward ? from === pos && to > pos : to === pos && from < pos) {
        pos = forward ? to : from;
        moved = true;
        return false;
      }
    });
  }
  return pos;
}

/** Backspace og Delete sletter det synlige tegn ved siden af de skjulte, ikke tegnene selv. */
function deleteVisible(forward: boolean) {
  return (view: EditorView): boolean => {
    const sel = view.state.selection.main;
    if (!sel.empty || view.state.selection.ranges.length > 1) return false;
    const atoms = hiddenAtoms(view);
    const { doc } = view.state;
    // Backspace ved tekstens start efter et usynligt linjepræfiks (`## `, `- [ ] `, `> `): præfikset
    // fjernes, og linjen bliver almindelig tekst, som i Word. Før sprang den over præfikset og slettede
    // linjeskiftet, så `##` stod som tekst i afsnittet over (fejljagt F1-B1).
    if (mode === "skjul" && !forward) {
      const l = doc.lineAt(sel.head);
      const p = linePrefix(view.state, l);
      if (p > 0 && sel.head === l.from + p) {
        view.dispatch({ changes: { from: l.from, to: l.from + p }, selection: { anchor: l.from }, userEvent: "delete.backward", scrollIntoView: true });
        return true;
      }
    }
    const at = pastHidden(atoms, sel.head, forward);
    if (at === sel.head) return deleteLastVisible(view, atoms, forward);
    if (forward ? at >= doc.length : at <= 0) return true;
    const l = doc.lineAt(at);
    const edge = forward ? at === l.to : at === l.from;
    const other = edge ? at + (forward ? 1 : -1) : l.from + findClusterBreak(l.text, at - l.from, forward);
    const { from, to } = swallowEmptied(view.state, atoms, { from: Math.min(at, other), to: Math.max(at, other) });
    view.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: forward ? "delete.forward" : "delete.backward", scrollIntoView: true });
    return true;
  };
}

/**
 * Slettes det sidste synlige tegn i fed, kursiv, et link osv., går de skjulte tegn med (fejljagt
 * F1-B14). Før stod `****` tilbage som tekst, fordi parret ikke længere var fed. Ellers gør
 * CodeMirror det selv.
 */
function deleteLastVisible(view: EditorView, atoms: DecorationSet, forward: boolean): boolean {
  if (mode !== "skjul") return false;
  const { state } = view;
  const head = state.selection.main.head;
  const l = state.doc.lineAt(head);
  if (forward ? head === l.to : head === l.from) return false;
  const other = l.from + findClusterBreak(l.text, head - l.from, forward);
  const r = { from: Math.min(head, other), to: Math.max(head, other) };
  const s = swallowEmptied(state, atoms, r);
  if (s.from === r.from && s.to === r.to) return false;
  view.dispatch({ changes: s, selection: { anchor: s.from }, userEvent: forward ? "delete.forward" : "delete.backward", scrollIntoView: true });
  return true;
}

/**
 * Længden af en linjes usynlige præfiks: citat, overskrift, punkttegn og afkrydsningsfelt med
 * mellemrum. Ikke tal (»4. maj«): de står synligt i »skjul«, og markøren skal kunne stå i dem. 0 i kode.
 */
export function linePrefix(state: EditorState, l: { from: number; text: string }): number {
  const m = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?)?/.exec(l.text);
  const n = m ? m[0].length : 0;
  return n > 0 && !inCode(state, l.from) ? n : 0;
}

/**
 * I »skjul« står markøren aldrig inde i et linjepræfiks, man ikke kan se: Home, pil ned og et klik
 * i mellemrummet foran teksten landede mellem `- ` og `[ ]`, og det, man skrev, ødelagde punktet
 * (fejljagt F1-B1). Markøren flyttes til tekstens start. Pil venstre derfra går til linjen over.
 */
const outOfPrefix = EditorState.transactionFilter.of((tr) => {
  if (mode !== "skjul" || !tr.selection || tr.isUserEvent("input.type.compose")) return tr;
  const { state } = tr;
  const sel = tr.selection;
  let moved = false;
  const ranges = sel.ranges.map((r) => {
    if (!r.empty) return r;
    const l = state.doc.lineAt(r.head);
    const p = linePrefix(state, l);
    if (p === 0 || r.head >= l.from + p) return r;
    const before = tr.startState.selection.main;
    const leaving = before.empty && before.head === tr.changes.mapPos(l.from + p) && tr.isUserEvent("select") && l.from > 0 && r.head < before.head;
    moved = true;
    return EditorSelection.cursor(leaving ? l.from - 1 : l.from + p);
  });
  return moved ? [tr, { selection: EditorSelection.create(ranges, sel.mainIndex), sequential: true }] : tr;
});

/**
 * Venstre og højre (med Shift) i »skjul«: ét tryk, ét synligt tegn. Før stod markøren to gange samme
 * sted ved `**`, én gang på hver side af de skjulte tegn, og en markering med Shift blev et tegn for
 * kort for hver formatering, den gik hen over (gæstens side, målt 21/10).
 */
function moveVisible(forward: boolean, extend: boolean) {
  return (view: EditorView): boolean => {
    if (mode !== "skjul" || view.state.selection.ranges.length > 1) return false;
    const sel = view.state.selection.main;
    // En markering lægges sammen i den side, man trykker mod, som CodeMirror selv gør.
    if (!extend && !sel.empty) return false;
    const atoms = hiddenAtoms(view);
    let pos = pastHidden(atoms, sel.head, forward);
    const { doc } = view.state;
    if (forward ? pos >= doc.length : pos <= 0) return false;
    pos = widgetEdge(atoms, pos, forward) ?? view.moveByChar(EditorSelection.cursor(pos), forward).head;
    // Landede skridtet inde i noget skjult, skubbes det ud til kanten i samme retning.
    atoms.between(pos, pos, (from, to) => {
      if (from < pos && pos < to) {
        pos = forward ? to : from;
        return false;
      }
    });
    pos = pastHidden(atoms, pos, forward);
    view.dispatch({ selection: extend ? EditorSelection.range(sel.anchor, pos) : EditorSelection.cursor(pos), scrollIntoView: true, userEvent: "select" });
    return true;
  };
}

/** Den anden ende af en widget, der begynder (eller slutter) ved `pos`. */
function widgetEdge(atoms: DecorationSet, pos: number, forward: boolean): number | null {
  let edge: number | null = null;
  atoms.between(pos, pos, (from, to, value) => {
    if (value.spec.widget && (forward ? from === pos && to > pos : to === pos && from < pos)) {
      edge = forward ? to : from;
      return false;
    }
  });
  return edge;
}

const INLINE_NODES = new Set(["Emphasis", "StrongEmphasis", "Strikethrough", "Link", "InlineCode"]);

/**
 * Bliver al synlig tekst i fed, kursiv, et link osv. slettet, går dets skjulte tegn med. Ellers står
 * der usynligt `****` eller `[](https://…)` tilbage (fejljagt 19/10).
 */
function swallowEmptied(state: EditorState, atoms: DecorationSet, r: { from: number; to: number }): { from: number; to: number } {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(r.from, 1); n; n = n.parent) {
    if (!INLINE_NODES.has(n.name) || n.from > r.from || n.to < r.to) continue;
    if (pastHidden(atoms, r.from, false) <= n.from && pastHidden(atoms, r.to, true) >= n.to) r = { from: n.from, to: n.to };
  }
  return r;
}

/**
 * Ctrl+Backspace og Ctrl+Delete i »skjul«: ordet ved markøren, som CodeMirrors `deleteGroupBackward`,
 * men de skjulte tegn tæller ikke og bliver stående. Før slettede tasten en hel linkadresse, man
 * ikke kunne se (fejljagt 19/10). Giver de synlige stykker, der skal slettes.
 */
export function visibleGroup(state: EditorState, atoms: DecorationSet, head: number, forward: boolean): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const categorize = state.charCategorizer(head);
  const first = pastHidden(atoms, head, forward);
  let pos = first;
  let start = pos;
  const flush = () => {
    if (pos !== start) out.push({ from: Math.min(pos, start), to: Math.max(pos, start) });
  };
  for (let cat: ReturnType<typeof categorize> | null = null; ; ) {
    // En widget er ét tegn for sig: står den lige ved markøren, slettes den alene, ellers stopper ordet.
    const widget = widgetEdge(atoms, pos, forward);
    if (widget !== null) {
      if (pos === first) pos = widget;
      break;
    }
    const line = state.doc.lineAt(pos);
    if (pos === (forward ? line.to : line.from)) {
      // Står markøren ved linjens kant, slettes linjeskiftet, som uden »skjul«.
      if (pos === first && line.number !== (forward ? state.doc.lines : 1)) pos += forward ? 1 : -1;
      break;
    }
    const next = findClusterBreak(line.text, pos - line.from, forward) + line.from;
    const ch = line.text.slice(Math.min(pos, next) - line.from, Math.max(pos, next) - line.from);
    const nextCat = categorize(ch);
    if (cat !== null && nextCat !== cat) break;
    if (ch !== " " || pos !== first) cat = nextCat;
    pos = next;
    const past = pastHidden(atoms, pos, forward);
    if (past !== pos) {
      flush();
      pos = start = past;
    }
  }
  flush();
  return out.map((r) => swallowEmptied(state, atoms, r));
}

function deleteVisibleGroup(forward: boolean) {
  return (view: EditorView): boolean => {
    const sel = view.state.selection.main;
    if (mode !== "skjul" || !sel.empty || view.state.selection.ranges.length > 1) return false;
    const ranges = visibleGroup(view.state, hiddenAtoms(view), sel.head, forward);
    if (ranges.length === 0) return true;
    const changes = view.state.changes(ranges);
    view.dispatch({ changes, selection: { anchor: changes.mapPos(sel.head, -1) }, userEvent: forward ? "delete.forward" : "delete.backward", scrollIntoView: true });
    return true;
  };
}

/**
 * I visningen »skjul« (telefonen, ADR-0055) kan markøren ikke stå inde i tegn, man ikke kan se.
 * Før gik den usynligt gennem `**`, og Backspace efter et fedt ord slettede en stjerne, så
 * formateringen gik i stykker (målt 17/10). Gælder også tryk: CodeMirror skubber en markering,
 * der lander inde i et skjult tegn, ud til kanten.
 */
const REPLACING = ["input.type", "input.paste", "input.drop", "delete.selection", "delete.cut"];

/**
 * En markering, der skrives over, sletter aldrig kun den ene halvdel af et usynligt tegnpar (keepMarks.ts).
 * Lav prioritet: filtrene kører fra lavest til højest, og forslagene (suggest.ts) skal bygges af det rettede.
 */
const keepPairs = Prec.low(
  EditorState.transactionFilter.of((tr) => {
    // Erstat i søgelinjen finder hen over markdowntegn (find.ts) og må heller ikke tage et halvt par.
    if (tr.docChanged && mode !== "raa" && tr.isUserEvent("input.replace")) {
      const all: { from: number; to: number; insert: string }[] = [];
      let fixed = false;
      tr.changes.iterChanges((from, to, _a, _b, text) => {
        const split = keepMarks(tr.startState, { from, to, insert: text.toString() });
        if (split) fixed = true;
        all.push(...(split ?? [{ from, to, insert: text.toString() }]));
      });
      if (!fixed) return tr;
      const changes = tr.startState.changes(all);
      const userEvent = tr.annotation(Transaction.userEvent);
      return { changes, selection: { anchor: changes.mapPos(tr.startState.selection.main.head, 1) }, effects: tr.effects, ...(userEvent ? { userEvent } : {}) };
    }
    if (mode !== "skjul" || !tr.docChanged || !REPLACING.some((e) => tr.isUserEvent(e))) return tr;
    const edits: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((from, to, _a, _b, text) => edits.push({ from, to, insert: text.toString() }));
    const split = edits.length === 1 ? keepMarks(tr.startState, edits[0]) : null;
    if (!split) return tr;
    const changes = tr.startState.changes(split);
    const userEvent = tr.annotation(Transaction.userEvent);
    return { changes, selection: { anchor: changes.mapPos(edits[0].from, 1) }, effects: tr.effects, scrollIntoView: tr.scrollIntoView, ...(userEvent ? { userEvent } : {}) };
  }),
);

export const hiddenMarkAtoms = [
  keepPairs,
  outOfPrefix,
  EditorView.atomicRanges.of(hiddenAtoms),
  Prec.high(keymap.of([
    { key: "Backspace", run: deleteVisible(false) },
    { key: "Delete", run: deleteVisible(true) },
    { key: "Mod-Backspace", run: deleteVisibleGroup(false) },
    { key: "Mod-Delete", run: deleteVisibleGroup(true) },
    { key: "ArrowLeft", run: moveVisible(false, false), shift: moveVisible(false, true) },
    { key: "ArrowRight", run: moveVisible(true, false), shift: moveVisible(true, true) },
  ])),
];

export const livePreviewTheme = EditorView.theme({
  // `# ` hænger i margenen som i iA. Tegnene skal arve linjens højde: med line-height 0 stod de en
  // halv linje over overskriften (målt 12/10: 18 px over teksten i en ###).
  ".gt-h1, .gt-h2, .gt-h3, .gt-h4, .gt-h5, .gt-h6": { position: "relative" },
  ".gt-hmark": {
    position: "absolute",
    right: "100%",
    color: "var(--dæmpet)",
    fontWeight: "normal",
    whiteSpace: "pre",
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
  ".gt-pagebreak-mark": { display: "flex", alignItems: "center", gap: "0.8em", color: "var(--dæmpet)", fontFamily: "var(--ui)", fontSize: "0.75em", letterSpacing: "0.04em" },
  ".gt-pagebreak-mark::before, .gt-pagebreak-mark::after": { content: '""', flex: "1", borderTop: "1px dashed var(--kant-hover)" },
  ".gt-dim": { color: "var(--dæmpet)" },
  // noBreak.ts: tegnene om skjulte markdowntegn må ikke brydes fra hinanden.
  ".gt-nobreak": { whiteSpace: "pre" },
  ".gt-cite": { color: "var(--svag)" },
  ".gt-cite-raw": { color: "var(--svag)" },
  ".gt-cite-unknown": { textDecoration: "underline wavy", textDecorationColor: "var(--advarsel, #c77700)", textUnderlineOffset: "3px" },
  ".gt-fnref": { fontSize: "0.7em", verticalAlign: "super", color: "var(--link)", padding: "0 1px" },
  ".gt-comment": { fontSize: "0.85em", color: "var(--dæmpet)" },
  ".gt-table": { fontSize: "0.92em" },
  ".gt-pipe": { color: "var(--pynt)" },
});
