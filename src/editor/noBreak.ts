// Skjulte markdowntegn må ikke give et linjebrud (19/10: »samtykke« i fed, og », medmindre« stod
// først på næste linje). CodeMirror lægger et usynligt <img class="cm-widgetBuffer"> på hver side
// af et skjult tegn eller en widget, og ved et billede må browseren bryde linjen. Står der tekst
// lige før eller efter, holdes den sammen med de skjulte tegn i én mærkning, der ikke må brydes.
// Det gælder også midt i et ord (»fed**tekst**del«) og fodnotetallet efter »om.«.

import { type Range, type Text, findClusterBreak } from "@codemirror/state";
import { Decoration } from "@codemirror/view";

const noBreak = Decoration.mark({ class: "gt-nobreak", inclusive: true });

/** Mærkninger, der holder teksten sammen med de skjulte tegn og widgets i `decos` (inline-erstatninger). */
export function noBreakMarks(doc: Text, decos: readonly Range<Decoration>[]): Range<Decoration>[] {
  const hidden = decos
    .filter((d) => d.value.point && !d.value.spec.block && d.to > d.from)
    .map((d) => ({ from: d.from, to: d.to }))
    .sort((a, b) => a.from - b.from);
  // Skjulte tegn, der støder op til hinanden (`***`, `**[`), er ét hul i teksten.
  const runs: { from: number; to: number }[] = [];
  for (const h of hidden) {
    const last = runs[runs.length - 1];
    if (last && h.from <= last.to) last.to = Math.max(last.to, h.to);
    else runs.push({ ...h });
  }
  const out: Range<Decoration>[] = [];
  for (const { from, to } of runs) {
    const l = doc.lineAt(from);
    if (to > l.to) continue;
    const a = from - l.from;
    const b = to - l.from;
    const before = a > 0 && /\S/.test(l.text[a - 1]);
    const after = b < l.length && /\S/.test(l.text[b]);
    if (!before && !after) continue;
    out.push(noBreak.range(l.from + (before ? findClusterBreak(l.text, a, false) : a), l.from + (after ? findClusterBreak(l.text, b, true) : b)));
  }
  return out;
}
