// Kopiér som formateret tekst (Ctrl+Shift+C, research 2/10: MarkText copyAsRich, Ulysses »Copy for
// Substack«). Den hyppigste vej ud af programmet er kopiér-ind i et CMS eller en mail, ikke Word.
// Markeringen (eller hele teksten) lægges i udklipsholderen som HTML med fed, kursiv, links,
// overskrifter, lister, citater og fodnoter, og som ren tekst ved siden af.

import type { EditorView } from "@codemirror/view";

import { errorText, notify, showBanner } from "../ui/banner.ts";
import { tr } from "../i18n.ts";

export async function copyRich(view: EditorView): Promise<void> {
  const { markdownIt, prepare } = await import("./render.ts");
  const { from, to } = view.state.selection.main;
  const source = to > from ? view.state.sliceDoc(from, to) : view.state.doc.toString();
  const md = prepare(source, false);
  // Billeder peger på lokale filer, som modtageren ikke kan se: de bliver deres billedtekst.
  const html = markdownIt().render(md).replace(/<span class="img-missing">\[(?:Billede|Image): ([^\]]*)\]<\/span>/g, "$1");
  const plain = md.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      }),
    ]);
    notify(
      to > from
        ? tr("Markeringen er kopieret som formateret tekst.", "The selection was copied as formatted text.")
        : tr("Hele teksten er kopieret som formateret tekst.", "The whole text was copied as formatted text."),
    );
  } catch (e) {
    showBanner(tr(`Teksten kunne ikke kopieres. ${errorText(e)}`, `The text couldn't be copied. ${errorText(e)}`));
  }
}
