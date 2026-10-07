// Forfatterskab i farver (ADR-0009, design A2): AI-tekst i en dæmpet violet med svag baggrund,
// indsat tekst med en stiplet ravfarvet streg, til skribenten har valgt, og tekst rettet udefra
// med en violet stiplet streg. Slås til og fra i indstillingerne (»Hvem skrev hvad«).

import { StateEffect, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

import { authorshipField } from "./authorship.ts";
import { tr } from "../i18n.ts";

let visible = true;
export const refreshAuthorship = StateEffect.define<null>();

/** Kaldes, når indstillingen skifter. Tegner farverne om med det samme. */
export function setAuthorshipVisible(view: EditorView, on: boolean): void {
  visible = on;
  view.dispatch({ effects: refreshAuthorship.of(null) });
}

const ai = Decoration.mark({ class: "gt-ai" });
const pasted = Decoration.mark({ class: "gt-pasted" });
const external = Decoration.mark({ class: "gt-ext" });
// Andres tekst farves ikke (2/10): den er kun markeret i filen og vises, når musen holdes over.
const others = Decoration.mark({ attributes: { title: tr("Andres tekst (markeret af dig)", "Someone else's text (marked by you)") } });

function build(view: EditorView): DecorationSet {
  if (!visible) return Decoration.none;
  const state = view.state.field(authorshipField);
  const out: Range<Decoration>[] = [];
  for (const a of state.authors) {
    const mark = a.author.kind === "ai" ? ai : a.author.kind === "reference" ? others : null;
    if (!mark) continue;
    for (const s of a.spans) if (s.end > s.start) out.push(mark.range(s.start, s.end));
  }
  for (const s of state.pasted) if (s.end > s.start) out.push(pasted.range(s.start, s.end));
  for (const s of state.external) if (s.end > s.start) out.push(external.range(s.start, s.end));
  return Decoration.set(out, true);
}

export const authorshipView = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      const refresh = u.transactions.some((t) => t.effects.some((e) => e.is(refreshAuthorship)));
      if (u.docChanged || refresh || u.startState.field(authorshipField) !== u.state.field(authorshipField)) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export const authorshipTheme = EditorView.theme({
  ".gt-ai": { color: "var(--ai-tekst)", backgroundColor: "var(--ai-flade)", borderRadius: "2px" },
  ".gt-pasted": { textDecoration: "underline dotted #d9a441", textUnderlineOffset: "4px" },
  ".gt-ext": { textDecoration: "underline dashed #8b7fd0", textUnderlineOffset: "4px" },
});
