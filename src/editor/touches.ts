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
    if (u.docChanged) this.step(u.startState.doc, u.state.doc, u.changes, u.transactions);
  }

  /**
   * Kaldes i et StateFields `update`. Felterne opdateres før plugins, så et felt, der læser memoet,
   * fandt det på den gamle tekst og scannede forfra ved hvert tastetryk (kodegennemgang 20/10).
   * Pluginets `advance` bagefter gør så ingenting.
   */
  advanceTr(tr: Transaction): void {
    if (tr.docChanged) this.step(tr.startState.doc, tr.state.doc, tr.changes, [tr]);
  }

  private step(start: Text, end: Text, changes: ChangeDesc, trs: readonly Transaction[]): void {
    const m = this.memo;
    if (!m || m.doc !== start) return;
    if (trs.some((tr) => touchesMarkers(tr, this.markers))) return;
    const spans = this.spans(m.value);
    let inside = false;
    changes.iterChangedRanges((fromA, toA) => {
      if (!inside) inside = spans.some((s) => fromA <= s.to && toA >= s.from);
    });
    if (!inside) this.memo = { doc: end, value: this.move(m.value, changes) };
  }
}
