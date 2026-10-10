import { test } from "node:test";
import assert from "node:assert/strict";
import { findDimmed, findFootnoteRefs, footnoteNumbers, footnoteDefinition, footnoteRef } from "./inline.ts";

test("fodnoter i fraklip, kommentarer og kode ændrer ikke aktive fodnoter", () => {
  const doc = "Aktiv[^1].\n\n[^1]: original\n\n<!-- gt:parkeret id=p1 dato=2026-10-10\nKlip[^2].\n[^1]: forkert\n[^2]: skjult\n-->\n```\nKode[^3]\n[^3]: kode\n```\n`[^4]`";
  assert.deepEqual([...footnoteNumbers(doc)], [["1", 1]]);
  assert.equal(footnoteDefinition(doc, "1")?.text, "original");
  assert.equal(footnoteDefinition(doc, "2"), null);
  assert.equal(footnoteRef(doc, "2"), null);
});

test("dæmpet tekst findes med åbning, indhold og lukning", () => {
  const line = "Før {--måske ud--} og {--også--} efter";
  const found = findDimmed(line);
  assert.equal(found.length, 2);
  assert.equal(line.slice(found[0].body.from, found[0].body.to), "måske ud");
  assert.equal(line.slice(found[0].open.from, found[0].open.to), "{--");
  assert.equal(line.slice(found[1].close.from, found[1].close.to), "--}");
});

test("fodnotehenvisninger, men ikke definitioner", () => {
  assert.deepEqual(findFootnoteRefs("Tal[^1] og mere[^kilde]").map((r) => r.label), ["1", "kilde"]);
  assert.deepEqual(findFootnoteRefs("[^1]: Rigsrevisionen"), []);
  assert.deepEqual(findFootnoteRefs("Se [link](x) her"), []);
});

test("fodnoter nummereres efter rækkefølge i teksten", () => {
  const doc = "A[^b]\nB[^a] og igen[^b]\n\n[^a]: x\n[^b]: y";
  assert.deepEqual([...footnoteNumbers(doc)], [["b", 1], ["a", 2]]);
});

test("fodnotens definition og første henvisning slås op uden at bygge regexer af etiketten", () => {
  const doc = "Tekst.[^a.b] Mere.[^1]\n\n[^1]: Et.\n[^a.b]: Kilde med (parentes).\n";
  assert.deepEqual(footnoteDefinition(doc, "a.b"), { from: 34, to: 63, text: "Kilde med (parentes)." });
  assert.equal(footnoteDefinition(doc, "x"), null);
  const ref = footnoteRef(doc, "1")!;
  assert.equal(doc.slice(ref.from, ref.to), "[^1]");
});

test("dæmpet tekst over to afsnit findes som ét stykke", () => {
  const doc = "Før {--første afsnit.\n\nAndet afsnit.--} efter.";
  const [d] = findDimmed(doc);
  assert.equal(doc.slice(d.body.from, d.body.to), "første afsnit.\n\nAndet afsnit.");
});
