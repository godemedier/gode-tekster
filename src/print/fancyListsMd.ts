// markdown-it: afsnit, hvis linjer er »a.«, »b.« … (eller a), A., i.), bliver til en ordnet liste
// (5/10). Kører efter blok-parseren og før inline, så punkternes tekst stadig får fed, kursiv
// og links. Typen står som <ol type="a">, og »)« som data-delim, som print.css viser.
// word.ts læser de samme tokens og vælger nummereringen derfra.

import type { MarkdownIt } from "markdown-it";
import { fancyRun } from "../editor/fancyLists.ts";

export function fancyLists(md: MarkdownIt): void {
  md.core.ruler.after("block", "fancy_lists", (state) => {
    const src = state.tokens;
    const out: typeof src = [];
    for (let i = 0; i < src.length; i++) {
      const open = src[i];
      const inline = src[i + 1];
      // En liste med »-« eller »=« lige under er for markdown-it en overskrift (setext). Den er en liste
      // (5/10, som fancyListBlocks i editoren), og understregningen er et tomt punkt, der ikke vises.
      const setext = open.type === "heading_open" && /^[=-]$/.test(open.markup) && src[i + 2]?.type === "heading_close";
      const para = open.type === "paragraph_open" && src[i + 2]?.type === "paragraph_close";
      const run = (para || setext) && inline?.type === "inline" ? fancyRun(inline.content.split("\n")) : null;
      if (!run) {
        out.push(open);
        continue;
      }
      const level = open.level;
      const ol = new state.Token("ordered_list_open", "ol", 1);
      Object.assign(ol, { block: true, level, map: open.map, markup: run[0].delim });
      ol.attrSet("type", run[0].type);
      // HTML læser type uden forskel på store og små bogstaver, så CSS bruger data-type (a og A).
      ol.attrSet("data-type", run[0].type);
      if (run[0].delim === ")") ol.attrSet("data-delim", ")");
      out.push(ol);
      for (const item of run) {
        const li = new state.Token("list_item_open", "li", 1);
        Object.assign(li, { block: true, level: level + 1, markup: item.delim });
        const p = new state.Token("paragraph_open", "p", 1);
        Object.assign(p, { block: true, level: level + 2, hidden: true });
        const text = new state.Token("inline", "", 0);
        Object.assign(text, { level: level + 3, content: item.text, children: [] });
        const pc = new state.Token("paragraph_close", "p", -1);
        Object.assign(pc, { block: true, level: level + 2, hidden: true });
        const lic = new state.Token("list_item_close", "li", -1);
        Object.assign(lic, { block: true, level: level + 1 });
        out.push(li, p, text, pc, lic);
      }
      const olc = new state.Token("ordered_list_close", "ol", -1);
      Object.assign(olc, { block: true, level });
      out.push(olc);
      i += 2;
    }
    state.tokens = out;
  });
}
