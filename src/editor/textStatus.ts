// Status og #tags i teksten (ADR-0038, plan 2026-10-08-bibliotek). Begge står i filen:
//
//   <!-- gt:status vaerdi=igang -->      én skjult linje øverst, som Rust læser i filens hoved
//   #klima #kronik                       tekstens sidste linje, kun hashtags (som i Ulysses)
//
// Statuslinjen skjules i editoren (hidden.ts). Tag-linjen står i teksten i svag farve. Ingen af dem
// tæller med, kommer med ud eller sendes til AI (parked.ts withoutParked). Rust har samme regler i
// textmeta.rs.

import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

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
  return doc.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
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
      return tags ? { from: start, to: end, tags } : null;
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

/** Tag-linjen i svag farve, så den læses som etiketter og ikke som tekst. */
export const tagLineStyle = StateField.define<DecorationSet>({
  create: build,
  update: (deco, tr) => (tr.docChanged ? build(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

export const tagLineTheme = EditorView.theme({
  ".gt-tagline, .gt-tagline *": { color: "var(--svag)" },
});
