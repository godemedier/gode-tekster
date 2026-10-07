// Tabeller vist og redigeret som tabeller (6/10: »det er for svært at overskue i markdown«, og
// senere samme dag: »redigering af tabeller skal altså være visuelt«). Markdown er stadig det, der
// står i filen. Tabellen vises altid som en enkel tabel med tynde vandrette streger, og cellerne
// redigeres direkte. Hver ændring skrives straks tilbage som markdown: en rettet celle skriver sin
// række om, nye og slettede rækker og kolonner skriver hele tabellen om. Ctrl+Z virker, fordi det
// er CodeMirrors egen historik.
//
// En blokdekoration, der dækker linjeskift, skal komme fra et StateField, ikke et ViewPlugin.
// CodeMirror lader hændelser og ændringer inde i en widget være (ignoreEvent, readMutation), så
// cellerne kan være redigerbare. Widgetten tegnes kun om, når markdown og cellerne ikke længere
// stemmer overens (fortryd, ændringer udefra). Ellers ville markøren i cellen hoppe ved hvert tegn.

import { undo, redo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

import { tr } from "../i18n.ts";
import { currentMarkMode, markModeChanged } from "./livePreview.ts";

type Align = "left" | "center" | "right";
/** En celle: teksten og hvor den står i dokumentet. */
export type Cell = { text: string; from: number };
export type ParsedTable = { header: Cell[]; align: Align[]; rows: Cell[][] };
/** Tabellen som markdown pr. celle: det, cellerne viser, og det, der skrives tilbage. */
export type TableModel = { header: string[]; align: Align[]; rows: string[][] };

/** Del en tabellinje ved lodrette streger, der ikke er escapet. `base` er linjens plads i dokumentet. */
export function splitRow(line: string, base: number): Cell[] {
  const cells: Cell[] = [];
  let start = 0;
  let i = 0;
  const lead = /^\s*\|/.exec(line);
  if (lead) start = i = lead[0].length;
  const push = (end: number) => {
    const raw = line.slice(start, end);
    const text = raw.trim();
    cells.push({ text: text.replace(/\\\|/g, "|"), from: base + start + (raw.length - raw.trimStart().length) });
  };
  for (; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "|") {
      push(i);
      start = i + 1;
    }
  }
  // Uden afsluttende streg er resten den sidste celle.
  if (line.slice(start).trim() !== "") push(line.length);
  return cells;
}

/** Tabellen ud fra dens linjer. Den anden linje er skillelinjen med justeringen. */
export function parseTable(lines: { text: string; from: number }[]): ParsedTable | null {
  if (lines.length < 2) return null;
  const header = splitRow(lines[0].text, lines[0].from);
  const align = splitRow(lines[1].text, lines[1].from).map((c): Align => {
    const t = c.text;
    return t.startsWith(":") && t.endsWith(":") ? "center" : t.endsWith(":") ? "right" : "left";
  });
  const rows = lines.slice(2).map((l) => splitRow(l.text, l.from));
  return header.length ? { header, align, rows } : null;
}

/** Modellen med lige mange celler i alle rækker, så hver række kan vises og redigeres. */
export function modelOf(t: ParsedTable): TableModel {
  const width = Math.max(t.header.length, ...t.rows.map((r) => r.length), 1);
  const pad = (cells: Cell[]) => Array.from({ length: width }, (_, i) => cells[i]?.text ?? "");
  return { header: pad(t.header), align: Array.from({ length: width }, (_, i) => t.align[i] ?? "left"), rows: t.rows.map(pad) };
}

/** En celle som markdown: lodrette streger escapes, linjeskift bliver mellemrum. */
export function escapeCell(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/(?<!\\)\|/g, "\\|").trim();
}

export function formatRow(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

export function formatDelimiter(align: Align[]): string {
  return `|${align.map((a) => (a === "center" ? ":-:" : a === "right" ? "--:" : "---")).join("|")}|`;
}

export function formatTable(m: TableModel): string {
  return [formatRow(m.header), formatDelimiter(m.align), ...m.rows.map(formatRow)].join("\n");
}

/** Fed, kursiv, kode og links i en celle, som elementer med textContent. Resten står som tekst. */
const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]*\]\([^)]*\))/;
export type InlinePart = { kind: "text" | "strong" | "em" | "code" | "link"; text: string; href?: string };
export function inlineParts(text: string): InlinePart[] {
  return text
    .split(INLINE)
    .filter((p) => p !== "")
    .map((p): InlinePart => {
      if (/^(\*\*|__)/.test(p) && p.length > 4) return { kind: "strong", text: p.slice(2, -2) };
      if (/^`/.test(p)) return { kind: "code", text: p.slice(1, -1) };
      if (/^\[/.test(p)) return { kind: "link", text: p.slice(1, p.indexOf("](")), href: p.slice(p.indexOf("](") + 2, -1) };
      if (/^[*_]/.test(p) && p.length > 2) return { kind: "em", text: p.slice(1, -1) };
      return { kind: "text", text: p };
    });
}

function fill(el: HTMLElement, text: string): void {
  for (const part of inlineParts(text)) {
    if (part.kind === "text") {
      el.append(part.text);
      continue;
    }
    const tag = part.kind === "strong" ? "strong" : part.kind === "em" ? "em" : part.kind === "code" ? "code" : "span";
    const child = document.createElement(tag);
    if (part.kind === "link") {
      child.className = "gt-link";
      child.dataset.href = part.href ?? "";
    }
    if (part.kind === "code") child.className = "gt-code";
    child.textContent = part.text;
    el.append(child);
  }
}

/** Det, en celle viser, tilbage til markdown. Formatering fra Ctrl+B og Ctrl+I tæller med. */
function cellMarkdown(el: Node): string {
  let out = "";
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? "";
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    const inner = cellMarkdown(n);
    const tag = n.tagName.toLowerCase();
    if (!inner.trim()) out += inner;
    else if (tag === "strong" || tag === "b") out += `**${inner}**`;
    else if (tag === "em" || tag === "i") out += `*${inner}*`;
    else if (tag === "u") out += `<u>${inner}</u>`;
    else if (tag === "code") out += `\`${inner}\``;
    else if (n.dataset.href !== undefined) out += `[${inner}](${n.dataset.href})`;
    else if (tag === "br") out += " ";
    else out += inner;
  });
  return out.replace(/\u00a0/g, " ");
}

// --- tabellen i skrivefladen -----------------------------------------------------------------------

const cellsOf = (wrap: HTMLElement): HTMLElement[][] =>
  [...wrap.querySelectorAll<HTMLTableRowElement>("tr")].map((r) => [...r.querySelectorAll<HTMLElement>("th, td")]);

function domModel(wrap: HTMLElement): TableModel {
  const rows = cellsOf(wrap).map((r) => r.map(cellMarkdown));
  return { header: rows[0] ?? [], align: JSON.parse(wrap.dataset.align ?? "[]") as Align[], rows: rows.slice(1) };
}

const sameModel = (a: TableModel, b: TableModel): boolean => formatTable(a) === formatTable(b);

function buildTable(wrap: HTMLElement, m: TableModel): void {
  wrap.dataset.align = JSON.stringify(m.align);
  const table = document.createElement("table");
  const row = (cells: string[], tag: "th" | "td", r: number) => {
    const rowEl = document.createElement("tr");
    cells.forEach((text, c) => {
      const cell = document.createElement(tag);
      cell.contentEditable = "true";
      cell.spellcheck = true;
      cell.dataset.row = String(r);
      cell.dataset.col = String(c);
      cell.style.textAlign = m.align[c] ?? "left";
      if (tag === "th") cell.dataset.placeholder = tr("Kolonne", "Column");
      fill(cell, text);
      rowEl.append(cell);
    });
    return rowEl;
  };
  const head = document.createElement("thead");
  head.append(row(m.header, "th", 0));
  const body = document.createElement("tbody");
  m.rows.forEach((r, i) => body.append(row(r, "td", i + 1)));
  table.append(head, body);
  wrap.querySelector("table")?.remove();
  wrap.prepend(table);
}

/** Ét felt pr. tabel: hvor den står, og hvilken celle der skal have fokus, når den er tegnet om. */
const pendingFocus = new WeakMap<HTMLElement, { row: number; col: number }>();

function focusCell(cell: HTMLElement | undefined): void {
  if (!cell) return;
  cell.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Tabellens plads i dokumentet lige nu. Regnes fra widgettens DOM, så den aldrig er forældet. */
function tableAt(view: EditorView, wrap: HTMLElement): Found | null {
  const from = view.posAtDOM(wrap);
  return view.state.field(tablePreview, false)?.tables.find((t) => t.from === from) ?? null;
}

/** En rettet celle: rækkens linje skrives om. Overskriften er linje 1, skillelinjen 2. */
function commitRow(view: EditorView, wrap: HTMLElement, r: number): void {
  const t = tableAt(view, wrap);
  if (!t) return;
  const first = view.state.doc.lineAt(t.from).number;
  const lineNo = r === 0 ? first : first + 1 + r;
  if (lineNo > view.state.doc.lineAt(t.to).number) return commitAll(view, wrap, domModel(wrap));
  const line = view.state.doc.line(lineNo);
  const cells = cellsOf(wrap)[r]?.map(cellMarkdown) ?? [];
  const insert = formatRow(cells);
  if (insert !== line.text) view.dispatch({ changes: { from: line.from, to: line.to, insert }, userEvent: "input.type.table" });
}

/** Ny eller slettet række eller kolonne: hele tabellen skrives om. `focus` får fokus bagefter. */
function commitAll(view: EditorView, wrap: HTMLElement, m: TableModel, focus?: { row: number; col: number }): void {
  const t = tableAt(view, wrap);
  if (!t) return;
  if (focus) pendingFocus.set(wrap, focus);
  view.dispatch({ changes: { from: t.from, to: t.to, insert: formatTable(m) }, userEvent: "input.table" });
}

/** Ud af tabellen med tastaturet: markøren står i linjen før eller efter. */
function leave(view: EditorView, wrap: HTMLElement, dir: "before" | "after"): void {
  const t = tableAt(view, wrap);
  view.focus();
  if (!t) return;
  const doc = view.state.doc;
  const anchor = dir === "before" ? Math.max(0, t.from - 1) : Math.min(doc.length, t.to + 1);
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
}

function addRow(m: TableModel, at: number): TableModel {
  const rows = [...m.rows];
  rows.splice(at, 0, m.header.map(() => ""));
  return { ...m, rows };
}

function addColumn(m: TableModel, at: number): TableModel {
  const ins = <T,>(a: T[], v: T) => [...a.slice(0, at), v, ...a.slice(at)];
  return { header: ins(m.header, ""), align: ins(m.align, "left" as Align), rows: m.rows.map((r) => ins(r, "")) };
}

function removeColumn(m: TableModel, at: number): TableModel {
  const del = <T,>(a: T[]) => a.filter((_, i) => i !== at);
  return { header: del(m.header), align: del(m.align), rows: m.rows.map(del) };
}

function cellMenu(view: EditorView, wrap: HTMLElement, cell: HTMLElement, x: number, y: number): void {
  const r = Number(cell.dataset.row);
  const c = Number(cell.dataset.col);
  const m = domModel(wrap);
  const setAlign = (a: Align) => commitAll(view, wrap, { ...m, align: m.align.map((v, i) => (i === c ? a : v)) }, { row: r, col: c });
  // Menuen hentes først her: den rører vinduet, når den indlæses, og tabellerne testes uden et.
  void import("../ui/menu.ts").then(({ showMenu }) => showMenu(x, y, [
    { label: tr("Ny række over", "New row above"), run: () => commitAll(view, wrap, addRow(m, Math.max(0, r - 1)), { row: Math.max(1, r), col: c }) },
    { label: tr("Ny række under", "New row below"), run: () => commitAll(view, wrap, addRow(m, r), { row: r + 1, col: c }) },
    { label: tr("Ny kolonne til venstre", "New column to the left"), run: () => commitAll(view, wrap, addColumn(m, c), { row: r, col: c }) },
    { label: tr("Ny kolonne til højre", "New column to the right"), run: () => commitAll(view, wrap, addColumn(m, c + 1), { row: r, col: c + 1 }) },
    { separator: true },
    ...(r > 0 ? [{ label: tr("Slet række", "Delete row"), run: () => commitAll(view, wrap, { ...m, rows: m.rows.filter((_, i) => i !== r - 1) }, { row: Math.min(r, m.rows.length - 1), col: c }) }] : []),
    ...(m.header.length > 1 ? [{ label: tr("Slet kolonne", "Delete column"), run: () => commitAll(view, wrap, removeColumn(m, c), { row: r, col: Math.max(0, c - 1) }) }] : []),
    { separator: true },
    { label: tr("Venstrestil", "Align left"), run: () => setAlign("left"), checked: m.align[c] === "left" },
    { label: tr("Centrér", "Center"), run: () => setAlign("center"), checked: m.align[c] === "center" },
    { label: tr("Højrestil", "Align right"), run: () => setAlign("right"), checked: m.align[c] === "right" },
  ]));
}

/** Lytterne sidder på tabellens yderste element og læser alt fra DOM'en, når de kaldes. */
function wire(wrap: HTMLElement, view: EditorView): void {
  const cellOf = (e: Event) => (e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("th, td") : null);
  wrap.addEventListener("input", (e) => {
    const cell = cellOf(e);
    if (cell) commitRow(view, wrap, Number(cell.dataset.row));
  });
  // Kun ren tekst i en celle: ingen HTML udefra og ingen linjeskift.
  wrap.addEventListener("paste", (e) => {
    if (!cellOf(e)) return;
    e.preventDefault();
    const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\s*[\r\n\t]+\s*/g, " ");
    document.execCommand("insertText", false, text);
  });
  wrap.addEventListener("contextmenu", (e) => {
    const cell = cellOf(e);
    if (!cell) return;
    e.preventDefault();
    cellMenu(view, wrap, cell, e.clientX, e.clientY);
  });
  wrap.addEventListener("keydown", (e) => {
    const cell = cellOf(e);
    if (!cell) return;
    const grid = cellsOf(wrap);
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    const last = grid.length - 1;
    const width = grid[0]?.length ?? 1;
    const mod = e.ctrlKey || e.metaKey;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (mod && !e.altKey && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      stop();
      if (e.key.toLowerCase() === "y" || e.shiftKey) redo(view);
      else undo(view);
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === "Tab") {
      stop();
      const i = r * width + c + (e.shiftKey ? -1 : 1);
      if (i < 0) return leave(view, wrap, "before");
      if (i >= grid.length * width) return commitAll(view, wrap, addRow(domModel(wrap), last), { row: last + 1, col: 0 });
      return focusCell(grid[Math.floor(i / width)]?.[i % width]);
    }
    if (e.key === "Enter") {
      stop();
      if (r === last) return commitAll(view, wrap, addRow(domModel(wrap), last), { row: last + 1, col: c });
      return focusCell(grid[r + 1]?.[c]);
    }
    if (e.key === "Escape") {
      stop();
      return leave(view, wrap, "after");
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      stop();
      const to = r + (e.key === "ArrowUp" ? -1 : 1);
      if (to < 0) return leave(view, wrap, "before");
      if (to > last) return leave(view, wrap, "after");
      return focusCell(grid[to]?.[c]);
    }
  });
  // De to små plusser: en række nederst og en kolonne yderst til højre.
  const add = (cls: string, label: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = "+";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", run);
    wrap.append(b);
  };
  add("gt-table-add gt-table-add-row", tr("Ny række", "New row"), () => {
    const m = domModel(wrap);
    commitAll(view, wrap, addRow(m, m.rows.length), { row: m.rows.length + 1, col: 0 });
  });
  add("gt-table-add gt-table-add-col", tr("Ny kolonne", "New column"), () => {
    const m = domModel(wrap);
    commitAll(view, wrap, addColumn(m, m.header.length), { row: 0, col: m.header.length });
  });
}

class TableWidget extends WidgetType {
  private source: string;
  private model: TableModel;
  constructor(source: string, model: TableModel) {
    super();
    this.source = source;
    this.model = model;
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "gt-tablebox";
    buildTable(wrap, this.model);
    wire(wrap, view);
    return wrap;
  }
  /** Samme DOM bruges igen. Den tegnes kun om, når markdown og cellerne ikke længere stemmer. */
  updateDOM(dom: HTMLElement): boolean {
    const focus = pendingFocus.get(dom);
    pendingFocus.delete(dom);
    const active = document.activeElement instanceof HTMLElement && dom.contains(document.activeElement) ? document.activeElement : null;
    if (!focus && sameModel(domModel(dom), this.model)) return true;
    const keep = focus ?? (active?.dataset.row ? { row: Number(active.dataset.row), col: Number(active.dataset.col) } : null);
    buildTable(dom, this.model);
    if (keep) {
      const grid = cellsOf(dom);
      focusCell(grid[Math.min(keep.row, grid.length - 1)]?.[Math.min(keep.col, (grid[0]?.length ?? 1) - 1)]);
    }
    return true;
  }
  ignoreEvent(): boolean {
    // Alt inde i tabellen håndteres her: cellerne er redigerbare, og CodeMirror skal ikke tage tasterne.
    return true;
  }
}

type Found = { from: number; to: number };
type TableState = { tree: unknown; tables: Found[]; deco: DecorationSet };

function findTables(state: EditorState): Found[] {
  const out: Found[] = [];
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name === "Table") {
        out.push({ from: state.doc.lineAt(n.from).from, to: state.doc.lineAt(n.to).to });
        return false;
      }
      // Kun blokke kan rumme en tabel. Et afsnit eller en overskrift skal ikke gennemgås.
      return n.name === "Document" || n.name === "Blockquote" || n.name === "BulletList" || n.name === "OrderedList" || n.name === "ListItem";
    },
  });
  return out;
}

function decorate(state: EditorState, tables: Found[]): DecorationSet {
  // »Vis tegn og formatering« og »Kun ren markdown« viser tabellen som den markdown, den er (7/10).
  const mode = currentMarkMode();
  if (mode === "alle" || mode === "raa") return Decoration.none;
  const out: Range<Decoration>[] = [];
  for (const t of tables) {
    const lines: { text: string; from: number }[] = [];
    for (let n = state.doc.lineAt(t.from).number; n <= state.doc.lineAt(t.to).number; n++) {
      const l = state.doc.line(n);
      lines.push({ text: l.text, from: l.from });
    }
    const parsed = parseTable(lines);
    if (parsed) out.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(t.from, t.to), modelOf(parsed)), block: true }).range(t.from, t.to));
  }
  return Decoration.set(out);
}

export const tablePreview = StateField.define<TableState>({
  create(state) {
    const tables = findTables(state);
    return { tree: syntaxTree(state), tables, deco: decorate(state, tables) };
  },
  update(value, tr: Transaction) {
    const tree = syntaxTree(tr.state);
    const modeChanged = tr.effects.some((e) => e.is(markModeChanged));
    if (!tr.docChanged && tree === value.tree && !modeChanged) return value;
    const tables = findTables(tr.state);
    return { tree, tables, deco: decorate(tr.state, tables) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** Sæt fokus i en celle i tabellen, der begynder på `pos` (efter /tabel). Venter på, at den er tegnet. */
export function focusTable(view: EditorView, pos: number, row = 0, col = 0): void {
  requestAnimationFrame(() => {
    const wrap = [...view.contentDOM.querySelectorAll<HTMLElement>(".gt-tablebox")].find((w) => view.posAtDOM(w) === pos);
    if (wrap) focusCell(cellsOf(wrap)[row]?.[col]);
  });
}

/**
 * Ind i tabellen med piletasterne: kommer markøren fra linjen over, får første celle fokus, og kommer
 * den fra linjen under, første celle i sidste række. Musen klikker selv i cellerne.
 */
const arrowInto = ViewPlugin.fromClass(
  class {
    update(u: ViewUpdate): void {
      if (!u.selectionSet || u.docChanged || !u.transactions.some((t) => t.isUserEvent("select") && !t.isUserEvent("select.pointer"))) return;
      const sel = u.state.selection.main;
      if (!sel.empty) return;
      const before = u.startState.selection.main.head;
      const t = u.state.field(tablePreview).tables.find((x) => sel.head >= x.from && sel.head <= x.to);
      if (!t) return;
      const fromAbove = before < t.from;
      const rows = u.state.doc.lineAt(t.to).number - u.state.doc.lineAt(t.from).number - 1;
      const view = u.view;
      queueMicrotask(() => focusTable(view, t.from, fromAbove ? 0 : Math.max(0, rows), 0));
    }
  },
);

// Minimalistisk: ingen lodrette streger og ingen rammer. En streg under overskriftsrækken og en
// tynd streg mellem rækkerne. Kun padding, aldrig margin: CodeMirror måler højder uden margin.
export const tableTheme = [
  arrowInto,
  EditorView.theme({
    ".gt-tablebox": { position: "relative", padding: "0.5em 0 1.2em", overflowX: "auto", cursor: "text" },
    ".gt-tablebox table": { borderCollapse: "collapse", width: "100%", fontSize: "0.9em", lineHeight: "1.5" },
    ".gt-tablebox th": { fontWeight: "600", borderBottom: "1px solid var(--svag)", padding: "0.3em 1em 0.4em 0.3em", verticalAlign: "bottom" },
    ".gt-tablebox td": { borderBottom: "1px solid var(--streg)", padding: "0.5em 1em 0.5em 0.3em", verticalAlign: "top" },
    ".gt-tablebox th:last-child, .gt-tablebox td:last-child": { paddingRight: "0.3em" },
    ".gt-tablebox tr:last-child td": { borderBottom: "none" },
    ".gt-tablebox th, .gt-tablebox td": { outline: "none", minWidth: "3em", borderRadius: "3px" },
    ".gt-tablebox th:focus, .gt-tablebox td:focus": { backgroundColor: "var(--hover)" },
    ".gt-tablebox th:empty::before": { content: "attr(data-placeholder)", color: "var(--dæmpet)", fontWeight: "400" },
    ".gt-table-add": {
      position: "absolute",
      width: "20px",
      height: "20px",
      lineHeight: "18px",
      padding: "0",
      border: "1px solid var(--kant)",
      borderRadius: "50%",
      background: "var(--kort)",
      color: "var(--svag)",
      fontSize: "14px",
      cursor: "pointer",
      opacity: "0",
      transition: "opacity 120ms ease",
    },
    ".gt-tablebox:hover .gt-table-add, .gt-tablebox:focus-within .gt-table-add": { opacity: "1" },
    ".gt-table-add:hover": { color: "var(--blæk)", borderColor: "var(--kant-hover)" },
    ".gt-table-add-row": { left: "0", bottom: "0" },
    ".gt-table-add-col": { right: "0", top: "0.55em" },
  }),
];

// --- tabeller sat ind fra en terminal (6/10) -------------------------------------------------------
//
// En tabel kopieret fra en terminal er rykket ind (så markdown læser den som kode), og lange rækker
// er brudt midt i. Står der en markdown-tabel med skillelinje i det indsatte, fjernes indrykningen,
// og en række, der ikke slutter med en lodret streg, samles med linjerne efter den. Alt andet sættes
// ind, som det er.

const DELIMITER = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/;
const endsRow = (t: string) => /(^|[^\\])\|$/.test(t);

export function repairPastedTable(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (!lines.some((l) => DELIMITER.test(l.trim()))) return text;
  // Først: brudte rækker samles. En række er en linje, der begynder med en lodret streg.
  const logical: { text: string; row: boolean; raw: string[] }[] = [];
  for (const raw of lines) {
    const t = raw.trim();
    const prev = logical[logical.length - 1];
    if (prev?.row && !endsRow(prev.text) && t !== "" && !t.startsWith("|")) {
      prev.text = `${prev.text} ${t}`;
      prev.raw.push(raw);
      continue;
    }
    logical.push({ text: t.startsWith("|") ? t : raw, row: t.startsWith("|"), raw: [raw] });
  }
  // Så: kun rækker i en blok, hvor anden række er skillelinjen, mister indrykningen. Andre linjer
  // med en lodret streg forrest bliver, som de var.
  const out: string[] = [];
  let inTable = false;
  for (let i = 0; i < logical.length; i++) {
    const l = logical[i];
    if (!l.row) {
      inTable = false;
      out.push(l.text);
      continue;
    }
    if (!inTable && logical[i + 1]?.row && DELIMITER.test(logical[i + 1].text)) inTable = true;
    if (inTable) out.push(l.text);
    else out.push(...l.raw);
  }
  return out.join("\n");
}

export const pasteTables = EditorView.clipboardInputFilter.of((text) => repairPastedTable(text));
