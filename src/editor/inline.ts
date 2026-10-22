// Rene funktioner til det, markdown-parseren ikke kender: dæmpet tekst og fodnotehenvisninger.
// Holdt fri af CodeMirror, så de kan testes med node --test.

import { codeSpans, commentSpans, maskSpans } from "./textSyntax.ts";

export type Found = { from: number; to: number };

export const footnoteText = (doc: string): string => maskSpans(doc, [...codeSpans(doc), ...commentSpans(doc)]);

/** `{--tekst--}` (ADR-0008), også over flere linjer og afsnit. Positionerne er relative til teksten. */
export function findDimmed(line: string): { open: Found; body: Found; close: Found }[] {
  const out: { open: Found; body: Found; close: Found }[] = [];
  let from = -1;
  const text = maskSpans(line, [...codeSpans(line), ...commentSpans(line)]);
  for (const m of text.matchAll(/\{--|--\}/g)) {
    if (m[0] === "{--") { from = m.index; continue; }
    if (from === -1) continue;
    const to = m.index + 3;
    out.push({
      open: { from, to: from + 3 },
      body: { from: from + 3, to: to - 3 },
      close: { from: to - 3, to },
    });
    from = -1;
  }
  return out;
}

export function resolveDimmed(doc: string, include: boolean): string {
  const out: string[] = [];
  let from = 0;
  for (const d of findDimmed(doc)) {
    out.push(doc.slice(from, d.open.from), include ? doc.slice(d.body.from, d.body.to) : "");
    from = d.close.to;
  }
  out.push(doc.slice(from));
  return out.join("");
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

export type FootnoteDef = { from: number; to: number; text: string };

/**
 * Alle definitioner i ét gennemløb, etiket → den første definition. Fanen Fodnoter slog før op
 * pr. fodnote, og hvert opslag maskerede hele teksten: 200 fodnoter i en bog gav 200 gennemløb
 * (kodegennemgang 20/10).
 */
export function footnoteDefinitions(doc: string): Map<string, FootnoteDef> {
  const out = new Map<string, FootnoteDef>();
  let pos = 0;
  for (const line of footnoteText(doc).split("\n")) {
    const m = FOOTNOTE_DEF.exec(line);
    if (m && !out.has(m[1])) {
      out.set(m[1], { from: pos, to: pos + line.length, text: FOOTNOTE_DEF.exec(doc.slice(pos, pos + line.length))?.[2] ?? m[2] });
    }
    pos += line.length + 1;
  }
  return out;
}

/** Linjen med definitionen af en etiket, eller null. Positionerne er i hele teksten. */
export function footnoteDefinition(doc: string, label: string): FootnoteDef | null {
  return footnoteDefinitions(doc).get(label) ?? null;
}

/**
 * Ændringen, der giver etiketten teksten som fodnote: definitionen rettes, eller den lægges til
 * før `end` (fraklippene, ellers tekstens slutning). Noten er én linje (ADR-0017).
 */
export function footnoteEdit(doc: string, label: string, text: string, end: number): { from: number; to: number; insert: string } {
  const clean = text.replace(/\n+/g, " ").trim();
  const def = footnoteDefinition(doc, label);
  if (def) return { from: def.from, to: def.to, insert: `[^${label}]: ${clean}` };
  const lead = doc.slice(0, end).endsWith("\n\n") ? "" : "\n\n";
  return { from: end, to: end, insert: `${lead}[^${label}]: ${clean}\n` };
}

/** Den første henvisning til en etiket (ikke definitionen). Positionerne er i hele teksten. */
export function footnoteRef(doc: string, label: string): Found | null {
  let pos = 0;
  for (const line of footnoteText(doc).split("\n")) {
    const hit = findFootnoteRefs(line).find((r) => r.label === label);
    if (hit) return { from: pos + hit.ref.from, to: pos + hit.ref.to };
    pos += line.length + 1;
  }
  return null;
}

/** Visningsnummer pr. etiket i den rækkefølge, henvisningerne står i teksten (ADR-0017). */
export function footnoteNumbers(doc: string): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const line of footnoteText(doc).split("\n")) {
    for (const { label } of findFootnoteRefs(line)) {
      if (!numbers.has(label)) numbers.set(label, numbers.size + 1);
    }
  }
  return numbers;
}

export type FootnoteSource = { label: string; n: number; text: string; url: string | null };

/** Første webadresse i en fodnote: målet i `[titel](adresse)`, ellers en løs adresse uden tegnsætningen efter. */
export function footnoteUrl(text: string): string | null {
  const link = /\]\((https?:\/\/[^\s)]+)\)/.exec(text);
  if (link) return link[1];
  const bare = /https?:\/\/[^\s<>»«"]+/.exec(text);
  return bare ? bare[0].replace(/[).,;:!?]+$/, "") : null;
}

/**
 * Fodnoterne, der er kilder (fanen Kilder, 21/10): dem med en webadresse eller en henvisning `[@nøgle]`,
 * som faktatjek og research skriver dem. Resten er kommentarer og bliver under Fodnoter. Intet ændres i filen.
 */
export function footnoteSources(doc: string): FootnoteSource[] {
  const defs = footnoteDefinitions(doc);
  const out: FootnoteSource[] = [];
  for (const [label, n] of footnoteNumbers(doc)) {
    const text = defs.get(label)?.text.trim() ?? "";
    const url = footnoteUrl(text);
    if (url || /\[[^\]]*@[\p{L}\p{N}_]/u.test(text)) out.push({ label, n, text, url });
  }
  return out;
}
