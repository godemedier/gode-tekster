// Rettelsernes `{~~` og `~~}` (critic.ts) er ikke markdowns gennemstregning. Uden denne regel læste
// GFM `{~~gammel~>ny~~}` som `~~…~~`, så den nye tekst blev streget over sammen med den gamle (20/10).
// Mærkerne bliver deres egne små knuder, før gennemstregningen får dem at se.

import type { MarkdownConfig } from "@lezer/markdown";

const OPEN = 123; // {
const TILDE = 126; // ~

export const criticSyntax: MarkdownConfig = {
  defineNodes: ["CriticMark"],
  parseInline: [
    {
      name: "CriticMark",
      before: "Strikethrough",
      parse(cx, next, pos) {
        const three = cx.slice(pos, pos + 3);
        if ((next === OPEN && three === "{~~") || (next === TILDE && three === "~~}")) {
          return cx.addElement(cx.elt("CriticMark", pos, pos + 3));
        }
        return -1;
      },
    },
  ],
};
