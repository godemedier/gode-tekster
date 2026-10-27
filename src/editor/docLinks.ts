// Henvisning til en anden tekst (27/10: »en nem måde at referere til andre dokumenter, et slags
// søgefelt«). Skriv [[ eller vælg højreklik › Tilføj › Henvisning, find teksten i søgefeltet, og
// der står et almindeligt markdown-link med en relativ sti. Ctrl+klik åbner den (links.ts).
// Et almindeligt link frem for [[navn]] virker også i print, i andre markdown-programmer og på GitHub.

import { EditorView } from "@codemirror/view";

/** Navnet uden filtype: »2026-10-27 LinkedIn-plan.md« bliver »2026-10-27 LinkedIn-plan«. */
export function linkLabel(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
  return name.replace(/\.(md|markdown|txt)$/i, "");
}

/**
 * Stien fra den åbne tekst til en anden, med / og ../ som i markdown. Mellemrum og parenteser
 * kodes, ellers slutter linket for tidligt. Æ, ø og å står, som de er. Et andet drev giver den
 * fulde sti.
 */
export function relativeLink(from: string, to: string): string {
  const parts = (p: string) => p.split(/[\\/]+/).filter(Boolean);
  const a = parts(from).slice(0, -1);
  const b = parts(to);
  const encode = (p: string) => p.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
  if (!a.length || !b.length || a[0].toLowerCase() !== b[0].toLowerCase()) return encode(b.join("/"));
  let same = 0;
  while (same < a.length && same < b.length - 1 && a[same].toLowerCase() === b[same].toLowerCase()) same++;
  return encode([...a.slice(same).map(() => ".."), ...b.slice(same)].join("/"));
}

/** Programmets søgefelt (main.ts sætter det): `choose` med den valgte fil, eller `cancel`. */
type Picker = { pick: (choose: (path: string) => void, cancel: () => void) => void; currentPath: () => string | null };
let picker: Picker | null = null;

export function setReferencePicker(p: Picker): void {
  picker = p;
}

/**
 * Åbn søgefeltet og sæt en henvisning ind, hvor markøren står. Det markerede bliver linkets tekst,
 * ellers tekstens navn. `typed`: åbnet med [[, der står igen, hvis søgefeltet lukkes uden valg.
 */
export function pickReference(view: EditorView, typed = false): boolean {
  const from = picker?.currentPath();
  if (!picker || !from) return false;
  picker.pick(
    (to) => {
      const sel = view.state.selection.main;
      const label = view.state.sliceDoc(sel.from, sel.to).replace(/[[\]]/g, "") || linkLabel(to);
      const insert = `[${label}](${relativeLink(from, to)})`;
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, userEvent: "input.link", scrollIntoView: true });
      view.focus();
    },
    () => {
      if (typed) {
        const at = view.state.selection.main.head;
        view.dispatch({ changes: { from: at, insert: "[[" }, selection: { anchor: at + 2 }, userEvent: "input.type" });
      }
      view.focus();
    },
  );
  return true;
}

/** [[ åbner søgefeltet. De to klammer forsvinder, og står der igen, hvis man fortryder. */
export const referenceTrigger = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "[" || from !== to || view.state.sliceDoc(from - 1, from) !== "[" || !picker?.currentPath()) return false;
  view.dispatch({ changes: { from: from - 1, to: from }, selection: { anchor: from - 1 }, userEvent: "delete.backward" });
  return pickReference(view, true);
});
