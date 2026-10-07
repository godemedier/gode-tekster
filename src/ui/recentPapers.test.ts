import { test } from "node:test";
import assert from "node:assert/strict";
import { paperOf } from "./recentPapers.ts";

test("arket: overskriften bliver titel, afsnit uden markdown-tegn", () => {
  const p = paperOf("# Broen over Bæltet\n\nFør broen tog det **en time** at [sejle](https://x.dk).\n", "BROEN");
  assert.equal(p.title, "Broen over Bæltet");
  assert.deepEqual(p.blocks, [{ kind: "p", text: "Før broen tog det en time at sejle." }]);
});

test("arket: uden overskrift er titlen filnavnet", () => {
  const p = paperOf("Noter fra mødet\nmed to linjer.\n", "RÅNOTER");
  assert.equal(p.title, "RÅNOTER");
  assert.deepEqual(p.blocks, [{ kind: "p", text: "Noter fra mødet med to linjer." }]);
});

test("arket: skjulte blokke, front matter, tabeller og kode kommer ikke med", () => {
  const head = [
    "---",
    "title: x",
    "---",
    "# Titel",
    "<!-- gt:parkeret id=p1",
    "hemmeligt",
    "-->",
    "| a | b |",
    "|---|---|",
    "```",
    "kode",
    "```",
    "Synlig tekst.",
  ].join("\n");
  const p = paperOf(head, "x");
  assert.equal(p.title, "Titel");
  assert.deepEqual(p.blocks, [{ kind: "p", text: "Synlig tekst." }]);
});

test("arket: mellemrubrikker og listepunkter står for sig", () => {
  const p = paperOf("# T\n\n## Et spænd\n- første\n- anden\n", "x");
  assert.deepEqual(p.blocks, [
    { kind: "h", text: "Et spænd" },
    { kind: "p", text: "første" },
    { kind: "p", text: "anden" },
  ]);
});

test("arket: en halv skjult blok i slutningen af starten skjules også", () => {
  const p = paperOf("# T\n\nTekst.\n\n<!-- gt:note uden slut", "x");
  assert.deepEqual(p.blocks, [{ kind: "p", text: "Tekst." }]);
});
