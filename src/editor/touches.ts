// Fælles hjælp til felter, der scanner hele teksten (performance-review 2/10): rører en ændring
// ikke en linje med et af mærkerne, før eller efter ændringen, kan dekorationerne bare flyttes
// med teksten i stedet for at blive bygget forfra ved hvert tastetryk.

import type { ChangeDesc, Text, Transaction } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";

/** Et mærke er en tekst, linjen indeholder, eller et mønster, den matcher (uden g-flag). */
export type Marker = string | RegExp;

export function touchesMarkers(tr: Transaction, markers: Marker[]): boolean {
  let hit = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (hit) return;
    const a = tr.startState.doc;
    const b = tr.state.doc;
    const before = a.sliceString(a.lineAt(fromA).from, a.lineAt(toA).to);
    const after = b.sliceString(b.lineAt(fromB).from, b.lineAt(toB).to);
    hit = markers.some((m) => (typeof m === "string" ? before.includes(m) || after.includes(m) : m.test(before) || m.test(after)));
  });
  return hit;
}

/**
 * Et fund over hele teksten, der flyttes med teksten i stedet for at blive fundet forfra. Det
 * findes forfra, når en ændring rører et mærke eller ligger inde i et fund (fundene kan rumme
 * tekst, fx en rettelses gamle og nye ord). Tastetryk i 200 sider kostede ellers tre gennemløb
 * af hele teksten (performance-review 2/10).
 */
export class TextMemo<T> {
  private memo: { doc: Text; value: T } | null = null;
  private markers: Marker[];
  private scan: (doc: string) => T;
  private move: (value: T, changes: ChangeDesc) => T;
  private spans: (value: T) => { from: number; to: number }[];

  constructor(
    markers: Marker[],
    scan: (doc: string) => T,
    move: (value: T, changes: ChangeDesc) => T,
    spans: (value: T) => { from: number; to: number }[],
  ) {
    this.markers = markers;
    this.scan = scan;
    this.move = move;
    this.spans = spans;
  }

  get(doc: Text): T {
    if (this.memo?.doc !== doc) this.memo = { doc, value: this.scan(doc.toString()) };
    return this.memo.value;
  }

  /** Kaldes først i et ViewPlugins `update`. */
  advance(u: ViewUpdate): void {
    const m = this.memo;
    if (!m || !u.docChanged || m.doc !== u.startState.doc) return;
    if (u.transactions.some((tr) => touchesMarkers(tr, this.markers))) return;
    const spans = this.spans(m.value);
    let inside = false;
    u.changes.iterChangedRanges((fromA, toA) => {
      if (!inside) inside = spans.some((s) => fromA <= s.to && toA >= s.from);
    });
    if (!inside) this.memo = { doc: u.state.doc, value: this.move(m.value, u.changes) };
  }
}
