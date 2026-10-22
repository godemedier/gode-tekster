// Det, der må forlade pc'en, når en del af en tekst deles (ADR-0060). Noter (`<!-- … -->` og
// `{>> … <<}`), programmets skjulte blokke (parkeret tekst, `<!-- gt:… -->`) og dæmpet tekst
// (`{--…--}`) tages ud. Hvor de stod, huskes, så de kan sættes ind igen i gæstens udgave, når
// forslagene hentes hjem (`share_merge` i Rust). Rene funktioner, testet med node --test.

import { findNotes } from "../editor/critic.ts";
import { findDimmed } from "../editor/inline.ts";
import { commentSpans } from "../editor/textSyntax.ts";

/** Noget privat, der er taget ud: hvor det stod i det delte, og hvad det var. */
export type Removed = { at: number; text: string };

/** Det private som intervaller, sorteret og lagt sammen, hvor de rører hinanden. */
function privateSpans(text: string): { from: number; to: number }[] {
  const spans = [
    ...commentSpans(text),
    ...findNotes(text).map((n) => ({ from: n.from, to: n.to })),
    ...findDimmed(text).map((d) => ({ from: d.open.from, to: d.close.to })),
  ].sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

/**
 * Delen uden det private. En note midt i en linje tager mellemrummet foran med, når der kommer
 * mellemrum eller tegnsætning efter den (»mørk <!-- … --> aften«). En blok, der
 * fylder hele linjer (parkeret tekst), tager linjeskiftet efter med, så der ikke står huller.
 */
export function shareable(excerpt: string): { base: string; removed: Removed[] } {
  let base = "";
  const removed: Removed[] = [];
  let pos = 0;
  for (const s of privateSpans(excerpt)) {
    let { from, to } = s;
    if (from < pos) continue;
    const lineStart = from === 0 || excerpt[from - 1] === "\n";
    const lineEnd = to === excerpt.length || excerpt[to] === "\n";
    if (lineStart && lineEnd) {
      if (excerpt[to] === "\n") to++;
    } else if (from > pos && excerpt[from - 1] === " " && (to === excerpt.length || /[\s.,;:!?)»”]/.test(excerpt[to]))) {
      from--;
    }
    base += excerpt.slice(pos, from);
    removed.push({ at: base.length, text: excerpt.slice(from, to) });
    pos = to;
  }
  base += excerpt.slice(pos);
  return { base, removed };
}

/** Det private sat ind igen. `restore(shareable(x)) === x` (det samme gør Rust ved hentning). */
export function restore(base: string, removed: Removed[]): string {
  let out = "";
  let pos = 0;
  for (const r of removed) {
    out += base.slice(pos, r.at) + r.text;
    pos = r.at;
  }
  return out + base.slice(pos);
}

/** »Andreas'« og »Kims«: dansk ejefald af et navn. */
export function genitive(name: string): string {
  return /[sxz]$/i.test(name) ? `${name}'` : `${name}s`;
}
