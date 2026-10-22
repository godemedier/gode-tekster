import { test } from "node:test";
import assert from "node:assert/strict";
import { findDimmed, findFootnoteRefs, footnoteEdit, footnoteNumbers, footnoteDefinition, footnoteRef, footnoteSources, footnoteUrl } from "./inline.ts";

test("fodnoter med en webadresse eller en henvisning er kilder, resten er kommentarer", () => {
  const doc = [
    "Et[^b] to[^a] tre[^c] fire[^d] fem[^e].",
    "",
    "[^a]: DR: [Rapporten](https://dr.dk/a#:~:text=x) (hentet 21/10)",
    "[^b]: Husk at ringe til hende igen",
    "[^c]: Se https://example.org/side.",
    "[^d]: Som hos [@hansen2024, s. 4]",
    "[^e]: Mail: kim@example.org",
  ].join("\n");
  assert.deepEqual(
    footnoteSources(doc).map((s) => [s.label, s.n, s.url]),
    [["a", 2, "https://dr.dk/a#:~:text=x"], ["c", 3, "https://example.org/side"], ["d", 4, null]],
  );
  assert.equal(footnoteUrl("Se <https://x.dk/a>, og mere"), "https://x.dk/a");
  assert.equal(footnoteUrl("ingen adresse"), null);
  // En fodnote uden definition, eller en i et fraklip, er ikke en kilde.
  assert.deepEqual(footnoteSources("Tal[^1].\n\n<!-- gt:parkeret id=p1 dato=2026-10-10\n[^1]: https://x.dk\n-->"), []);
});

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

test("en fodnote rettes på sin linje eller lægges til før slutningen, altid som én linje", () => {
  const apply = (doc: string, c: { from: number; to: number; insert: string }) => doc.slice(0, c.from) + c.insert + doc.slice(c.to);
  const doc = "Tekst[^1] og[^2].\n\n[^1]: Gammel.\n";
  assert.equal(apply(doc, footnoteEdit(doc, "1", "Ny\nlinje ", doc.length)), "Tekst[^1] og[^2].\n\n[^1]: Ny linje\n");
  assert.equal(apply(doc, footnoteEdit(doc, "2", "Anden", doc.length)), `${doc}\n\n[^2]: Anden\n`);
  const bare = "Tekst[^a].";
  assert.equal(apply(bare, footnoteEdit(bare, "a", "Note", bare.length)), "Tekst[^a].\n\n[^a]: Note\n");
});
