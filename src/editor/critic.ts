// CriticMarkup ud over dæmpet tekst (valgt efter research 2/10): noter til mig selv og rettelser,
// der godtages eller afvises ét ad gangen. Samme åbne standard som {--dæmpet--} (ADR-0008):
//
//   {>> tjek tal hos DST <<}          note: tæller ikke, kommer ikke med ud
//   {++ny tekst++}                     forslag om at indsætte
//   {~~gammel tekst~>ny tekst~~}       forslag om at erstatte (tom ny tekst = slette)
//
// Ren sletning skrives som erstatning med tom ny tekst, fordi {--…--} allerede betyder »dæmpet«.
// En rettelse, der ikke er taget stilling til, tæller som den oprindelige tekst: i ordtal, print,
// Word og det, der sendes til Claude. Rene funktioner, testet med node --test.

/** En note. `open`/`close` er mærkernes længde: 3 og 3 for {>> <<}, 4 og 3 for <!-- -->. */
import { codeSpans, commentSpans, maskSpans } from "./textSyntax.ts";

export type Note = { from: number; to: number; text: string; open: number; close: number };
export type Revision = {
  kind: "ins" | "sub";
  from: number;
  to: number;
  /** Den oprindelige tekst (tom ved indsættelse). */
  old: string;
  /** Den foreslåede tekst (tom ved sletning). */
  next: string;
  /** Hvor den gamle og den nye tekst står inde i markeringen. */
  oldFrom: number;
  nextFrom: number;
};
export type Change = { from: number; to?: number; insert: string };

/**
 * Noter skrives som HTML-kommentarer fra 5/10: den mest udbredte måde, skjult i alle
 * markdown-programmer, på nettet, i iA Writer, print og Word. `{>> … <<}` læses stadig. Programmets
 * egne skjulte blokke (`<!-- gt:… -->`) er ikke noter.
 */
function marks(doc: string): { from: number; to: number; kind: string; separator: number }[] {
  const text = maskSpans(doc, [...codeSpans(doc), ...commentSpans(doc)]);
  const out: ReturnType<typeof marks> = [];
  let pending: { from: number; kind: string; separator: number } | null = null;
  for (const m of text.matchAll(/\{\+\+|\{~~|\{>>|\+\+\}|~~\}|<<\}|~>/g)) {
    const token = m[0];
    if (token.startsWith("{")) pending = { from: m.index, kind: token, separator: -1 };
    else if (token === "~>" && pending?.kind === "{~~" && pending.separator === -1) pending.separator = m.index;
    else if (pending && ((pending.kind === "{++" && token === "++}") || (pending.kind === "{>>" && token === "<<}") || (pending.kind === "{~~" && token === "~~}"))) {
      if (pending.kind !== "{~~" || pending.separator !== -1) out.push({ ...pending, to: m.index + 3 });
      pending = null;
    }
  }
  return out;
}

export function findNotes(doc: string): Note[] {
  const critic = marks(doc).filter((m) => m.kind === "{>>").map((m) => ({ from: m.from, to: m.to, text: doc.slice(m.from + 3, m.to - 3).trim(), open: 3, close: 3 }));
  const html = commentSpans(doc).filter((m) => !/^\s*gt:/.test(doc.slice(m.from + 4, m.to - 3))).map((m) => ({ ...m, text: doc.slice(m.from + 4, m.to - 3).trim(), open: 4, close: 3 }));
  return [...critic, ...html].sort((a, b) => a.from - b.from);
}

export function findRevisions(doc: string): Revision[] {
  const out: Revision[] = [];
  for (const m of marks(doc)) {
    const { from, to } = m;
    if (m.kind === "{++") out.push({ kind: "ins", from, to, old: "", next: doc.slice(from + 3, to - 3), oldFrom: from + 3, nextFrom: from + 3 });
    if (m.kind === "{~~") out.push({ kind: "sub", from, to, old: doc.slice(from + 3, m.separator), next: doc.slice(m.separator + 2, to - 3), oldFrom: from + 3, nextFrom: m.separator + 2 });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Teksten, som den står, før rettelserne er godtaget, og uden noter. */
export function resolvePending(md: string): string {
  const changes = findRevisions(md).map((r) => ({ from: r.from, to: r.to, insert: resolvePending(r.old) }));
  changes.push(...findNotes(md).map((n) => ({ from: n.from > 0 && /[ \t]/.test(md[n.from - 1]) ? n.from - 1 : n.from, to: n.to, insert: "" })));
  const out: string[] = [];
  let from = 0;
  for (const change of changes.sort((a, b) => a.from - b.from)) {
    if (change.from < from) continue;
    out.push(md.slice(from, change.from), change.insert);
    from = change.to;
  }
  out.push(md.slice(from));
  return out.join("");
}

/** Godtag: kun mærkerne fjernes, så den nye teksts forfatterskab bliver stående. */
export function acceptChanges(r: Revision): Change[] {
  if (r.kind === "ins") return [{ from: r.from, to: r.from + 3, insert: "" }, { from: r.to - 3, to: r.to, insert: "" }];
  return [{ from: r.from, to: r.nextFrom, insert: "" }, { from: r.to - 3, to: r.to, insert: "" }];
}

/** Afvis: forslaget og mærkerne fjernes, den gamle tekst bliver stående. */
export function rejectChanges(r: Revision): Change[] {
  if (r.kind === "ins") return [{ from: r.from, to: r.to, insert: "" }];
  return [{ from: r.from, to: r.oldFrom, insert: "" }, { from: r.oldFrom + r.old.length, to: r.to, insert: "" }];
}

/**
 * Forskellen fra en tidligere udgave vist som rettelser i den nuværende tekst. `edits` er ændringerne
 * fra den gamle til den nuværende tekst i den gamles koordinater. Der indsættes kun mærker omkring
 * den nuværende tekst, så den og dens forfatterskab ikke røres. Godtag beholder det nuværende,
 * afvis går tilbage til den gamle udgave.
 */
export function markupFor(
  edits: { from: number; to: number; insert: string }[],
  old: string,
  skip: (at: number, length: number) => boolean = () => false,
): Change[] {
  const out: Change[] = [];
  let shift = 0;
  for (const e of edits) {
    const at = e.from + shift;
    const removed = old.slice(e.from, e.to);
    if (skip(at, e.insert.length)) {
      // Forskydningen tælles stadig med, så de næste rettelser står rigtigt.
    } else if (!removed) {
      out.push({ from: at, insert: "{++" }, { from: at + e.insert.length, insert: "++}" });
    } else {
      out.push({ from: at, insert: `{~~${removed}~>` }, { from: at + e.insert.length, insert: "~~}" });
    }
    shift += e.insert.length - (e.to - e.from);
  }
  return out;
}

/** Anvend ændringer i samme koordinater (bagfra), som CodeMirror gør det samlet. */
export function apply(doc: string, changes: Change[]): string {
  let out = doc;
  for (const c of [...changes].sort((a, b) => b.from - a.from || (b.to ?? b.from) - (a.to ?? a.from))) {
    out = out.slice(0, c.from) + c.insert + out.slice(c.to ?? c.from);
  }
  return out;
}

/**
 * Rettelser skrevet ind i den gamle tekst (redaktørens Word-fil): hver ændring fra `old` til den
 * nye udgave bliver {++…++} eller {~~gammel~>ny~~}. `edits` er i den gamles koordinater.
 */
export function withRevisions(old: string, edits: { from: number; to: number; insert: string }[]): string {
  let out = "";
  let pos = 0;
  for (const e of edits) {
    out += old.slice(pos, e.from);
    const removed = old.slice(e.from, e.to);
    out += removed ? `{~~${removed}~>${e.insert}~~}` : `{++${e.insert}++}`;
    pos = e.to;
  }
  return out + old.slice(pos);
}
