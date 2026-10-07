// KOPI af gode-ord/src/lib/quotes.ts @ ebee85f 2026-10-07. Ret i Gode Ord, ikke her, og kør scripts/sprog.mjs.
// Citat-detektion (delt helper). Journalister citerer folk ordret – nogle gange NETOP
// for skævt sprog/klichéer. Sprog-lagene (grammatik + klarhed) dæmper derfor forslag inde
// i citater. Regelbaseret + tolerant: citationstegn "…" »…« „…" '…' + blockquote-linjer (>).

export type Range = [number, number]; // [start, endExclusive) i tekst-offset

export function quoteRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const patterns = [
    /"[^"\n]{1,500}"/g, // rette dobbelt-anførsler
    /»[^«\n]{1,500}«/g, // danske vinkelcitat
    /„[^"\n]{1,500}"/g, // typografisk „…"
    /“[^”\n]{1,500}”/g, // engelske krøllede
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  }
  // Blockquote-linjer (markdown citat): fra ">" til linjeskift.
  const bq = /^>.*$/gm;
  let b: RegExpExecArray | null;
  while ((b = bq.exec(text)) !== null) ranges.push([b.index, b.index + b[0].length]);
  return ranges;
}

/** Ligger position (helt eller delvist) inde i et citat? */
export function inQuote(pos: number, ranges: Range[]): boolean {
  return ranges.some(([s, e]) => pos >= s && pos < e);
}
