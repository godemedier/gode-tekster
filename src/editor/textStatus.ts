// Status og #tags i teksten (ADR-0038, plan 2026-10-08-bibliotek). Begge står i filen:
//
//   <!-- gt:status vaerdi=igang -->      én skjult linje øverst, som Rust læser i filens hoved
//   #klima #kronik                       tekstens sidste linje, kun hashtags (som i Ulysses)
//
// Statuslinjen skjules i editoren (hidden.ts). Tag-linjen står i teksten i svag farve. Ingen af dem
// tæller med, kommer med ud eller sendes til AI (parked.ts withoutParked). Rust har samme regler i
// textmeta.rs.

import { StateField, StateEffect, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { codeSpans, commentSpans, maskSpans } from "./textSyntax.ts";

export const STATUS_LINE = /^(﻿?)<!-- gt:status vaerdi=([^\s>]+) -->\n?/;

/** Statussen øverst i teksten, eller null. */
export function findStatus(doc: string): { id: string; from: number; to: number } | null {
  const m = STATUS_LINE.exec(doc);
  return m ? { id: m[2], from: m[1].length, to: m[0].length } : null;
}

/** Ændringen, der sætter, skifter eller fjerner statussen. */
export function statusChange(doc: string, id: string | null): { from: number; to: number; insert: string } {
  const old = findStatus(doc);
  const insert = id ? `<!-- gt:status vaerdi=${id} -->\n` : "";
  if (old) return { from: old.from, to: old.to, insert };
  const at = doc.startsWith("﻿") ? 1 : 0;
  return { from: at, to: at, insert };
}

const TAG = /^#[\p{L}\p{N}][\p{L}\p{N}_/-]*$/u;

/** Hashtaggene på en linje, der kun består af hashtags, ellers null. »# Overskrift« er ikke en. */
export function tagsOf(line: string): string[] | null {
  const words = line.trim().split(/\s+/).filter(Boolean);
  return words.length && words.every((w) => TAG.test(w)) ? words.map((w) => w.slice(1)) : null;
}

/** Skjulte blokke (`<!-- … -->`) erstattet af mellemrum, så linjernes placering bevares. */
function masked(doc: string): string {
  return maskSpans(doc, [...commentSpans(doc), ...codeSpans(doc)]);
}

/** Tekstens sidste synlige linje, hvis den kun er hashtags. */
export function findTagLine(doc: string): { from: number; to: number; tags: string[] } | null {
  const text = masked(doc);
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const line = text.slice(start, end);
    if (line.trim()) {
      const tags = tagsOf(line);
      // En kommentar på samme linje er brugerens tekst og må ikke slettes med etiketterne.
      return tags && tagsOf(doc.slice(start, end)) ? { from: start, to: end, tags } : null;
    }
    end = start - 1;
  }
  return null;
}

/** Teksten uden tag-linjen (til tal, eksport og AI). */
export function withoutTagLine(doc: string): string {
  const t = findTagLine(doc);
  return t ? doc.slice(0, t.from) + doc.slice(t.to) : doc;
}

function build(state: EditorState): DecorationSet {
  const t = findTagLine(state.doc.toString());
  if (!t) return Decoration.none;
  return Decoration.set([Decoration.line({ class: "gt-tagline" }).range(state.doc.lineAt(t.from).from)]);
}

const setTagLine = StateEffect.define<DecorationSet>();

const tagLineField = StateField.define<DecorationSet>({
  create: build,
  update: (deco, tr) => {
    let next = deco;
    if (tr.docChanged) next = next.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setTagLine)) next = e.value;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const tagLineUpdater = ViewPlugin.fromClass(
  class {
    timer = -1;
    update(u: ViewUpdate) {
      if (u.docChanged) {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          u.view.dispatch({ effects: setTagLine.of(build(u.view.state)) });
        }, 500);
      }
    }
    destroy() {
      window.clearTimeout(this.timer);
    }
  }
);

/** Tag-linjen i svag farve, så den læses som etiketter og ikke som tekst. */
export const tagLineStyle = [tagLineField, tagLineUpdater];

export const tagLineTheme = EditorView.theme({
  ".gt-tagline, .gt-tagline *": { color: "var(--svag)" },
});

// --- notens farve (ADR-0039) -----------------------------------------------------------------------
// Én skjult linje sidst i filen, som længdemålet: `<!-- gt:farve vaerdi=gul -->`. Farven følger noten
// til den anden pc. Placeringen på skærmen gemmes kun lokalt (notes.rs).

export const NOTE_COLORS = ["gul", "groen", "blaa", "rosa", "papir", "graa"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
export const COLOR_LINE = /<!-- gt:farve vaerdi=([a-zæøå]+) -->\n?/g;

/** Notens farve, eller null (så er den gul). Står der flere, gælder den sidste. */
export function findColor(doc: string): { color: NoteColor; from: number; to: number } | null {
  let found: { color: NoteColor; from: number; to: number } | null = null;
  for (const m of doc.matchAll(COLOR_LINE)) {
    const color = m[1] as NoteColor;
    if (NOTE_COLORS.includes(color)) found = { color, from: m.index ?? 0, to: (m.index ?? 0) + m[0].length };
  }
  return found;
}

/** Ændringen, der sætter eller skifter farven. En ny farve lægges sidst i teksten. */
export function colorChange(doc: string, color: NoteColor): { from: number; to: number; insert: string } {
  const line = `<!-- gt:farve vaerdi=${color} -->\n`;
  const old = findColor(doc);
  if (old) return { from: old.from, to: old.to, insert: line };
  const sep = doc.length === 0 || doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
  return { from: doc.length, to: doc.length, insert: sep + line };
}
