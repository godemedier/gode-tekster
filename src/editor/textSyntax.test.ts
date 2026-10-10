import { test } from "node:test";
import assert from "node:assert/strict";
import { codeSpans, commentSpans, outsideCode } from "./textSyntax.ts";

test("en kommentar kan indeholde kodehegn uden at miste sin afslutning", () => {
  const doc = "<!-- gt:parkeret\n```\ntekst\n```\n-->\nRest";
  assert.equal(commentSpans(doc).length, 1);
  assert.equal(doc.slice(commentSpans(doc)[0].to), "\nRest");
});

test("kode med lange hegn, tilder og inlinekode bevares ordret", () => {
  const doc = "x `<!-- a -->`\n~~~~ md\n<!-- b -->\n~~~~\n````\n```\n<!-- c -->\n````\ny";
  assert.deepEqual(commentSpans(doc), []);
  assert.equal(codeSpans(doc).length, 3);
  assert.equal(outsideCode(doc, (s) => s.toUpperCase()), doc.replace(/^x/, "X").replace(/y$/, "Y"));
});

test("en uafsluttet kommentar tager ikke næste kommentar eller tekst med", () => {
  const doc = "<!-- halv\nTekst\n<!-- færdig -->\nRest";
  assert.deepEqual(commentSpans(doc).map((s) => doc.slice(s.from, s.to)), ["<!-- færdig -->"]);
});

test("mange uafsluttede åbninger og forskellige backtick-længder forbliver tekst", () => {
  const doc = "<!--".repeat(30_000);
  const start = performance.now();
  assert.deepEqual(commentSpans(doc), []);
  assert.ok(performance.now() - start < 1000);
  assert.equal(outsideCode("`` x ` y ``", (s) => s.toUpperCase()), "`` x ` y ``");
});
