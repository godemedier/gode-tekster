// Parkeret tekst (fraklip) i selve filen som HTML-kommentarer (ADR-0003, ADR-0008):
//
//   <!-- gt:parkeret id=p1 dato=2026-10-02
//   Teksten, gerne med tomme linjer.
//   -->
//
// Indholdet escapes, så det kan vendes om, og så en kommentar inde i teksten aldrig lukker
// blokken: først `&#45;` → `&amp;#45;`, så `<!--` → `<!-&#45;`, `-->` → `-&#45;>`, `--!>` → `-&#45;!>`.
// Rene funktioner, testet med node --test.

import { todayIso } from "./dates.ts";
import { resolvePending } from "./critic.ts";
import { STATUS_LINE, withoutTagLine } from "./textStatus.ts";
import { commentSpans } from "./textSyntax.ts";

export type Parked = { id: string; date: string; color?: string; text: string; from: number; to: number };

const BLOCK = /^<!-- gt:parkeret id=(\S+) dato=(\S+)(?: farve=(\S+))?[^\n]*\n([\s\S]*?)\n?-->$/;

export function escapeParked(text: string): string {
  return text
    .replace(/&#45;/g, "&amp;#45;")
    .replace(/<!--/g, "<!-&#45;")
    .replace(/--!>/g, "-&#45;!>")
    .replace(/-->/g, "-&#45;>");
}

export function unescapeParked(text: string): string {
  return text
    .replace(/<!-&#45;/g, "<!--")
    .replace(/-&#45;!>/g, "--!>")
    .replace(/-&#45;>/g, "-->")
    .replace(/&amp;#45;/g, "&#45;");
}

export function findParked(doc: string): Parked[] {
  const out: Parked[] = [];
  for (const span of commentSpans(doc)) {
    const m = BLOCK.exec(doc.slice(span.from, span.to));
    if (!m) continue;
    out.push({ id: m[1], date: m[2], color: m[3], text: unescapeParked(m[4]), from: span.from, to: span.to + (doc[span.to] === "\n" ? 1 : 0) });
  }
  return out;
}

export function nextParkedId(doc: string): string {
  let max = 0;
  for (const p of findParked(doc)) {
    const n = Number(p.id.replace(/^p/, ""));
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return `p${max + 1}`;
}

export function parkedBlock(id: string, date: string, text: string, color?: string): string {
  const c = color ? ` farve=${color}` : "";
  return `<!-- gt:parkeret id=${id} dato=${date}${c}\n${escapeParked(text.trim())}\n-->\n`;
}

/** Hvor en ny blok skal stå: sidst i dokumentet, med en tom linje foran. */
export function appendParked(doc: string, block: string): { from: number; insert: string } {
  const lead = doc.length === 0 || doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
  return { from: doc.length, insert: lead + block };
}

/**
 * Ændringerne, der lægger tekster i fraklip sidst i dokumentet, i dokumentets koordinater. Med
 * `remove` tages teksten samtidig ud, hvor den stod (Ctrl+Alt+X, træk til spalten).
 */
export function parkChanges(
  doc: string,
  texts: string[],
  remove?: { from: number; to: number },
  date = todayIso(),
): { from: number; to?: number; insert: string }[] {
  const changes: { from: number; to?: number; insert: string }[] = [];
  let rest = doc;
  if (remove) {
    changes.push({ from: remove.from, to: remove.to, insert: "" });
    rest = doc.slice(0, remove.from) + doc.slice(remove.to);
  }
  let insert = "";
  let n = Number(nextParkedId(doc).slice(1));
  for (const t of texts) insert += appendParked(rest + insert, parkedBlock(`p${n++}`, date, t)).insert;
  changes.push({ from: doc.length, insert });
  return changes;
}

/** Teksten uden parkerede blokke: til ordtal, eksport og sprogmodellen (designprincip 5). */
/**
 * Det, læseren og Claude skal se: uden fraklip, uden Claudes gemte resultater (claudeBlocks.ts),
 * uden noter, uden status og #tags (textStatus.ts), og med rettelser, der ikke er taget stilling til,
 * som den oprindelige tekst (critic.ts).
 */
export function withoutParked(doc: string): string {
  // Status øverst og #tags sidst er etiketter, ikke tekst (ADR-0038).
  const spans = commentSpans(doc).filter((s) => /^<!-- gt:(?:parkeret|claude|maal|farve)\b/.test(doc.slice(s.from, s.to)));
  const pieces: string[] = [];
  let from = 0;
  for (const span of spans) {
    pieces.push(doc.slice(from, span.from));
    from = span.to + (doc[span.to] === "\n" ? 1 : 0);
  }
  pieces.push(doc.slice(from));
  const rest = withoutTagLine(pieces.join("").replace(STATUS_LINE, "$1"));
  return resolvePending(rest).replace(/\n{3,}$/, "\n");
}


/** En fraklipsfil (FRAKLIP.md) delt i stykker ved tomme linjer. Tomme stykker springes over. */
export function splitClippings(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(FRAKLIP|#+\s*FRAKLIP)$/i.test(s));
}

/**
 * Lav til tabel: linjerne bliver rækker, kolonner deles ved tabulator, semikolon eller » | «.
 * Første linje er overskrift. Linjer med færre kolonner fyldes ud.
 */
export function toTable(selection: string): string {
  const lines = selection.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return selection;
  const sep = lines.some((l) => l.includes("\t")) ? "\t" : lines.some((l) => l.includes(";")) ? ";" : lines.some((l) => l.includes(" | ")) ? " | " : null;
  const rows = lines.map((l) => (sep ? l.split(sep) : [l]).map((c) => c.trim().replace(/\|/g, "\\|")));
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  return [line(rows[0]), `|${Array(width).fill("---").join("|")}|`, ...rows.slice(1).map(line)].join("\n");
}

/** Fjern formatering: fed, kursiv, understreget, gennemstreget, kode, dæmpet og links (teksten bliver). */
export function clearFormatting(text: string): string {
  return text
    .replace(/\{--([\s\S]*?)--\}/g, "$1")
    .replace(/<\/?u>/gi, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}
