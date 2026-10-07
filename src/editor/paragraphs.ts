// Afsnit som i bøger (3/10): indryk på første linje og ingen luft mellem afsnit. Valget står
// under Indstillinger, Afsnit, og gælder også print, PDF og Word (print.css, word.ts). iA Writer har
// det kun i forhåndsvisningen; her ses det, mens man skriver.
//
// Bogtypografiens regler: kun et afsnit, der følger direkte efter et andet afsnit, rykkes ind. Det
// første efter en overskrift, en liste, et citat eller en skillelinje står helt ude. Vil man have luft
// mellem to afsnit alligevel, laver man en ekstra tom linje (Enter på en tom linje). Den tomme linje
// mellem to afsnit bliver i filen (markdown kræver den) men klappes sammen på skærmen, undtagen når
// markøren står i den, så man kan se, hvor man er.

import { syntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { Compartment, type EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const indent = Decoration.line({ class: "gt-indent" });
const gap = Decoration.line({ class: "gt-gap" });

/** Linjerne, der skal rykkes ind, og de tomme linjer, der skal klappes sammen (startpositioner). */
// `tree` kan gives med: i testene er statens eget træ ikke altid færdigparset (fejlede 1 af 5 gange 4/10).
export function bookLines(state: EditorState, tree: Tree = syntaxTree(state)): { indents: number[]; gaps: number[] } {
  const indents: number[] = [];
  const gaps: number[] = [];
  const doc = state.doc;
  const cursorLine = doc.lineAt(state.selection.main.head).number;
  let prevParagraphEnd = -1;
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === "Paragraph") {
      if (prevParagraphEnd >= 0) {
        const first = doc.lineAt(node.from);
        const last = doc.lineAt(prevParagraphEnd);
        // Kun tomme linjer imellem (to afsnit adskilt af andet bryder kæden af sig selv: så er der en node).
        // Én tom linje er et almindeligt afsnitsskift. To eller flere er »luft her«: den første bliver
        // stående som afstand, resten klappes sammen, og afsnittet efter rykkes ikke ind.
        const blanks = first.number - last.number - 1;
        if (blanks <= 1) indents.push(first.from);
        const from = blanks >= 2 ? last.number + 2 : last.number + 1;
        for (let n = from; n < first.number; n++) if (n !== cursorLine) gaps.push(doc.line(n).from);
      }
      prevParagraphEnd = node.to;
    } else {
      prevParagraphEnd = -1;
    }
  }
  return { indents, gaps };
}

function build(view: EditorView): DecorationSet {
  const { indents, gaps } = bookLines(view.state);
  const all = [...indents.map((p) => [p, indent] as const), ...gaps.map((p) => [p, gap] as const)].sort((a, b) => a[0] - b[0]);
  const b = new RangeSetBuilder<Decoration>();
  for (const [pos, deco] of all) b.add(pos, pos, deco);
  return b.finish();
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.baseTheme({
  ".cm-line.gt-indent": { textIndent: "1.5em" },
  ".cm-line.gt-gap": { fontSize: "0", lineHeight: "0" },
});

const slot = new Compartment();

/** Udvidelsen til setup.ts. Slået fra, til indstillingen siger andet. */
export function paragraphStyle(): Extension {
  return slot.of([]);
}

export function setParagraphs(view: EditorView, book: boolean): void {
  view.dispatch({ effects: slot.reconfigure(book ? [plugin, theme] : []) });
}
