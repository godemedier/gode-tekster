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
import {
  type CellFormat,
  caretAtCellEnd,
  caretAtPoint,
  cellRange,
  cellsAsText,
  formatCells,
  formatInCell,
  holdFocus,
  paintCells,
  selectedCells,
  setCellRange,
} from "./tableCells.ts";

type Align = "left" | "center" | "right";
/** En celle: teksten og hvor den står i dokumentet. */
export type Cell = { text: string; from: number };
export type ParsedTable = { header: Cell[]; align: Align[]; rows: Cell[][] };
/** Tabellen som markdown pr. celle: det, cellerne viser, og det, der skrives tilbage. */
export type TableModel = { header: string[]; align: Align[]; rows: string[][] };

/** Kun mellemrum og tab. `trim()` tager også NBSP og BOM, som så forsvandt fra cellen (fejljagt 19/10). */
const trimCell = (s: string): string => s.replace(/^[ \t\n]+|[ \t\n]+$/g, "");

/** Del en tabellinje ved lodrette streger, der ikke er escapet. `base` er linjens plads i dokumentet. */
export function splitRow(line: string, base: number): Cell[] {
  const cells: Cell[] = [];
  let start = 0;
  let i = 0;
  const lead = /^\s*\|/.exec(line);
  if (lead) start = i = lead[0].length;
  const push = (end: number) => {
    const raw = line.slice(start, end);
    const text = trimCell(raw);
    cells.push({ text: text.replace(/\\\|/g, "|"), from: base + start + (raw.length - raw.replace(/^[ \t\n]+/, "").length) });
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

/**
 * En celle som markdown: lodrette streger escapes, linjeskift bliver mellemrum. En streg er escapet,
 * når der står et ulige antal \ foran. `a\\|b` er en escapet \ og så en streg, der delte cellen i to
 * (fejljagt F2-M5, 27/10).
 */
export function escapeCell(text: string): string {
  return trimCell(text.replace(/[ \t]*\n[ \t]*/g, " ").replace(/(\\*)\|/g, (m, bs: string) => (bs.length % 2 === 0 ? `${bs}\\|` : m)));
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

/**
 * Fed, kursiv, understreget, gennemstreget, kode, links og linjeskift i en celle, som elementer.
 * Resten står som tekst. <br> er en markdown-tabels eneste linjeskift i en celle (15/10: cellen
 * viste »<br>«). Fed kan rumme kursiv og omvendt (27/10: en hel kolonne gjort kursiv, hvor en celle
 * var fed i forvejen, viste stjernerne).
 */
// Kursiv prøves før fed: `***Bo** Sand*` er kursiv om »**Bo** Sand«, ikke fed om »*Bo«.
// Understreg kun ved en ordgrænse, som i CommonMark. »fil_navn_ny.txt« blev ellers til kursiv og skrevet
// tilbage som »fil*navn*ny.txt«, når man skrev i en anden celle i rækken (fejljagt 19/10).
const INLINE = /(<br\s*\/?>|<u>.*?<\/u>|~~[^~]+~~|\*\*\*[^*]+\*\*\*|\*(?:[^*]|\*\*[^*]+\*\*)+\*|\*\*(?:[^*]|\*[^*]+\*)+\*\*|(?<![\p{L}\p{N}_])__[^_]+__(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])_[^_]+_(?![\p{L}\p{N}_])|`[^`]+`|\[[^\]]*\]\([^)]*\))/iu;
/** `mark` er markøren fra filen (`**` eller `__`), så den skrives tilbage, som den stod. */
export type InlinePart = { kind: "text" | "strong" | "em" | "u" | "s" | "code" | "link" | "br"; text: string; href?: string; mark?: string };
export function inlineParts(text: string): InlinePart[] {
  // split med én gruppe giver tekst og fund på skift. Kun fundene må tolkes: tekst, der selv
  // begynder med »[«, blev før til et link med hele cellen som adresse (19/10).
  return text
    .split(INLINE)
    .flatMap((p, i): InlinePart[] => (p === "" ? [] : i % 2 === 0 ? [{ kind: "text", text: p }] : [token(p)]));
}

function token(p: string): InlinePart {
  if (/^<br/i.test(p)) return { kind: "br", text: "" };
  if (/^<u>/i.test(p)) return { kind: "u", text: p.slice(3, -4) };
  if (/^~~/.test(p)) return { kind: "s", text: p.slice(2, -2) };
  // Fed begynder og slutter med to tegn. `***Bo** Sand*` begynder med to, men er kursiv.
  if (/^(\*\*|__)[\s\S]*\1$/.test(p) && p.length > 4) return { kind: "strong", text: p.slice(2, -2), mark: p.slice(0, 2) };
  if (/^`/.test(p)) return { kind: "code", text: p.slice(1, -1) };
  if (/^\[/.test(p)) return { kind: "link", text: p.slice(1, p.indexOf("](")), href: p.slice(p.indexOf("](") + 2, -1) };
  if (/^[*_]/.test(p) && p.length > 2) return { kind: "em", text: p.slice(1, -1), mark: p[0] };
  return { kind: "text", text: p };
}

function fill(el: HTMLElement, text: string): void {
  for (const part of inlineParts(text)) {
    if (part.kind === "text") {
      el.append(part.text);
      continue;
    }
    if (part.kind === "br") {
      el.append(document.createElement("br"));
      continue;
    }
    const tag = part.kind === "link" ? "span" : part.kind;
    const child = document.createElement(tag);
    if (part.kind === "link") {
      child.className = "gt-link";
      child.dataset.href = part.href ?? "";
    }
    if (part.kind === "code") child.className = "gt-code";
    if (part.mark) child.dataset.mark = part.mark;
    // Kode og links viser deres tekst, som den står. Resten kan rumme mere formatering.
    if (part.kind === "code" || part.kind === "link") child.textContent = part.text;
    else fill(child, part.text);
    el.append(child);
  }
}

/**
 * Det, en celle viser, tilbage til markdown. Formatering fra Ctrl+B og Ctrl+I tæller med, og et
 * linjeskift er <br>. Et <br> til sidst er browserens pladsholder for en tom sidste linje.
 */
function cellMarkdown(el: Node): string {
  return placeholderSpaces(inlineMarkdown(el).replace(/<br>$/, ""));
}

/**
 * Browseren skriver NBSP for et mellemrum yderst i en celle og for hvert andet af flere mellemrum.
 * Kun de bliver almindelige mellemrum. Et NBSP mellem to tegn (»10 kr.«) er skribentens eget og
 * bliver stående (fejljagt 19/10: før blev alle NBSP i rækken til mellemrum).
 */
export function placeholderSpaces(text: string): string {
  return text.replace(/^ +| +$|(?<= ) | (?= )/g, (m) => " ".repeat(m.length));
}

function inlineMarkdown(el: Node): string {
  let out = "";
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? "";
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    const tag = n.tagName.toLowerCase();
    if (tag === "br") {
      out += "<br>";
      return;
    }
    const inner = inlineMarkdown(n);
    if (!inner.trim()) out += inner;
    else if (tag === "strong" || tag === "b") out += `${n.dataset.mark ?? "**"}${inner}${n.dataset.mark ?? "**"}`;
    else if (tag === "em" || tag === "i") out += `${n.dataset.mark ?? "*"}${inner}${n.dataset.mark ?? "*"}`;
    else if (tag === "u") out += `<u>${inner}</u>`;
    else if (tag === "s" || tag === "strike" || tag === "del") out += `~~${inner}~~`;
    else if (tag === "code") out += `\`${inner}\``;
    else if (n.dataset.href !== undefined) out += `[${inner}](${n.dataset.href})`;
    else out += inner;
  });
  return out;
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
      // Stregerne tegnes af spelling.ts (ADR-0063), ikke af WebView2.
      cell.spellcheck = false;
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
  if (dir === "before") {
    // Som vejen ud nedad: markørens linje med en tom linje på begge sider. Før stod markøren på den
    // tomme linje lige over tabellen, og det, man skrev, blev ét afsnit med teksten over (F1-B13).
    const first = doc.lineAt(t.from).number;
    let k = 0;
    while (first - k - 1 >= 1 && doc.line(first - k - 1).length === 0) k++;
    const textAbove = first - k - 1 >= 1;
    const need = textAbove ? 3 : 2;
    const top = first - k;
    if (k >= need) {
      view.dispatch({ selection: { anchor: doc.line(top + (textAbove ? 1 : 0)).from }, scrollIntoView: true });
      return;
    }
    const insert = "\n".repeat(need - k);
    // Efter indsættelsen: de tomme linjer begynder ved `top`, markøren står på den anden (den første uden tekst over).
    const anchor = k > 0 ? doc.line(top).from + (textAbove ? 1 : 0) : t.from + (textAbove ? 1 : 0);
    view.dispatch({ changes: { from: t.from, insert }, selection: { anchor }, scrollIntoView: true, userEvent: "input" });
    return;
  }
  // Tekst lige under en tabel bliver en ny række i markdown. Markøren skal stå efter en tom linje:
  // den, der er, eller en ny (15/10: »N« blev en række, og resten havnede nederst i teksten).
  const next = t.to < doc.length ? doc.lineAt(t.to + 1) : null;
  const after = next && next.number < doc.lines ? doc.line(next.number + 1) : null;
  if (next && next.length === 0 && after && after.length === 0) {
    view.dispatch({ selection: { anchor: after.from }, scrollIntoView: true });
    return;
  }
  // Målet er tabellen, en tom linje, markørens linje og, hvis der kommer mere, en tom linje igen.
  const insert = !next ? "\n\n" : next.length > 0 ? "\n\n\n" : after ? "\n\n" : "\n";
  view.dispatch({ changes: { from: t.to, insert }, selection: { anchor: t.to + 2 }, scrollIntoView: true, userEvent: "input" });
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

/** Flyt række `from` hen på plads `to`, talt i rækkerne under overskriften. */
export function moveRow(m: TableModel, from: number, to: number): TableModel {
  const rows = [...m.rows];
  const [row] = rows.splice(from, 1);
  if (row) rows.splice(to, 0, row);
  return { ...m, rows };
}

/** Flyt kolonne `from` hen på plads `to`, med justeringen. En kort række fyldes ud først. */
export function moveColumn(m: TableModel, from: number, to: number): TableModel {
  const move = <T,>(a: T[]): T[] => {
    const b = [...a];
    b.splice(to, 0, ...b.splice(from, 1));
    return b;
  };
  return { header: move(m.header), align: move(m.align), rows: m.rows.map((r) => move(m.header.map((_, i) => r[i] ?? ""))) };
}

/** Kan rækken (dr) eller kolonnen (dc) ved cellen (r, c) flyttes ét skridt? Overskriften står fast. */
function canMove(m: TableModel, r: number, c: number, dr: number, dc: number): boolean {
  if (dr) return r > 0 && r - 1 + dr >= 0 && r - 1 + dr < m.rows.length;
  return c + dc >= 0 && c + dc < m.header.length;
}

/** Flyt rækken eller kolonnen ét skridt (højreklik og Alt+pil, 26/10). Markøren følger med. */
function moveBy(view: EditorView, wrap: HTMLElement, m: TableModel, r: number, c: number, dr: number, dc: number): void {
  if (!canMove(m, r, c, dr, dc)) return;
  if (dr) commitAll(view, wrap, moveRow(m, r - 1, r - 1 + dr), { row: r + dr, col: c });
  else commitAll(view, wrap, moveColumn(m, c, c + dc), { row: r, col: c + dc });
}

/** Et punkt i højrekliksmenuen (ui/contextMenu.ts bygger WebView2's egen menu af dem). */
export type TableMenuItem = { label: string; run: () => void; checked?: boolean } | { separator: true };

/**
 * Tabellens punkter til højreklik i en celle (9/10). Før havde tabellen sin egen menu, som skjulte
 * stavekontrollens forslag. Nu er de en undermenu i WebView2's egen menu.
 */
export function tableMenuAt(view: EditorView, target: Element): TableMenuItem[] | null {
  const cell = target.closest<HTMLElement>(".gt-tablebox th, .gt-tablebox td");
  const wrap = cell?.closest<HTMLElement>(".gt-tablebox");
  if (!cell || !wrap || !view.contentDOM.contains(wrap)) return null;
  const r = Number(cell.dataset.row);
  const c = Number(cell.dataset.col);
  const m = domModel(wrap);
  const setAlign = (a: Align) => commitAll(view, wrap, { ...m, align: m.align.map((v, i) => (i === c ? a : v)) }, { row: r, col: c });
  return [
    { label: tr("Ny række over", "New row above"), run: () => commitAll(view, wrap, addRow(m, Math.max(0, r - 1)), { row: Math.max(1, r), col: c }) },
    { label: tr("Ny række under", "New row below"), run: () => commitAll(view, wrap, addRow(m, r), { row: r + 1, col: c }) },
    { label: tr("Ny kolonne til venstre", "New column to the left"), run: () => commitAll(view, wrap, addColumn(m, c), { row: r, col: c }) },
    { label: tr("Ny kolonne til højre", "New column to the right"), run: () => commitAll(view, wrap, addColumn(m, c + 1), { row: r, col: c + 1 }) },
    { separator: true },
    ...(canMove(m, r, c, -1, 0) ? [{ label: tr("Flyt række op", "Move row up"), run: () => moveBy(view, wrap, m, r, c, -1, 0) }] : []),
    ...(canMove(m, r, c, 1, 0) ? [{ label: tr("Flyt række ned", "Move row down"), run: () => moveBy(view, wrap, m, r, c, 1, 0) }] : []),
    ...(canMove(m, r, c, 0, -1) ? [{ label: tr("Flyt kolonne til venstre", "Move column left"), run: () => moveBy(view, wrap, m, r, c, 0, -1) }] : []),
    ...(canMove(m, r, c, 0, 1) ? [{ label: tr("Flyt kolonne til højre", "Move column right"), run: () => moveBy(view, wrap, m, r, c, 0, 1) }] : []),
    { separator: true },
    ...(r > 0 ? [{ label: tr("Slet række", "Delete row"), run: () => commitAll(view, wrap, { ...m, rows: m.rows.filter((_, i) => i !== r - 1) }, { row: Math.min(r, m.rows.length - 1), col: c }) }] : []),
    ...(m.header.length > 1 ? [{ label: tr("Slet kolonne", "Delete column"), run: () => commitAll(view, wrap, removeColumn(m, c), { row: r, col: Math.max(0, c - 1) }) }] : []),
    { separator: true },
    { label: tr("Venstrestil", "Align left"), run: () => setAlign("left"), checked: m.align[c] === "left" },
    { label: tr("Centrér", "Center"), run: () => setAlign("center"), checked: m.align[c] === "center" },
    { label: tr("Højrestil", "Align right"), run: () => setAlign("right"), checked: m.align[c] === "right" },
  ];
}

/** Står markøren på cellens første (op) eller sidste (ned) linje? null, når den ikke kan måles. */
function caretAtEdge(cell: HTMLElement, up: boolean): boolean | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return true;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(up);
  const rect = range.getClientRects()[0];
  if (!rect) return null;
  const box = cell.getBoundingClientRect();
  const style = getComputedStyle(cell);
  const line = parseFloat(style.lineHeight) || rect.height || 20;
  return up
    ? rect.top - (box.top + parseFloat(style.paddingTop)) < line / 2
    : box.bottom - parseFloat(style.paddingBottom) - rect.bottom < line / 2;
}

// `Range` er CodeMirrors her. DOM'ens hedder det samme.
type DomRange = ReturnType<typeof document.createRange>;

/** Markørens kasse. Lige efter et linjeskift har den ingen, så måles det, der står ved den. */
function caretBox(range: DomRange): DOMRect | null {
  const own = range.getClientRects()[0];
  if (own) return own;
  const n = range.startContainer;
  const near = n.nodeType === Node.TEXT_NODE ? n : (n.childNodes[range.startOffset] ?? n.childNodes[range.startOffset - 1]);
  if (!near) return null;
  const probe = document.createRange();
  probe.selectNode(near);
  const rects = probe.getClientRects();
  return rects[rects.length - 1] ?? null;
}

/**
 * Pil op eller ned inden for en celle med flere linjer. Browserens egen linjebevægelse prøves, og
 * kom markøren ikke på en anden linje i cellen, lægges den tilbage. På første linje flyttede Chrome
 * den ellers til linjens begyndelse, altså vandret (27/10: »pil op skal altid gå lodret«).
 */
function lineWithinCell(cell: HTMLElement, up: boolean): boolean {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return false;
  const before = sel.getRangeAt(0).cloneRange();
  const y0 = caretBox(before)?.top;
  sel.modify("move", up ? "backward" : "forward", "line");
  const after = sel.rangeCount ? sel.getRangeAt(0) : null;
  const y1 = after ? caretBox(after)?.top : undefined;
  if (after && cell.contains(after.startContainer) && y0 !== undefined && y1 !== undefined && Math.abs(y1 - y0) > 2) return true;
  sel.removeAllRanges();
  sel.addRange(before);
  return false;
}

/** Markørens vandrette plads, så den lander lige over eller under i næste række. */
function caretX(): number | null {
  const sel = window.getSelection();
  return sel?.rangeCount ? (caretBox(sel.getRangeAt(0))?.left ?? null) : null;
}

/** Markøren ind i en celle ved `x`: på sidste linje, når den kommer nedefra, ellers på første. */
function caretInto(cell: HTMLElement, x: number | null, fromBelow: boolean): void {
  cell.focus({ preventScroll: true });
  cell.scrollIntoView({ block: "nearest", inline: "nearest" });
  const box = cell.getBoundingClientRect();
  const style = getComputedStyle(cell);
  const y = fromBelow ? box.bottom - parseFloat(style.paddingBottom) - 4 : box.top + parseFloat(style.paddingTop) + 4;
  const range = x === null ? null : document.caretRangeFromPoint(Math.min(Math.max(x, box.left + 1), box.right - 1), y);
  const sel = window.getSelection();
  if (!range || !sel || !cell.contains(range.startContainer)) return focusCell(cell);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Markøren først eller sidst i en celle. */
function caretAtSide(cell: HTMLElement, start: boolean): void {
  cell.focus({ preventScroll: true });
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(start);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * En række eller kolonne, som en pil har lavet (27/10). Går pilen tilbage, før der er skrevet noget,
 * forsvinder den igen. Skrives der, eller går fokus ud af tabellen, er den ikke længere ny.
 */
const fresh = new WeakMap<HTMLElement, { kind: "row" | "col"; index: number }>();

const STEPS: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

/** Formateringsgenvejene, de samme som i teksten (shortcuts.ts). */
function formatKey(e: KeyboardEvent): CellFormat | null {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && !e.altKey && !e.shiftKey) return key === "b" ? "bold" : key === "i" ? "italic" : key === "u" ? "underline" : null;
  if ((mod && e.shiftKey && !e.altKey && key === "x") || (e.altKey && e.shiftKey && !mod && e.code === "Digit5")) return "strikeThrough";
  return null;
}

/**
 * Formatering ved højreklik i en celle (27/10): de markerede celler, eller markeringen eller ordet
 * under musen i cellen.
 */
export function tableFormatMenu(view: EditorView, target: Element, x: number, y: number): TableMenuItem[] | null {
  const cell = target.closest<HTMLElement>(".gt-tablebox th, .gt-tablebox td");
  const wrap = cell?.closest<HTMLElement>(".gt-tablebox");
  if (!cell || !wrap || !view.contentDOM.contains(wrap)) return null;
  const run = (kind: CellFormat) => () => {
    if (selectedCells(wrap).includes(cell)) return formatCells(wrap, kind, () => commitAll(view, wrap, domModel(wrap)));
    setCellRange(wrap, null);
    caretAtPoint(cell, x, y);
    if (document.activeElement !== cell) cell.focus({ preventScroll: true });
    formatInCell(cell, kind);
  };
  return [
    { label: tr("Fed (Ctrl+B)", "Bold (Ctrl+B)"), run: run("bold") },
    { label: tr("Kursiv (Ctrl+I)", "Italic (Ctrl+I)"), run: run("italic") },
    { label: tr("Understreget (Ctrl+U)", "Underline (Ctrl+U)"), run: run("underline") },
    { label: tr("Gennemstreget", "Strikethrough"), run: run("strikeThrough") },
  ];
}

/** Seks prikker: håndtaget, man trækker en række eller kolonne i. */
const GRIP =
  '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="3" r="1.3"/><circle cx="7" cy="3" r="1.3"/><circle cx="3" cy="8" r="1.3"/><circle cx="7" cy="8" r="1.3"/><circle cx="3" cy="13" r="1.3"/><circle cx="7" cy="13" r="1.3"/></g></svg>';

/**
 * Træk i en række eller kolonne (26/10). Ét håndtag for rækken og ét for kolonnen, musen står over.
 * Under trækket viser en streg, hvor den lander. Overskriftsrækken står fast: markdown har den øverst.
 */
function wireDrag(wrap: HTMLElement, view: EditorView): void {
  const make = (cls: string, label: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `gt-table-grip ${cls}`;
    b.tabIndex = -1;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = GRIP;
    wrap.append(b);
    return b;
  };
  const rowGrip = make("gt-table-grip-row", tr("Træk for at flytte rækken (Alt+↑ og Alt+↓). Klik for at markere den", "Drag to move the row (Alt+↑ and Alt+↓). Click to select it"));
  const colGrip = make("gt-table-grip-col", tr("Træk for at flytte kolonnen (Alt+← og Alt+→). Klik for at markere den", "Drag to move the column (Alt+← and Alt+→). Click to select it"));
  const line = document.createElement("div");
  line.className = "gt-table-drop";
  line.hidden = true;
  wrap.append(line);

  /** Et rektangel i tabelboksens koordinater, også når tabellen er rullet vandret. */
  const local = (el: Element) => {
    const box = wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { top: r.top - box.top + wrap.scrollTop, left: r.left - box.left + wrap.scrollLeft, width: r.width, height: r.height };
  };

  let drag: { kind: "row" | "col"; from: number; to: number } | null = null;

  // Håndtagene står ud for den række og over den kolonne, musen er over.
  wrap.addEventListener("pointermove", (e) => {
    if (drag) return;
    const cell = e.target instanceof Element ? e.target.closest<HTMLElement>("th, td") : null;
    const table = wrap.querySelector("table");
    if (!cell || !table) return;
    const t = local(table);
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    rowGrip.hidden = r === 0 || table.tBodies[0]?.rows.length === 1;
    if (!rowGrip.hidden && cell.parentElement) {
      const row = local(cell.parentElement);
      rowGrip.dataset.row = String(r);
      rowGrip.style.top = `${row.top + row.height / 2 - 8}px`;
      rowGrip.style.left = `${Math.max(0, t.left - 18)}px`;
    }
    const head = table.tHead?.rows[0]?.cells[c];
    colGrip.hidden = !head || (table.tHead?.rows[0]?.cells.length ?? 0) < 2;
    if (head && !colGrip.hidden) {
      const h = local(head);
      colGrip.dataset.col = String(c);
      colGrip.style.top = `${Math.max(0, t.top - 11)}px`;
      colGrip.style.left = `${h.left + h.width / 2 - 8}px`;
    }
  });

  const start = (kind: "row" | "col", grip: HTMLElement) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = Number(kind === "row" ? grip.dataset.row : grip.dataset.col);
    if (Number.isNaN(from)) return;
    // `to` tælles som i moveRow, under overskriften: et klik uden træk lander på samme plads.
    drag = { kind, from, to: kind === "row" ? from - 1 : from };
    grip.setPointerCapture(e.pointerId);
    wrap.classList.add("gt-table-dragging");
    for (const cell of wrap.querySelectorAll<HTMLElement>(kind === "row" ? `td[data-row="${from}"]` : `[data-col="${from}"]`)) cell.classList.add("gt-drag-source");
  };
  rowGrip.addEventListener("pointerdown", start("row", rowGrip));
  colGrip.addEventListener("pointerdown", start("col", colGrip));

  // Hvor rækken eller kolonnen lander: før den første række (kolonne), hvis midte musen er over.
  const track = (e: PointerEvent) => {
    const table = wrap.querySelector("table");
    if (!drag || !table) return;
    const t = local(table);
    const parts = drag.kind === "row" ? [...(table.tBodies[0]?.rows ?? [])] : [...(table.tHead?.rows[0]?.cells ?? [])];
    const gap = parts.findIndex((p) => {
      const r = p.getBoundingClientRect();
      return drag?.kind === "row" ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
    });
    const at = gap === -1 ? parts.length : gap;
    const edge = parts[Math.min(at, parts.length - 1)];
    if (!edge) return;
    const p = local(edge);
    const end = at === parts.length;
    // `to` er pladsen efter flytningen. Rækkerne tælles under overskriften.
    const from = drag.kind === "row" ? drag.from - 1 : drag.from;
    drag.to = at > from ? at - 1 : at;
    line.hidden = drag.to === from;
    if (drag.kind === "row") Object.assign(line.style, { top: `${(end ? p.top + p.height : p.top) - 1}px`, left: `${t.left}px`, width: `${t.width}px`, height: "2px" });
    else Object.assign(line.style, { top: `${t.top}px`, left: `${(end ? p.left + p.width : p.left) - 1}px`, width: "2px", height: `${t.height}px` });
  };
  rowGrip.addEventListener("pointermove", track);
  colGrip.addEventListener("pointermove", track);

  const finish = (commit: boolean) => () => {
    const d = drag;
    drag = null;
    line.hidden = true;
    wrap.classList.remove("gt-table-dragging");
    for (const cell of wrap.querySelectorAll(".gt-drag-source")) cell.classList.remove("gt-drag-source");
    if (!d || !commit) return;
    // Et klik uden træk markerer rækken eller kolonnen (27/10), så den kan gøres kursiv i ét greb.
    if (d.kind === "row" ? d.to === d.from - 1 : d.to === d.from) {
      const grid = cellsOf(wrap);
      const width = grid[0]?.length ?? 1;
      setCellRange(wrap, d.kind === "row" ? { r0: d.from, c0: 0, r1: d.from, c1: width - 1 } : { r0: 0, c0: d.from, r1: grid.length - 1, c1: d.from });
      const first = d.kind === "row" ? grid[d.from]?.[0] : grid[0]?.[d.from];
      if (first) holdFocus(first);
      return;
    }
    const m = domModel(wrap);
    if (d.kind === "row" && d.to !== d.from - 1) commitAll(view, wrap, moveRow(m, d.from - 1, d.to), { row: d.to + 1, col: 0 });
    if (d.kind === "col" && d.to !== d.from) commitAll(view, wrap, moveColumn(m, d.from, d.to), { row: 0, col: d.to });
  };
  for (const g of [rowGrip, colGrip]) {
    g.addEventListener("pointerup", finish(true));
    g.addEventListener("pointercancel", finish(false));
  }
}

/** Lytterne sidder på tabellens yderste element og læser alt fra DOM'en, når de kaldes. */
function wire(wrap: HTMLElement, view: EditorView): void {
  const cellOf = (e: Event) => (e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("th, td") : null);
  wrap.addEventListener("input", (e) => {
    // Flere celler formateres på én gang (tableCells.ts): tabellen skrives om bagefter, i ét fortryd-trin.
    if (wrap.dataset.batch) return;
    fresh.delete(wrap);
    const cell = cellOf(e);
    if (cell) commitRow(view, wrap, Number(cell.dataset.row));
  });
  // Kun ren tekst i en celle: ingen HTML udefra. Linjer bliver linjeskift i cellen.
  wrap.addEventListener("paste", (e) => {
    if (!cellOf(e)) return;
    e.preventDefault();
    const lines = (e.clipboardData?.getData("text/plain") ?? "").replace(/\t+/g, " ").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (i > 0) document.execCommand("insertLineBreak");
      if (line) document.execCommand("insertText", false, line);
    });
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
    const writeAll = () => commitAll(view, wrap, domModel(wrap));
    // Ctrl+B, I, U og Ctrl+Shift+X: de markerede celler, ellers markeringen eller ordet i cellen.
    const format = formatKey(e);
    if (format) {
      stop();
      if (cellRange(wrap)) formatCells(wrap, format, writeAll);
      else formatInCell(cell, format);
      return;
    }
    const step = STEPS[e.key];
    const range = cellRange(wrap);
    if (range) {
      if (e.key === "Escape") {
        stop();
        setCellRange(wrap, null);
        return focusCell(cell);
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        stop();
        for (const sc of selectedCells(wrap)) sc.replaceChildren();
        return writeAll();
      }
      if (mod && !e.altKey && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
        stop();
        void navigator.clipboard.writeText(cellsAsText(wrap));
        if (e.key.toLowerCase() === "x") {
          for (const sc of selectedCells(wrap)) sc.replaceChildren();
          writeAll();
        }
        return;
      }
      if (e.shiftKey && !mod && !e.altKey && step) {
        stop();
        const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
        return setCellRange(wrap, { ...range, r1: clamp(range.r1 + step[0], last), c1: clamp(range.c1 + step[1], width - 1) });
      }
      // Alt andet end en genvej: cellemarkeringen slipper, og tasten virker i cellen som før.
      if (!mod && !["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
        setCellRange(wrap, null);
        focusCell(cell);
      }
    }
    // Shift+pil yderst i en celle går videre til nabocellen, og så er det cellerne, der er markeret.
    if (e.shiftKey && !mod && !e.altKey && step) {
      const to = grid[r + step[0]]?.[c + step[1]];
      const edge = step[0] ? caretAtEdge(cell, step[0] < 0) === true : caretAtCellEnd(cell, step[1] > 0);
      if (to && edge) {
        stop();
        setCellRange(wrap, { r0: r, c0: c, r1: r + step[0], c1: c + step[1] });
        return holdFocus(cell);
      }
    }
    if (mod && !e.altKey && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      stop();
      // Fortryd ruller til CodeMirrors markør, som står uden for tabellen, ofte øverst i teksten.
      // Tabellen røg ud af det tegnede område, blev tegnet forfra og mistede fokus (15/10). Her
      // fortrydes uden at rulle. scrollIntoView er et almindeligt felt på transaktionen.
      const quiet = {
        state: view.state,
        dispatch: (t: Transaction) => {
          (t as { scrollIntoView: boolean }).scrollIntoView = false;
          view.dispatch(t);
        },
      };
      if (e.key.toLowerCase() === "y" || e.shiftKey) redo(quiet);
      else undo(quiet);
      return;
    }
    // Ctrl+S sidder i editorens tastaturkort, som ikke ser taster i en celle.
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      stop();
      window.dispatchEvent(new Event("gt-save-now"));
      return;
    }
    // Chromes egne Ctrl+A, Ctrl+Home og Ctrl+End gælder hele skrivefladen, ikke cellen: Ctrl+A og
    // Delete slettede hele teksten (15/10). Her gælder de cellen.
    if (mod && !e.altKey && (e.key.toLowerCase() === "a" || e.key === "Home" || e.key === "End")) {
      stop();
      const sel = window.getSelection();
      if (!sel) return;
      const all = document.createRange();
      all.selectNodeContents(cell);
      // Ctrl+A igen, når hele cellen er markeret: hele tabellen.
      const text = sel.toString().trim();
      if (e.key.toLowerCase() === "a" && (range || (text !== "" && text === (cell.textContent ?? "").trim()))) {
        setCellRange(wrap, { r0: 0, c0: 0, r1: last, c1: width - 1 });
        return holdFocus(cell);
      }
      if (e.key.toLowerCase() === "a") {
        sel.removeAllRanges();
        sel.addRange(all);
        return;
      }
      all.collapse(e.key === "Home");
      if (e.shiftKey && sel.anchorNode) sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, all.startContainer, all.startOffset);
      else {
        sel.removeAllRanges();
        sel.addRange(all);
      }
      return;
    }
    // Alt+pil flytter rækken eller kolonnen, som Alt+↑/↓ flytter et afsnit i teksten.
    if (e.altKey && !mod && !e.shiftKey && step) {
      stop();
      return moveBy(view, wrap, domModel(wrap), r, c, step[0], step[1]);
    }
    if (mod || e.altKey) return;
    if (e.key === "Tab") {
      stop();
      const i = r * width + c + (e.shiftKey ? -1 : 1);
      if (i < 0) return leave(view, wrap, "before");
      if (i >= grid.length * width) return commitAll(view, wrap, addRow(domModel(wrap), last), { row: last + 1, col: 0 });
      return focusCell(grid[Math.floor(i / width)]?.[i % width]);
    }
    if (e.key === "Enter" && e.shiftKey) {
      stop();
      document.execCommand("insertLineBreak");
      return;
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
    // Piletasterne (27/10): op og ned går altid lodret, til siderne altid vandret. Ned i sidste række
    // laver en ny række og til højre i sidste kolonne en ny kolonne. Går pilen tilbage, før der er
    // skrevet noget i den, forsvinder den igen.
    const isFresh = (kind: "row" | "col", index: number) => {
      const f = fresh.get(wrap);
      if (!f || f.kind !== kind || f.index !== index) return false;
      const cells = kind === "row" ? (grid[index] ?? []) : grid.map((row) => row[index]);
      return cells.every((x) => !(x?.textContent ?? "").trim());
    };
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey) {
      const up = e.key === "ArrowUp";
      stop();
      // En celle med flere linjer: pilen går først op og ned i cellen.
      if (lineWithinCell(cell, up)) return;
      const x = caretX();
      if (up && r === last && isFresh("row", r)) {
        fresh.delete(wrap);
        const m = domModel(wrap);
        return commitAll(view, wrap, { ...m, rows: m.rows.slice(0, -1) }, { row: r - 1, col: c });
      }
      if (!up && r === last && isFresh("row", r)) {
        // Ned igen fra den nye, tomme række: den forsvinder, og markøren går ud under tabellen.
        fresh.delete(wrap);
        const m = domModel(wrap);
        commitAll(view, wrap, { ...m, rows: m.rows.slice(0, -1) });
        return leave(view, wrap, "after");
      }
      if (up && r === 0) return leave(view, wrap, "before");
      if (!up && r === last) {
        fresh.set(wrap, { kind: "row", index: last + 1 });
        return commitAll(view, wrap, addRow(domModel(wrap), last), { row: last + 1, col: c });
      }
      return caretInto(grid[r + (up ? -1 : 1)][c], x, up);
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.shiftKey && window.getSelection()?.isCollapsed) {
      const right = e.key === "ArrowRight";
      if (!caretAtCellEnd(cell, right)) return;
      stop();
      if (!right && isFresh("col", c)) {
        fresh.delete(wrap);
        return commitAll(view, wrap, removeColumn(domModel(wrap), c), { row: r, col: c - 1 });
      }
      // Til højre igen fra den nye, tomme kolonne: der kommer ikke flere.
      if (right && isFresh("col", c)) return;
      if (right && c === width - 1) {
        fresh.set(wrap, { kind: "col", index: width });
        return commitAll(view, wrap, addColumn(domModel(wrap), width), { row: r, col: width });
      }
      const to = grid[r]?.[c + (right ? 1 : -1)];
      if (to) caretAtSide(to, right);
    }
  });
  // Markér celler med musen (27/10): træk fra én celle til en anden, eller Shift+klik.
  let dragFrom: HTMLElement | null = null;
  wrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const cell = cellOf(e);
    if (!cell) return;
    const active = document.activeElement instanceof HTMLElement && wrap.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>("th, td") : null;
    if (e.shiftKey && active && active !== cell) {
      e.preventDefault();
      const from = cellRange(wrap) ?? { r0: Number(active.dataset.row), c0: Number(active.dataset.col) };
      setCellRange(wrap, { r0: from.r0, c0: from.c0, r1: Number(cell.dataset.row), c1: Number(cell.dataset.col) });
      return holdFocus(active);
    }
    setCellRange(wrap, null);
    dragFrom = cell;
  });
  wrap.addEventListener("mousemove", (e) => {
    if (!dragFrom || !(e.buttons & 1)) return;
    const over = cellOf(e);
    if (!over || (over === dragFrom && !cellRange(wrap))) return;
    setCellRange(wrap, { r0: Number(dragFrom.dataset.row), c0: Number(dragFrom.dataset.col), r1: Number(over.dataset.row), c1: Number(over.dataset.col) });
    holdFocus(dragFrom);
  });
  wrap.addEventListener("mouseup", () => {
    dragFrom = null;
  });
  // Klikkes der uden for tabellen, slipper markeringen. Ikke når hele vinduet mister fokus, fx for
  // højrekliksmenuen, der skal kunne formatere de markerede celler.
  wrap.addEventListener("focusout", () => {
    setTimeout(() => {
      if (document.hasFocus() && !wrap.contains(document.activeElement)) {
        setCellRange(wrap, null);
        fresh.delete(wrap);
      }
    });
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
  wireDrag(wrap, view);
}

/**
 * Tabellernes målte højde, efter nummer i dokumentet. Hvert tastetryk i en celle giver en ny widget,
 * og uden en højde gætter CodeMirror ud fra markdown-linjerne: syv linjer, ca. 150 px. En tabel med
 * lange celler var 1.800 px, og siden sprang forskellen, så cellen røg ud af billedet og mistede
 * fokus (15/10, målt i tests/private/tabeller).
 */
const heights = new Map<number, number>();
const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
  for (const e of entries) {
    const dom = e.target as HTMLElement;
    if (dom.isConnected && dom.offsetHeight > 0) heights.set(Number(dom.dataset.index), dom.offsetHeight);
  }
});

class TableWidget extends WidgetType {
  private source: string;
  private model: TableModel;
  private index: number;
  constructor(source: string, model: TableModel, index: number) {
    super();
    this.source = source;
    this.model = model;
    this.index = index;
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source && other.index === this.index;
  }
  get estimatedHeight(): number {
    return heights.get(this.index) ?? -1;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "gt-tablebox";
    wrap.dataset.index = String(this.index);
    // Hver celle er sit eget redigerbare område. Uden det var hele skrivefladen det, så Ctrl+A i en
    // celle markerede hele teksten, og Delete slettede den (15/10).
    wrap.contentEditable = "false";
    buildTable(wrap, this.model);
    wire(wrap, view);
    sizes?.observe(wrap);
    return wrap;
  }
  /** Samme DOM bruges igen. Den tegnes kun om, når markdown og cellerne ikke længere stemmer. */
  updateDOM(dom: HTMLElement): boolean {
    dom.dataset.index = String(this.index);
    const focus = pendingFocus.get(dom);
    pendingFocus.delete(dom);
    const active = document.activeElement instanceof HTMLElement && dom.contains(document.activeElement) ? document.activeElement : null;
    if (!focus && sameModel(domModel(dom), this.model)) return true;
    const keep = focus ?? (active?.dataset.row ? { row: Number(active.dataset.row), col: Number(active.dataset.col) } : null);
    buildTable(dom, this.model);
    paintCells(dom);
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
  for (const [index, t] of tables.entries()) {
    const lines: { text: string; from: number }[] = [];
    for (let n = state.doc.lineAt(t.from).number; n <= state.doc.lineAt(t.to).number; n++) {
      const l = state.doc.line(n);
      lines.push({ text: l.text, from: l.from });
    }
    const parsed = parseTable(lines);
    if (parsed) out.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(t.from, t.to), modelOf(parsed), index), block: true }).range(t.from, t.to));
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
      // Står fokus allerede i en celle, er det CodeMirror, der læser markøren i cellen som en
      // markering ved tabellen. Før sendte det fokus til første celle, og siden sprang op (15/10).
      if (document.activeElement?.closest(".gt-tablebox")) return;
      const sel = u.state.selection.main;
      if (!sel.empty) return;
      const before = u.startState.selection.main.head;
      // CodeMirror lander i tabellen eller springer hen over den (15/10: fra linjen over til linjen
      // under). Begge dele tæller som at gå ind i den.
      // Kun ét linjeskridt: Ctrl+End og Page Down springer også over tabeller, men skal ikke ind i dem.
      const tables = u.state.field(tablePreview).tables;
      const doc = u.state.doc;
      const line = (pos: number) => doc.lineAt(pos).number;
      const t =
        before < sel.head
          ? tables.find((x) => before < x.from && sel.head >= x.from && line(before) + 1 >= line(x.from) && line(sel.head) <= line(x.to) + 1)
          : [...tables].reverse().find((x) => before > x.to && sel.head <= x.to && line(before) - 1 <= line(x.to) && line(sel.head) >= line(x.from) - 1);
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
    // Bredere end spalten, når der er plads (9/10, --udfald i setup.ts): kolonnerne får luft, og ord
    // brydes aldrig midt over (før: »Sandsy/nlighe/d«). Er tabellen stadig for bred, ruller den.
    // contain: kun tabellen ruller. Uden det trak dens bredde .cm-content med ud på telefonen, hvor
    // spalten ikke har max-width, og hele teksten rullede vandret (17/10).
    ".gt-tablebox": { position: "relative", padding: "0.5em 0 1.2em", marginInline: "calc(-1 * var(--udfald, 0px))", overflowX: "auto", contain: "inline-size", cursor: "text" },
    ".gt-tablebox table": { borderCollapse: "collapse", width: "auto", minWidth: "calc(100% - 2 * var(--udfald, 0px))", margin: "0 auto", fontSize: "0.9em", lineHeight: "1.5" },
    ".gt-tablebox th": { fontWeight: "600", borderBottom: "1px solid var(--svag)", padding: "0.3em 1em 0.4em 0.3em", verticalAlign: "bottom" },
    ".gt-tablebox td": { borderBottom: "1px solid var(--streg)", padding: "0.5em 1em 0.5em 0.3em", verticalAlign: "top" },
    ".gt-tablebox th:last-child, .gt-tablebox td:last-child": { paddingRight: "0.3em" },
    ".gt-tablebox tr:last-child td": { borderBottom: "none" },
    // white-space normal: med CodeMirrors pre-wrap indsætter Shift+Enter et linjeskift-tegn, som
    // blev til et mellemrum i markdown. Med normal bliver det <br> (15/10).
    ".gt-tablebox th, .gt-tablebox td": { outline: "none", minWidth: "3em", borderRadius: "3px", overflowWrap: "normal", wordBreak: "normal", hyphens: "auto", whiteSpace: "normal" },
    // På en smal skærm må en lang adresse brydes hvor som helst: før blev tabellen 834 px bred på
    // telefonen, og kolonne 2 stod uden for skærmen (fejljagt F2-B10). Bredt bliver ord hele.
    "@media (max-width: 700px)": { ".gt-tablebox th, .gt-tablebox td": { overflowWrap: "anywhere" } },
    ".gt-tablebox th:focus, .gt-tablebox td:focus": { backgroundColor: "var(--hover)" },
    // Markerede celler (tableCells.ts). Teksten kan ikke markeres imens, så et træk med musen ikke
    // også markerer tekst i den første celle.
    ".gt-tablebox th.gt-cell-selected, .gt-tablebox td.gt-cell-selected": { backgroundColor: "var(--markering)" },
    ".gt-cells th, .gt-cells td": { userSelect: "none", caretColor: "transparent" },
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
    // Håndtagene til at trække i, kun med mus: på telefonen er der ikke plads ved siden af tabellen.
    ".gt-table-grip": {
      position: "absolute",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: "16px",
      height: "16px",
      padding: "0",
      border: "none",
      borderRadius: "3px",
      background: "none",
      color: "var(--dæmpet)",
      cursor: "grab",
      opacity: "0",
      transition: "opacity 120ms ease",
      touchAction: "none",
      zIndex: "1",
    },
    ".gt-table-grip[hidden]": { display: "none" },
    ".gt-table-grip-col svg": { transform: "rotate(90deg)" },
    ".gt-tablebox:hover .gt-table-grip, .gt-table-dragging .gt-table-grip": { opacity: "1" },
    ".gt-table-grip:hover": { color: "var(--blæk)", background: "var(--hover)" },
    ".gt-table-dragging, .gt-table-dragging *": { cursor: "grabbing !important" },
    ".gt-drag-source": { opacity: "0.45" },
    ".gt-table-drop": { position: "absolute", background: "var(--accent)", borderRadius: "1px", pointerEvents: "none" },
    ".gt-table-drop[hidden]": { display: "none" },
    "@media (pointer: coarse)": { ".gt-table-grip": { display: "none" } },
    // Håndtagene har deres egen margen på 20 px (26/10): en bred tabel fyldte boksen helt ud, og
    // rækkehåndtaget stod oven på teksten i første kolonne. Mindstebredden lægger margenen til igen,
    // så en smal tabel stadig flugter med teksten.
    "@media (pointer: fine)": {
      ".gt-tablebox": { paddingInline: "20px" },
      ".gt-tablebox table": { minWidth: "min(100%, calc(100% - 2 * var(--udfald, 0px) + 40px))" },
    },
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
