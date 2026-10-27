// Markering hen over tabelceller og formatering i en celle (27/10: »det skal være muligt at markere
// på tværs af kolonner og rækker, så jeg fx kan markere en hel kolonne for at gøre den kursiv«).
//
// Hver celle er sit eget redigerbare område (tables.ts), så browserens markering kan ikke gå fra én
// celle til en anden. Markeringen af celler er derfor vores egen: et rektangel af celler med en
// klasse på, mens fokus bliver i den celle, man begyndte i. Formateringen sker i DOM'en med
// browserens egne kommandoer, som også klarer fed i kursiv og en celle, der er fed i forvejen.
// Tabellen skriver bagefter sin markdown om i én transaktion, så Ctrl+Z fortryder det hele på én gang.

import { wordRangeAt } from "./editing.ts";

export type CellRange = { r0: number; c0: number; r1: number; c1: number };
/** Browserens navne på kommandoerne. Fed bliver <b>, kursiv <i>, gennemstreget <strike>. */
export type CellFormat = "bold" | "italic" | "underline" | "strikeThrough";

const ranges = new WeakMap<HTMLElement, CellRange>();

export const cellRange = (wrap: HTMLElement): CellRange | null => ranges.get(wrap) ?? null;

const pos = (cell: HTMLElement) => ({ r: Number(cell.dataset.row), c: Number(cell.dataset.col) });

function inRange(r: CellRange, cell: HTMLElement): boolean {
  const { r: row, c: col } = pos(cell);
  return row >= Math.min(r.r0, r.r1) && row <= Math.max(r.r0, r.r1) && col >= Math.min(r.c0, r.c1) && col <= Math.max(r.c0, r.c1);
}

/** Sæt eller fjern markeringen og tegn den. */
export function setCellRange(wrap: HTMLElement, range: CellRange | null): void {
  if (range) ranges.set(wrap, range);
  else ranges.delete(wrap);
  paintCells(wrap);
}

/** Klasserne efter markeringen. Kaldes også, når tabellen er tegnet forfra (fortryd). */
export function paintCells(wrap: HTMLElement): void {
  const r = ranges.get(wrap) ?? null;
  wrap.classList.toggle("gt-cells", r !== null);
  for (const cell of wrap.querySelectorAll<HTMLElement>("th, td")) cell.classList.toggle("gt-cell-selected", r !== null && inRange(r, cell));
}

export function selectedCells(wrap: HTMLElement): HTMLElement[] {
  const r = ranges.get(wrap);
  return r ? [...wrap.querySelectorAll<HTMLElement>("th, td")].filter((c) => inRange(r, c)) : [];
}

/** Fokus i cellen uden blinkende markør: markeringen er cellerne, ikke teksten. */
export function holdFocus(cell: HTMLElement): void {
  cell.focus({ preventScroll: true });
  window.getSelection()?.removeAllRanges();
}

function selectContents(cell: HTMLElement): void {
  cell.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(cell);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Formatér de markerede celler. Er de alle fede i forvejen, fjernes det fede. Ellers bliver de, der
 * mangler det, fede, som i Word. Overskriftsrækken er fed af sig selv og springes over ved fed.
 * `batch` slår rækkernes egne skrivninger fra, mens kommandoerne kører, og `commit` skriver det hele.
 */
export function formatCells(wrap: HTMLElement, kind: CellFormat, commit: () => void): void {
  const anchor = document.activeElement instanceof HTMLElement && wrap.contains(document.activeElement) ? document.activeElement : null;
  const cells = selectedCells(wrap).filter((c) => (c.textContent ?? "").trim() && !(kind === "bold" && c.tagName === "TH"));
  if (cells.length === 0) return;
  wrap.dataset.batch = "1";
  try {
    const on = cells.map((c) => {
      selectContents(c);
      return document.queryCommandState(kind);
    });
    const target = !on.every(Boolean);
    cells.forEach((c, i) => {
      if (on[i] === target) return;
      selectContents(c);
      document.execCommand(kind);
    });
  } finally {
    delete wrap.dataset.batch;
  }
  if (anchor) holdFocus(anchor);
  commit();
}

/**
 * Formatér i én celle: markeringen, eller ordet ved markøren, når intet er markeret (27/10: Ctrl+B
 * på et ord skal gøre hele ordet fedt, som i teksten uden for tabellen). Står markøren ikke i et
 * ord, gør browseren det, den plejer: det næste, der skrives, bliver fedt.
 */
export function formatInCell(cell: HTMLElement, kind: CellFormat): void {
  if (kind === "bold" && cell.tagName === "TH") return;
  const sel = window.getSelection();
  if (sel?.isCollapsed) selectWordAtCaret(cell);
  document.execCommand(kind);
}

/** Udvid en tom markering i cellen til ordet om markøren. Falsk, hvis markøren ikke står i et ord. */
export function selectWordAtCaret(cell: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return false;
  let node = sel.focusNode;
  let offset = sel.focusOffset;
  // Markøren mellem to elementer (lige efter et fedt ord): tekstknuden ved siden af.
  if (node && node.nodeType !== Node.TEXT_NODE) {
    const before = node.childNodes[offset - 1];
    const after = node.childNodes[offset];
    if (before?.nodeType === Node.TEXT_NODE) [node, offset] = [before, before.textContent?.length ?? 0];
    else if (after?.nodeType === Node.TEXT_NODE) [node, offset] = [after, 0];
    else return false;
  }
  if (!node || !cell.contains(node)) return false;
  const { start, end } = wordRangeAt(node.textContent ?? "", offset);
  if (start === end) return false;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

/** Sæt markøren ved et punkt i cellen (højreklik), hvis markeringen ikke allerede står i den. */
export function caretAtPoint(cell: HTMLElement, x: number, y: number): void {
  const sel = window.getSelection();
  if (sel?.rangeCount && !sel.isCollapsed && cell.contains(sel.anchorNode)) return;
  const range = document.caretRangeFromPoint(x, y);
  if (!range || !cell.contains(range.startContainer)) return;
  cell.focus({ preventScroll: true });
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** De markerede celler som tekst med tabulator mellem kolonnerne, så de kan sættes ind i et regneark. */
export function cellsAsText(wrap: HTMLElement): string {
  const rows = new Map<number, string[]>();
  for (const cell of selectedCells(wrap)) {
    const { r } = pos(cell);
    rows.set(r, [...(rows.get(r) ?? []), (cell.innerText ?? "").replace(/\s*\n\s*/g, " ").trim()]);
  }
  return [...rows.values()].map((r) => r.join("\t")).join("\n");
}

/** Står markøren yderst i cellen i retningen? Til Shift+pil, der går videre til næste celle. */
export function caretAtCellEnd(cell: HTMLElement, forward: boolean): boolean {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.focusNode || !cell.contains(sel.focusNode)) return false;
  const range = document.createRange();
  range.selectNodeContents(cell);
  if (forward) range.setStart(sel.focusNode, sel.focusOffset);
  else range.setEnd(sel.focusNode, sel.focusOffset);
  return range.toString().trim() === "";
}
