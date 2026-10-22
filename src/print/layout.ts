// Sidens opsætning (side-designeren, 9/10): hvad der står i sidehoved og sidefod, margener, skrift og
// titel. Ren logik uden DOM, så print (render.ts `pageCss`), Word (word.ts) og designeren
// (designer.ts) bruger de samme regler. Standardopsætningen giver præcis det samme som før designeren:
// forfatter og dato øverst i midten, anslag og ord nederst på første side, sidetal nederst fra side 2.

export type Template = "manuskript" | "laeseudgave";

export type Margins = { top: number; right: number; bottom: number; left: number };

/** Margener i cm, som skabelonens `@page` (og PDF-kaldet i Rust). */
export const MARGINS: Record<Template, Margins> = {
  manuskript: { top: 3.5, right: 4.5, bottom: 4.5, left: 4.5 },
  laeseudgave: { top: 2.5, right: 4, bottom: 4, left: 4 },
};

/** Pladserne svarer til `@page`-margenboksene med samme navn. */
export type Slot = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
export const SLOTS: readonly Slot[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];
/** En plads på siden, eller titlen (tekstens egen overskrift), som kun Titel-brikken passer i. */
export type Target = Slot | "title";

export type PieceKind = "author" | "date" | "title" | "pageNumber" | "counts" | "text";
export const PIECE_KINDS: readonly PieceKind[] = ["author", "date", "title", "pageNumber", "counts", "text"];
export type Piece = { kind: PieceKind; text?: string };
export type SlotMap = Partial<Record<Slot, Piece[]>>;

/** Skriften: »Som på skærmen« er editorens skrift. */
export type PageFont = "skaerm" | "newsreader" | "grotesk";
export const PAGE_FONTS: readonly PageFont[] = ["skaerm", "newsreader", "grotesk"];

export type PageLayout = {
  margins: Margins;
  font: PageFont;
  /** Tekstens egen overskrift øverst i teksten. */
  title: boolean;
  /** Første side har sine egne pladser (`first`). Ellers gælder `pages` for alle sider. */
  firstDifferent: boolean;
  pages: SlotMap;
  first: SlotMap;
};

export type SavedTemplate = { name: string; base: Template; layout: PageLayout };

/** Hvilke pladser der redigeres: første side eller alle de andre. */
export type PageView = "first" | "pages";

/** Skabelonens egen skrift. En anden skrift er et valg i designeren. */
export function nativeFont(t: Template): PageFont {
  return t === "laeseudgave" ? "newsreader" : "skaerm";
}

export function defaultLayout(t: Template): PageLayout {
  const head: Piece[] = [{ kind: "author" }, { kind: "date" }];
  return {
    margins: { ...MARGINS[t] },
    font: nativeFont(t),
    title: true,
    firstDifferent: true,
    pages: { "top-center": head, "bottom-center": [{ kind: "pageNumber" }] },
    first: { "top-center": head.map((p) => ({ ...p })), "bottom-center": [{ kind: "counts" }] },
  };
}

export function cloneLayout(l: PageLayout): PageLayout {
  return JSON.parse(JSON.stringify(l)) as PageLayout;
}

/** Pladserne på første side eller de andre sider. */
export function slotsFor(l: PageLayout, firstPage: boolean): SlotMap {
  return l.firstDifferent && firstPage ? l.first : l.pages;
}

/** Det, »Indhold« har valgt fra, kommer ikke med, uanset hvor det står (render.ts PrintOptions). */
export type ContentFilter = { byline?: boolean; counts?: boolean; pageNumbers?: boolean };

export function pieceOn(p: Piece, f: ContentFilter): boolean {
  if (p.kind === "author" || p.kind === "date") return f.byline !== false;
  if (p.kind === "counts") return f.counts !== false;
  if (p.kind === "pageNumber") return f.pageNumbers !== false;
  return true;
}

/** Det, en brik viser. Teksterne kommer fra render.ts `Meta`. */
export type PieceValues = { author: string; date: string; title: string; countLine: string };

/** Sidetallet som del af en plads (CSS `counter(page)`, Words PAGE-felt). */
export const PAGE = { page: true } as const;
export type Part = string | typeof PAGE;

/**
 * En plads som tekst og sidetal i rækkefølge, med » · « imellem, som sidehovedet altid har stået.
 * Tekst ved siden af tekst slås sammen, så standarden giver én streng: »Kim Skribent · 2. oktober 2026«.
 */
export function slotParts(pieces: readonly Piece[] | undefined, v: PieceValues, f: ContentFilter = {}): Part[] {
  const items: { kind: PieceKind; value: Part }[] = [];
  for (const p of pieces ?? []) {
    if (!pieceOn(p, f)) continue;
    const value = p.kind === "pageNumber" ? PAGE : valueOf(p, v);
    if (value !== "") items.push({ kind: p.kind, value });
  }
  const out: Part[] = [];
  items.forEach(({ kind, value }, i) => {
    // Egen tekst lige før sidetallet er en etiket: »Side 3«, ikke »Side · 3«.
    const sep = i > 0 && items[i - 1].kind === "text" && kind === "pageNumber" ? " " : " · ";
    const parts: Part[] = i === 0 ? [value] : [sep, value];
    for (const part of parts) {
      const last = out[out.length - 1];
      if (typeof part === "string" && typeof last === "string") out[out.length - 1] = last + part;
      else out.push(part);
    }
  });
  return out;
}

function valueOf(p: Piece, v: PieceValues): string {
  switch (p.kind) {
    case "author":
      return v.author;
    case "date":
      return v.date;
    case "title":
      return v.title;
    case "counts":
      return v.countLine;
    case "text":
      return (p.text ?? "").trim();
    default:
      return "";
  }
}

/** Én række i Words sidehoved eller sidefod: venstre, midte og højre. */
export type Row = { left: Part[]; center: Part[]; right: Part[] };
export type PageRows = { header: Row; footer: Row };

function row(map: SlotMap, edge: "top" | "bottom", v: PieceValues, f: ContentFilter): Row {
  return {
    left: slotParts(map[`${edge}-left`], v, f),
    center: slotParts(map[`${edge}-center`], v, f),
    right: slotParts(map[`${edge}-right`], v, f),
  };
}

/** Sidehoved og sidefod til Word: første side for sig og de andre sider. */
export function pageRows(l: PageLayout, v: PieceValues, f: ContentFilter = {}): { first: PageRows; pages: PageRows } {
  const of = (map: SlotMap) => ({ header: row(map, "top", v, f), footer: row(map, "bottom", v, f) });
  return { first: of(slotsFor(l, true)), pages: of(l.pages) };
}

export function rowEmpty(r: Row): boolean {
  return !r.left.length && !r.center.length && !r.right.length;
}

// --- flyt, læg og fjern brikker (designeren) ------------------------------------------------

export type From = { view: PageView; target: Target; index: number };

/** Flyt en brik til en plads (eller titlen). `from` er der, hvor den stod, når den ikke kom fra listen. */
export function place(l: PageLayout, view: PageView, piece: Piece, target: Target, from?: From): PageLayout {
  if (target === "title" && piece.kind !== "title") return l;
  if (from && from.view === view && from.target === target) return l;
  let out = from ? remove(l, from) : cloneLayout(l);
  if (target === "title") return { ...out, title: true };
  out = cloneLayout(out);
  const list = out[view][target] ?? [];
  // Samme brik to gange på én plads giver ingen mening. Egen tekst må gerne.
  if (piece.kind === "text" ? !(piece.text ?? "").trim() : list.some((p) => p.kind === piece.kind)) return out;
  out[view][target] = [...list, piece.kind === "text" ? { kind: "text", text: (piece.text ?? "").trim() } : { kind: piece.kind }];
  return out;
}

export function remove(l: PageLayout, from: From): PageLayout {
  if (from.target === "title") return { ...cloneLayout(l), title: false };
  const out = cloneLayout(l);
  const list = out[from.view][from.target] ?? [];
  list.splice(from.index, 1);
  if (list.length) out[from.view][from.target] = list;
  else delete out[from.view][from.target];
  return out;
}

/** »Første side anderledes« slået til: start fra de andre siders pladser, hvis første side er tom. */
export function withFirstDifferent(l: PageLayout, on: boolean): PageLayout {
  const out = cloneLayout(l);
  out.firstDifferent = on;
  if (on && !Object.values(out.first).some((list) => list && list.length)) out.first = cloneLayout(l).pages;
  return out;
}

/** Er brikken lagt et sted på den side, der redigeres (fluebenet i listen)? */
export function placed(l: PageLayout, view: PageView, kind: PieceKind): boolean {
  // Titlen øverst i teksten står kun på første side.
  if (kind === "title" && l.title && (view === "first" || !l.firstDifferent)) return true;
  return Object.values(l[view]).some((list) => list?.some((p) => p.kind === kind));
}

// --- tastaturet: piletaster mellem pladserne ------------------------------------------------

const GRID: Target[][] = [["top-left", "top-center", "top-right"], ["title"], ["bottom-left", "bottom-center", "bottom-right"]];

/** Næste plads i pilens retning. Titlen springes over, når den ikke kan tage brikken. */
export function nextTarget(current: Target, key: string, withTitle: boolean): Target {
  const rows = withTitle ? GRID : GRID.filter((r) => r[0] !== "title");
  let r = rows.findIndex((cells) => cells.includes(current));
  if (r < 0) r = 0;
  const cells = rows[r];
  const c = Math.max(0, cells.indexOf(current));
  if (key === "ArrowLeft") return cells[Math.max(0, c - 1)];
  if (key === "ArrowRight") return cells[Math.min(cells.length - 1, c + 1)];
  if (key === "ArrowUp" || key === "ArrowDown") {
    const next = rows[Math.max(0, Math.min(rows.length - 1, r + (key === "ArrowUp" ? -1 : 1)))];
    // Fra en række med tre til titlen og tilbage: midten.
    const col = cells.length === next.length ? c : next.length === 1 ? 0 : 1;
    return next[col];
  }
  return current;
}

// --- tal og gemte værdier -----------------------------------------------------------------

/** »3,5«, »3.5« og »3,5 cm« → 3.5. Uden for grænserne eller ikke et tal: null. */
export function parseCm(s: string, min: number, max: number): number | null {
  const n = Number(s.replace(/cm/i, "").trim().replace(",", "."));
  if (!s.trim() || !Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 10) / 10;
}

/** Grænserne for margener i cm. Siderne skal have plads til udfaldet (render.ts UDFALD). */
export const MARGIN_LIMITS: Record<keyof Margins, [number, number]> = {
  top: [1, 8],
  bottom: [1, 8],
  left: [2.5, 8],
  right: [2.5, 8],
};

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function slotMapFrom(x: unknown): SlotMap {
  const out: SlotMap = {};
  if (!isObj(x)) return out;
  for (const slot of SLOTS) {
    const list = x[slot];
    if (!Array.isArray(list)) continue;
    const pieces = list
      .filter(isObj)
      .filter((p) => PIECE_KINDS.includes(p.kind as PieceKind))
      .map((p): Piece => (p.kind === "text" ? { kind: "text", text: String(p.text ?? "").slice(0, 200) } : { kind: p.kind as PieceKind }));
    if (pieces.length) out[slot] = pieces;
  }
  return out;
}

/** En gemt opsætning fra localStorage, tjekket felt for felt. Det, der mangler, tages fra skabelonen. */
export function layoutFrom(x: unknown, t: Template): PageLayout {
  const d = defaultLayout(t);
  if (!isObj(x)) return d;
  const m = isObj(x.margins) ? x.margins : {};
  const margins = { ...d.margins };
  for (const k of Object.keys(MARGIN_LIMITS) as (keyof Margins)[]) {
    const [min, max] = MARGIN_LIMITS[k];
    const n = Number(m[k]);
    if (Number.isFinite(n) && n >= min && n <= max) margins[k] = n;
  }
  return {
    margins,
    font: PAGE_FONTS.includes(x.font as PageFont) ? (x.font as PageFont) : d.font,
    title: x.title !== false,
    firstDifferent: x.firstDifferent === true,
    pages: isObj(x.pages) ? slotMapFrom(x.pages) : d.pages,
    first: isObj(x.first) ? slotMapFrom(x.first) : d.first,
  };
}

export function templatesFrom(x: unknown): SavedTemplate[] {
  if (!Array.isArray(x)) return [];
  const out: SavedTemplate[] = [];
  for (const t of x) {
    if (!isObj(t) || typeof t.name !== "string" || !t.name.trim()) continue;
    const base: Template = t.base === "laeseudgave" ? "laeseudgave" : "manuskript";
    if (out.some((o) => o.name === t.name)) continue;
    out.push({ name: t.name.trim().slice(0, 40), base, layout: layoutFrom(t.layout, base) });
  }
  return out;
}

/** Gem under et navn. Et navn, der findes, bliver overskrevet. */
export function withTemplate(list: readonly SavedTemplate[], t: SavedTemplate): SavedTemplate[] {
  const i = list.findIndex((o) => o.name === t.name);
  const copy = { ...t, layout: cloneLayout(t.layout) };
  return i < 0 ? [...list, copy] : list.map((o, j) => (j === i ? copy : o));
}
