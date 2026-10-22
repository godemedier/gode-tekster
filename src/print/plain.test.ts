import { test } from "node:test";
import assert from "node:assert/strict";

import { markdownIt, prepare } from "./render.ts";
import { plainText } from "./plain.ts";

const plain = (md: string) => plainText(markdownIt(), prepare(md, false));

test("uden markdown: ingen stjerner, havelåger eller klammer (15/10)", () => {
  const md = "# Titel\n\nEt **fedt** og *kursivt* ord med [et link](https://x.dk).\n\n## Under\n\n> Et citat.\n";
  assert.equal(plain(md), "Titel\n\nEt fedt og kursivt ord med et link.\n\nUnder\n\nEt citat.");
});

test("lister får • og tal, også indrykket", () => {
  assert.equal(plain("- *æbler*\n- pærer\n  - grønne\n\n1. ost\n2. brød\n\nEfter."), "• æbler\n• pærer\n  • grønne\n\n1. ost\n2. brød\n\nEfter.");
});

test("fodnoter som tal i klammer med noten sidst, fraklip og noter er væk", () => {
  const md = "Tekst[^1] her. <!-- en note -->\n\n[^1]: Kilden.\n\n<!-- gt:parkeret id=p1 dato=2026-10-15\nKlip.\n-->\n";
  const out = plain(md);
  assert.match(out, /^Tekst\[1\] her\./);
  assert.match(out, /\[1\] Kilden\.$/);
  assert.doesNotMatch(out, /Klip|note|<!--/);
});

test("ekstra luft mellem afsnit giver ikke usynlige tegn", () => {
  assert.equal(plain("Et.\n\n\n\nTo."), "Et.\n\nTo.");
});
