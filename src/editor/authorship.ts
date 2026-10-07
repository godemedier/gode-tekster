// Forfatterskab i editoren (ADR-0009): hvem skrev hvilke tegn. Intervallerne er UTF-16-offsets,
// som CodeMirror bruger, og flyttes med hver rettelse. Rust konverterer til grafemer ved gem.
//
// Regler:
// - Tastet tekst er skribentens. Skrives der oven i AI-tekst, bliver de nye tegn skribentens.
// - Indsat tekst (Ctrl+V) får ingen forfatter, men markeres »indsat« i en rolig farve, indtil
//   skribenten vælger »Markér som mit« eller »Markér som AI«. Ctrl+Alt+V indsætter som AI.
// - Trukket eller fortrudt tekst får ingen forfatter (et hul = »ukendt« i iA's format). Hellere
//   ukendt end fejlagtigt hans.
// - »Indsat« og »rettet udefra« gemmes ikke i filen. De er kun visning i denne session.

import { StateEffect, StateField, type ChangeDesc, type Transaction } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";

export type Kind = "human" | "ai" | "reference";
export type Author = { kind: Kind; name: string; identifier: string | null };
export type Span = { start: number; end: number };
export type Authorship = { author: Author; spans: Span[] };
export type AuthorshipState = {
  authors: Authorship[];
  me: Author;
  /** Indsat tekst, skribenten endnu ikke har taget stilling til. */
  pasted: Span[];
  /** Tekst, der er kommet udefra siden programmets seneste version (stribe). */
  external: Span[];
};

export const CLAUDE: Author = { kind: "ai", name: "Claude", identifier: null };
/** »Markér som andres« (2/10): citater og tekst fra kilder. iA's format kalder det reference. */
export const OTHERS: Author = { kind: "reference", name: "Andres tekst", identifier: null };
export type Who = "me" | "ai" | "others";

export function sameAuthor(a: Author, b: Author): boolean {
  return a.kind === b.kind && a.name === b.name && a.identifier === b.identifier;
}

/** Flytter intervaller gennem en rettelse. Tekst sat ind lige ved en kant kommer ikke med. */
export function mapSpans(spans: Span[], changes: ChangeDesc): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const start = changes.mapPos(s.start, 1);
    const end = changes.mapPos(s.end, -1);
    if (end > start) out.push({ start, end });
  }
  return out;
}

/** Fjerner `cut` fra intervallerne og deler dem, hvor det er nødvendigt. */
export function subtract(spans: Span[], cut: Span): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    if (s.end <= cut.start || s.start >= cut.end) {
      out.push(s);
      continue;
    }
    if (s.start < cut.start) out.push({ start: s.start, end: cut.start });
    if (s.end > cut.end) out.push({ start: cut.end, end: s.end });
  }
  return out;
}

/** Tilføjer et interval og slår overlappende eller tilstødende sammen. */
export function addSpan(spans: Span[], add: Span): Span[] {
  const all = [...spans, add].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Hvordan en indsættelse tilskrives. */
export type InsertKind = "typed" | "pasted" | "ai" | "external" | "unknown";

function giveTo(authors: Authorship[], who: Author, span: Span): Authorship[] {
  let target = authors.find((a) => sameAuthor(a.author, who));
  if (!target) {
    target = { author: who, spans: [] };
    authors = [...authors, target];
  }
  target.spans = addSpan(target.spans, span);
  return authors;
}

/** Det nye forfatterskab efter en transaktion. Ren funktion, så den kan testes uden en editor. */
export function applyChanges(value: AuthorshipState, changes: ChangeDesc, kind: InsertKind, inserted: Span[]): AuthorshipState {
  let authors = value.authors.map((a) => ({ author: a.author, spans: mapSpans(a.spans, changes) }));
  let pasted = mapSpans(value.pasted, changes);
  let external = mapSpans(value.external, changes);
  for (const cut of inserted) {
    authors = authors.map((a) => ({ author: a.author, spans: subtract(a.spans, cut) }));
    pasted = subtract(pasted, cut);
    external = subtract(external, cut);
    if (kind === "typed") authors = giveTo(authors, value.me, cut);
    if (kind === "ai") authors = giveTo(authors, CLAUDE, cut);
    if (kind === "pasted") pasted = addSpan(pasted, cut);
    // Rettet udefra, mens filen var åben: Claudes tekst, med stribe (ADR-0009).
    if (kind === "external") {
      authors = giveTo(authors, CLAUDE, cut);
      external = addSpan(external, cut);
    }
  }
  return { authors: authors.filter((a) => a.spans.length > 0), me: value.me, pasted, external };
}

/** »Markér som mit«, »Markér som AI« eller »Markér som andres« på en markering. */
export function assign(value: AuthorshipState, range: Span, who: Who): AuthorshipState {
  let authors = value.authors.map((a) => ({ author: a.author, spans: subtract(a.spans, range) }));
  authors = giveTo(authors, who === "me" ? value.me : who === "ai" ? CLAUDE : OTHERS, range);
  return {
    authors: authors.filter((a) => a.spans.length > 0),
    me: value.me,
    pasted: subtract(value.pasted, range),
    external: subtract(value.external, range),
  };
}

export const setAuthorship = StateEffect.define<AuthorshipState>();
export const assignAuthorship = StateEffect.define<{ range: Span; who: Who }>();

/** Ctrl+Alt+V sætter flaget, og den næste indsættelse tilskrives AI. */
let nextPasteIsAi = false;
export function pasteAsAiNext(): void {
  nextPasteIsAi = true;
}

function kindOf(tr: Transaction): InsertKind {
  if (tr.isUserEvent("input.paste")) {
    const ai = nextPasteIsAi;
    nextPasteIsAi = false;
    return ai ? "ai" : "pasted";
  }
  if (tr.isUserEvent("input.external")) return "external";
  // Fodnoter og fraklip fra Claudes research (ADR-0017).
  if (tr.isUserEvent("input.ai")) return "ai";
  if (tr.isUserEvent("input.drop") || tr.isUserEvent("undo") || tr.isUserEvent("redo")) return "unknown";
  // Tekst fra en skabelon eller omformning (commands/run.ts) er indsat, ikke skrevet.
  if (tr.isUserEvent("input.command")) return "pasted";
  if (tr.isUserEvent("input")) return "typed";
  return "unknown";
}

/** Pladsholder, til en tekst er åbnet; det rigtige navn kommer fra Rust (indstillingen »Dit navn«). */
const ME: Author = { kind: "human", name: "", identifier: null };

export const authorshipField = StateField.define<AuthorshipState>({
  create: () => ({ authors: [], me: ME, pasted: [], external: [] }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setAuthorship)) value = e.value;
      if (e.is(assignAuthorship)) value = assign(value, e.value.range, e.value.who);
    }
    if (!tr.docChanged) return value;
    const inserted: Span[] = [];
    tr.changes.iterChanges((_fa, _ta, fromB, toB) => {
      if (toB > fromB) inserted.push({ start: fromB, end: toB });
    });
    value = applyChanges(value, tr.changes, kindOf(tr), inserted);
    // Fortryd: teksten, der kommer tilbage, får sin forfatter igen. Positionerne gælder teksten
    // efter ændringen, så de lægges på til sidst.
    for (const e of tr.effects) if (e.is(restoreAuthorship)) value = restore(value, e.value);
    return value;
  },
});

/** Forfatterskabet i det, en ændring sletter. Gemmes i historikken, så fortryd kan give det igen. */
export const restoreAuthorship = StateEffect.define<Authorship[]>({
  map: (value, mapping) => value.map((a) => ({ author: a.author, spans: mapSpans(a.spans, mapping) })),
});

function restore(value: AuthorshipState, back: Authorship[]): AuthorshipState {
  let authors = value.authors;
  for (const b of back) {
    for (const span of b.spans) {
      authors = authors.map((a) => ({ author: a.author, spans: subtract(a.spans, span) }));
      authors = giveTo(authors, b.author, span);
    }
  }
  return { ...value, authors: authors.filter((a) => a.spans.length > 0) };
}

export const authorshipHistory = invertedEffects.of((tr) => {
  if (!tr.docChanged) return [];
  const before = tr.startState.field(authorshipField, false);
  if (!before) return [];
  const removed: Authorship[] = [];
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (toA <= fromA) return;
    for (const a of before.authors) {
      const spans = a.spans
        .map((s) => ({ start: Math.max(s.start, fromA), end: Math.min(s.end, toA) }))
        .filter((s) => s.end > s.start);
      if (spans.length) removed.push({ author: a.author, spans });
    }
  });
  return removed.length ? [restoreAuthorship.of(removed)] : [];
});
