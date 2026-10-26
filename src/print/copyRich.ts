// Kopiér som formateret tekst (Ctrl+Shift+C, research 2/10: MarkText copyAsRich, Ulysses »Copy for
// Substack«). Den hyppigste vej ud af programmet er kopiér-ind i et CMS eller en mail, ikke Word.
// Markeringen (eller hele teksten) lægges i udklipsholderen som HTML med fed, kursiv, links,
// overskrifter, lister, citater og fodnoter, og som ren tekst uden markdown-tegn ved siden af
// (plain.ts). Felter, der kun tager ren tekst, fik før markdown med stjerner (15/10).
// »Med markdown« lægger kun markdown som ren tekst: til en anden markdown-editor eller et repo.

import type { EditorView } from "@codemirror/view";

import { errorText, notify, showBanner } from "../ui/banner.ts";
import { tr } from "../i18n.ts";

export async function copyRich(view: EditorView, withMarkdown = false): Promise<void> {
  const { markdownIt, prepare, PAGE_MARK, SPACE_MARK } = await import("./render.ts");
  const { plainText } = await import("./plain.ts");
  const { from, to } = view.state.selection.main;
  const source = to > from ? view.state.sliceDoc(from, to) : view.state.doc.toString();
  const md = prepare(source, false);
  const it = markdownIt();
  try {
    if (withMarkdown) {
      await navigator.clipboard.writeText(md.replaceAll(SPACE_MARK, "").replaceAll(PAGE_MARK, "+++"));
    } else {
      // Billeder peger på lokale filer, som modtageren ikke kan se: de bliver deres billedtekst.
      // Et sideskift betyder intet i en mail eller et CMS.
      const html = it.render(md).replaceAll(`<p>${PAGE_MARK}</p>\n`, "").replace(/<span class="img-missing">\[(?:Billede|Image): ([^\]]*)\]<\/span>/g, "$1");
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plainText(it, md)], { type: "text/plain" }),
        }),
      ]);
    }
    const what = to > from ? tr("Markeringen", "The selection") : tr("Hele teksten", "The whole text");
    notify(
      withMarkdown
        ? tr(`${what} er kopieret med markdown.`, `${what} was copied with markdown.`)
        : tr(`${what} er kopieret uden markdown.`, `${what} was copied without markdown.`),
    );
  } catch (e) {
    showBanner(tr(`Teksten kunne ikke kopieres. ${errorText(e)}`, `The text couldn't be copied. ${errorText(e)}`));
  }
}
