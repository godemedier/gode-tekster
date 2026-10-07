// Ordnede lister med bogstaver og romertal (5/10): »a.«, »a)«, »A.«, »i.« ud over markdowns
// egne »1.« og »1)«. Markdown kender dem ikke, så uden hjælp blev linjerne til ét afsnit i udskrift
// og Word. Reglerne her deles af skrivefladen (lists.ts), print (render.ts) og Word (word.ts).
//
// En række tæller som liste, når første punkt er a, A, i eller I, og de næste følger i rækkefølge.
// Så bliver »I. P. Møller …« eller »A. Jensen sagde« ikke til en liste ved et uheld.

export type FancyType = "a" | "A" | "i" | "I";
export type FancyItem = { type: FancyType; index: number; delim: "." | ")"; text: string; markerEnd: number };

const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"];
const ITEM = /^(\s*)([a-z]|[A-Z]|[ivx]+|[IVX]+)([.)])[ \t]+(.*)$/;

/** Punktet på en linje, hvis den ligner et: type, nummer (0 = første) og afgrænser. */
export function parseItem(line: string, prefer?: FancyType): FancyItem | null {
  const m = ITEM.exec(line);
  if (!m) return null;
  const [, indent, marker, delim, text] = m;
  const markerEnd = indent.length + marker.length + 1;
  const roman = ROMAN.indexOf(marker.toLowerCase());
  // Et enkelt i/I er romertallet 1, når der ikke er en bogstavliste i gang (i en a-liste er det det 9. punkt).
  const asRoman = roman >= 0 && (marker.length > 1 || prefer === "i" || prefer === "I" || (!prefer && roman === 0));
  if (asRoman) return { type: marker === marker.toLowerCase() ? "i" : "I", index: roman, delim: delim as "." | ")", text, markerEnd };
  if (marker.length !== 1) return null;
  const lower = marker.toLowerCase();
  return { type: marker === lower ? "a" : "A", index: lower.charCodeAt(0) - 97, delim: delim as "." | ")", text, markerEnd };
}

/** Markøren for punkt nummer `index` (0 = a/A/i/I). */
export function marker(type: FancyType, index: number, delim: "." | ")"): string {
  const m = type === "a" ? String.fromCharCode(97 + (index % 26)) : type === "A" ? String.fromCharCode(65 + (index % 26)) : type === "i" ? ROMAN[index] ?? String(index + 1) : (ROMAN[index] ?? String(index + 1)).toUpperCase();
  return `${m}${delim}`;
}

/** En linje, der ville gøre afsnittet over sig til en overskrift: kun »-« eller kun »=«. */
export function isSetextUnderline(line: string): boolean {
  return /^ {0,3}(-+|=+)[ \t]*$/.test(line);
}

/**
 * Linjerne som én liste, eller null. Mindst to punkter, første er nummer 0, og hvert næste følger
 * lige efter med samme type og afgrænser. Én linje alene (»A. P. Møller købte …«) er ikke en liste.
 */
export function fancyRun(lines: string[]): FancyItem[] | null {
  if (lines.length < 2) return null;
  const first = parseItem(lines[0]);
  if (!first || first.index !== 0) return null;
  const items = [first];
  for (const line of lines.slice(1)) {
    const it = parseItem(line, first.type);
    const prev = items[items.length - 1];
    if (!it || it.type !== first.type || it.delim !== first.delim || it.index !== prev.index + 1) return null;
    items.push(it);
  }
  return items;
}
