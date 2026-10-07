// Et fraklip trukket fra højre spalte ind i teksten (ADR-0008): CodeMirror sætter teksten ind, hvor
// det slippes. Bagefter fjernes kortet fra fraklip, medmindre Alt holdes nede (så bliver en kopi).

import { EditorView } from "@codemirror/view";

import { findParked } from "./parked.ts";

const PARKED_TYPE = "application/x-gt-parkeret";

export const parkedDrop = EditorView.domEventHandlers({
  drop(event, view) {
    const id = event.dataTransfer?.getData(PARKED_TYPE);
    if (!id || event.altKey) return false;
    // CodeMirror indsætter teksten selv. Fjern blokken lige efter.
    window.setTimeout(() => {
      const p = findParked(view.state.doc.toString()).find((x) => x.id === id);
      if (p) view.dispatch({ changes: { from: p.from, to: p.to, insert: "" }, userEvent: "delete.park" });
    }, 0);
    return false;
  },
});
