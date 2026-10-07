// Rene funktioner til det, markdown-parseren ikke kender: dæmpet tekst og fodnotehenvisninger.
// Holdt fri af CodeMirror, så de kan testes med node --test.

export type Found = { from: number; to: number };

/** `{--tekst--}` (ADR-0008), også over flere linjer og afsnit. Positionerne er relative til teksten. */
export function findDimmed(line: string): { open: Found; body: Found; close: Found }[] {
  const out: { open: Found; body: Found; close: Found }[] = [];
  const re = /\{--([\s\S]*?)--\}/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const from = m.index;
    const to = from + m[0].length;
    out.push({
      open: { from, to: from + 3 },
      body: { from: from + 3, to: to - 3 },
      close: { from: to - 3, to },
    });
  }
  return out;
}

/** Fodnotehenvisninger `[^etiket]` i en linje. En definition (`[^1]: …` i starten) tæller ikke. */
export function findFootnoteRefs(line: string): { ref: Found; label: string }[] {
  const out: { ref: Found; label: string }[] = [];
  const re = /\[\^([^\]\s]+)\]/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const isDefinition = m.index === 0 && line[m[0].length] === ":";
    if (!isDefinition) out.push({ ref: { from: m.index, to: m.index + m[0].length }, label: m[1] });
  }
  return out;
}

/** En fodnotedefinition i starten af en linje: `[^etiket]: tekst` (ADR-0017). Ét mønster til hele fladen. */
export const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:\s?(.*)$/;

/** Linjen med definitionen af en etiket, eller null. Positionerne er i hele teksten. */
export function footnoteDefinition(doc: string, label: string): { from: number; to: number; text: string } | null {
  let pos = 0;
  for (const line of doc.split("\n")) {
    const m = FOOTNOTE_DEF.exec(line);
    if (m && m[1] === label) return { from: pos, to: pos + line.length, text: m[2] };
    pos += line.length + 1;
  }
  return null;
}

/** Den første henvisning til en etiket (ikke definitionen). Positionerne er i hele teksten. */
export function footnoteRef(doc: string, label: string): Found | null {
  let pos = 0;
  for (const line of doc.split("\n")) {
    const hit = findFootnoteRefs(line).find((r) => r.label === label);
    if (hit) return { from: pos + hit.ref.from, to: pos + hit.ref.to };
    pos += line.length + 1;
  }
  return null;
}

/** Visningsnummer pr. etiket i den rækkefølge, henvisningerne står i teksten (ADR-0017). */
export function footnoteNumbers(doc: string): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const line of doc.split("\n")) {
    for (const { label } of findFootnoteRefs(line)) {
      if (!numbers.has(label)) numbers.set(label, numbers.size + 1);
    }
  }
  return numbers;
}
