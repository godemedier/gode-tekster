import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { docxToMarkdown, htmlToMarkdown } from "./docx.ts";
import { wordDocument } from "../print/word.ts";
import { metaFor } from "../print/render.ts";

const data = (name: string) => {
  const b = readFileSync(new URL(`../../node_modules/mammoth/test/test-data/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

test("HTML fra mammoth bliver husets markdown", () => {
  const md = htmlToMarkdown(
    '<h1>Titel</h1><p>Et <strong>fedt</strong> og <em>kursivt</em> ord, <u>understreget</u> og <s>væk</s>.<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup></p>' +
      '<blockquote><p>Citat her.</p></blockquote><ul><li>En<ul><li>Under</li></ul></li><li>To</li></ul><ol><li>Første</li></ol>' +
      '<table><tr><td><p>A</p></td><td><p>B</p></td></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></table>' +
      '<p><a href="https://ft.dk/x">link</a> &amp; *stjerne*</p>' +
      '<ol><li id="footnote-1"><p> Kilden. <a href="#footnote-ref-1">↑</a></p></li></ol>',
  );
  assert.equal(
    md,
    [
      "# Titel",
      "Et **fedt** og *kursivt* ord, <u>understreget</u> og ~~væk~~.[^1]",
      "> Citat her.",
      "- En\n  - Under\n- To",
      "1. Første",
      "| A | B |\n| --- | --- |\n| 1 | 2 |",
      "[link](https://ft.dk/x) & \\*stjerne\\*",
      "[^1]: Kilden.",
    ].join("\n\n") + "\n",
  );
});

test("ægte Word-fodnoter fra mammoths testfil", async () => {
  const { markdown } = await docxToMarkdown(data("footnotes.docx"));
  assert.match(markdown, /\[\^1\]/);
  assert.match(markdown, /^\[\^1\]: .+/m);
});

test("tabeller og lister fra Word", async () => {
  assert.match((await docxToMarkdown(data("tables.docx"))).markdown, /^\| .+ \|$/m);
});

test("vores egen Word-eksport kommer tilbage med overskrift, fodnoter og citat", async () => {
  const md = "# Prøve\n\nEn sætning med en note.[^1]\n\n> »Et citat.«\n\n- punkt\n\n[^1]: Kilden, 2026.\n";
  const bytes = await wordDocument(md, metaFor(md, "x.md", "Kim Skribent"), { includeDimmed: false });
  const { markdown } = await docxToMarkdown(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  assert.match(markdown, /^# Prøve$/m);
  assert.match(markdown, /En sætning med en note\.\[\^\d+\]/);
  assert.match(markdown, /^> »Et citat\.«$/m);
  assert.match(markdown, /^\[\^\d+\]: Kilden, 2026\.$/m);
});
