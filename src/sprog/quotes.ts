// Citat-detektion (delt helper). Journalister citerer folk ordret – nogle gange NETOP
// for skævt sprog/klichéer. Sprog-lagene (grammatik + klarhed) dæmper derfor forslag inde
// i citater. Regelbaseret + tolerant: citationstegn "…" »…« „…" “…” ”…” + blockquote-linjer (>)
// og replikker, der begynder med tankestreg (»– Det er godt, siger hun.«).
//
// Danske medier sætter ofte ”…” med samme tegn i begge ender, og et citat kan godt være flere
// sætninger langt. Begge dele blev ikke genkendt, så citater fik stilfund (målebænken 12/10:
// cirka hvert syvende falske fund stod i et citat).

export type Range = [number, number]; // [start, endExclusive) i tekst-offset

export function quoteRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const patterns = [
    /"[^"”\n]{1,1500}["”]/g, // rette dobbelt-anførsler, også lukket med ”
    /»[^«\n]{1,1500}«/g, // danske vinkelcitat
    /„[^"“”\n]{1,1500}["“”]/g, // typografisk „…" og „…“
    /“[^”"\n]{1,1500}[”"]/g, // engelske krøllede
    // ”…” med samme tegn i begge ender (dansk avistypografi). Uden “ indeni, så teksten mellem to
    // engelske citater (“a” og “b”) ikke tages for et citat.
    /”[^”“"\n]{1,1500}”/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  }
  // Blockquote-linjer (markdown citat): fra ">" til linjeskift.
  const bq = /^>.*$/gm;
  let b: RegExpExecArray | null;
  while ((b = bq.exec(text)) !== null) ranges.push([b.index, b.index + b[0].length]);
  // Replik med tankestreg forrest (ikke bindestreg, som er en markdown-liste): hele linjen.
  const dash = /^[ \t]*–[ \t].*$/gm;
  let d: RegExpExecArray | null;
  while ((d = dash.exec(text)) !== null) ranges.push([d.index, d.index + d[0].length]);
  return ranges;
}

/** Ligger position (helt eller delvist) inde i et citat? */
export function inQuote(pos: number, ranges: Range[]): boolean {
  return ranges.some(([s, e]) => pos >= s && pos < e);
}
