// »Kopiér uden markdown« (15/10): den rene tekst, som den står på siden. Ingen stjerner, havelåger
// eller klammer. Afsnit adskilles af en tom linje, punktlister får •, nummererede lister deres tal,
// fodnoter et tal i klammer med noterne sidst. Bygges af markdown-its tokens, så det er samme
// fortolkning som forhåndsvisningen.

import type { MarkdownIt } from "markdown-it";

import { PAGE_MARK, SPACE_MARK } from "./render.ts";

type Token = ReturnType<MarkdownIt["parse"]>[number];

export function plainText(md: MarkdownIt, markdown: string): string {
  let out = "";
  const lists: { ordered: boolean; n: number }[] = [];
  const inline = (children: Token[] | null): string =>
    (children ?? [])
      .map((c) => {
        if (c.type === "text" || c.type === "code_inline") return c.content;
        if (c.type === "softbreak" || c.type === "hardbreak") return "\n";
        if (c.type === "image") return c.content;
        if (c.type === "footnote_ref") return `[${Number((c.meta as { id: number }).id) + 1}]`;
        // Kun <u> må stå som HTML (render.ts). Noter og andet HTML vises ikke.
        return "";
      })
      .join("");
  for (const t of md.parse(markdown, {})) {
    switch (t.type) {
      case "inline":
        out += inline(t.children);
        break;
      case "paragraph_close":
        // I en tæt liste er afsnittet skjult: kun et linjeskift.
        out += t.hidden ? "\n" : "\n\n";
        break;
      case "heading_close":
        out += "\n\n";
        break;
      case "bullet_list_open":
      case "ordered_list_open":
        lists.push({ ordered: t.type === "ordered_list_open", n: Number(t.attrGet("start") ?? 1) });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        lists.pop();
        if (lists.length === 0) out = out.replace(/\n*$/, "\n\n");
        break;
      case "list_item_open": {
        const l = lists[lists.length - 1];
        out += "  ".repeat(lists.length - 1) + (l?.ordered ? `${l.n++}. ` : "• ");
        break;
      }
      case "fence":
      case "code_block":
        out += t.content + "\n";
        break;
      case "hr":
        out += "\n";
        break;
      case "th_close":
      case "td_close":
        out += "\t";
        break;
      case "tr_close":
        out = out.replace(/\t$/, "\n");
        break;
      case "table_close":
        out += "\n";
        break;
      case "footnote_open":
        out += `[${Number((t.meta as { id: number }).id) + 1}] `;
        break;
    }
  }
  return out
    .replaceAll(SPACE_MARK, "")
    .replaceAll(PAGE_MARK, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
