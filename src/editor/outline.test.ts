import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyHeadings, headings, movePlan, relocatePlan } from "./outline.ts";

const apply = (doc: string, p: { from: number; to: number; insert: string }) => doc.slice(0, p.from) + p.insert + doc.slice(p.to);

test("status øverst skjuler ikke dispositionen og spærrer ikke afsnitsflytning", () => {
  const doc = "<!-- gt:status vaerdi=igang -->\n# Titel\n\nEt.\n\nTo.";
  assert.deepEqual(bodyHeadings(doc).map((h) => h.text), ["Titel"]);
  const plan = movePlan(doc, doc.indexOf("To."), -1);
  assert.ok(plan);
  assert.equal(apply(doc, plan), doc.replace("Et.\n\nTo.", "To.\n\nEt."));
});

test("lange mellemrum i overskrifter behandles uden regex-hængning", { timeout: 1000 }, () => {
  const spaces = " ".repeat(100_000);
  assert.deepEqual(headings(`# Titel${spaces}##${spaces}`).map((h) => h.text), ["Titel"]);
  assert.deepEqual(headings(`#${spaces}`), []);
});

test("afsnit flyttes forbi naboen, markøren følger med", () => {
  const doc = "Et.\n\nTo to.\n\nTre.\n";
  const p = movePlan(doc, doc.indexOf("To"), -1)!;
  assert.equal(apply(doc, p), "To to.\n\nEt.\n\nTre.\n");
  assert.equal(apply(doc, p).slice(p.cursor, p.cursor + 2), "To");
  const q = movePlan(doc, doc.indexOf("To"), 1)!;
  assert.equal(apply(doc, q), "Et.\n\nTre.\n\nTo to.\n");
  assert.equal(movePlan(doc, 0, -1), null, "første afsnit kan ikke op");
});

test("en overskrift flytter hele sektionen forbi søskendesektionen", () => {
  const doc = "# Titel\n\n## A\n\nA-tekst.\n\n### A1\n\nA1-tekst.\n\n## B\n\nB-tekst.\n";
  const p = movePlan(doc, doc.indexOf("## B"), -1)!;
  assert.equal(apply(doc, p), "# Titel\n\n## B\n\nB-tekst.\n\n## A\n\nA-tekst.\n\n### A1\n\nA1-tekst.\n");
});

test("skjulte blokke sidst i teksten flyttes aldrig", () => {
  const doc = "Et.\n\nTo.\n\n[^1]: Kilde.\n\n<!-- gt:parkeret id=p1 dato=2026-10-02\nx\n-->\n";
  assert.equal(movePlan(doc, doc.indexOf("To"), 1), null);
});

test("overskrifter i kodeblokke tæller ikke", () => {
  assert.deepEqual(headings("# A\n```\n# ikke\n```\n## B").map((h) => h.text), ["A", "B"]);
});

test("træk en sektion i dispositionen foran eller efter en anden", () => {
  const doc = "# A\n\nTekst a.\n\n## A1\n\nUnder a.\n\n# B\n\nTekst b.\n\n# C\n\nTekst c.\n\n[^1]: Note.\n";
  const at = (h: string) => doc.indexOf(h);
  const apply = (p: ReturnType<typeof relocatePlan>) => (p ? doc.slice(0, p.from) + p.insert + doc.slice(p.to) : doc);

  // C foran A: hele C flyttes op, A med underafsnit følger efter.
  const p1 = relocatePlan(doc, at("# C"), at("# A"), "before");
  assert.equal(apply(p1), "# C\n\nTekst c.\n\n# A\n\nTekst a.\n\n## A1\n\nUnder a.\n\n# B\n\nTekst b.\n\n[^1]: Note.\n");
  assert.equal(apply(p1).slice(p1!.cursor, p1!.cursor + 3), "# C");

  // A efter C: underafsnittet A1 følger med, noten bliver sidst.
  const p2 = relocatePlan(doc, at("# A"), at("# C"), "after");
  assert.equal(apply(p2), "# B\n\nTekst b.\n\n# C\n\nTekst c.\n\n# A\n\nTekst a.\n\n## A1\n\nUnder a.\n\n[^1]: Note.\n");
  assert.equal(apply(p2).slice(p2!.cursor, p2!.cursor + 3), "# A");

  // Inde i sig selv eller samme sted: ingenting.
  assert.equal(relocatePlan(doc, at("# A"), at("## A1"), "after"), null);
  assert.equal(relocatePlan(doc, at("# B"), at("# A"), "after"), null);
  assert.equal(relocatePlan(doc, at("# B"), at("# C"), "before"), null);
});

test("en sektion sidst i en tekst uden noter får sin afslutning med", () => {
  const doc = "# A\n\nEt.\n\n# B\n\nTo.\n";
  const p = relocatePlan(doc, 0, doc.indexOf("# B"), "after");
  assert.equal(p && doc.slice(0, p.from) + p.insert + doc.slice(p.to), "# B\n\nTo.\n\n# A\n\nEt.\n");
});
