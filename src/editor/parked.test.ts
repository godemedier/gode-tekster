import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendParked,
  clearFormatting,
  escapeParked,
  findParked,
  nextParkedId,
  parkedBlock,
  splitClippings,
  toTable,
  unescapeParked,
  parkChanges,
  withoutParked,
} from "./parked.ts";

test("escape kan vendes om, også med kommentarer og &#45; i teksten", () => {
  const tricky = "Se <!-- her --> og --!> og &#45; slut";
  const esc = escapeParked(tricky);
  assert.ok(!esc.includes("-->") && !esc.includes("<!--"));
  assert.equal(unescapeParked(esc), tricky);
});

test("parkerede blokke findes med id, dato og tekst", () => {
  const doc = "Artikel.\n\n" + parkedBlock("p1", "2026-10-02", "Første\n\nmed tom linje") + "\n" + parkedBlock("p2", "2026-10-02", "Anden -->");
  const found = findParked(doc);
  assert.deepEqual(found.map((p) => [p.id, p.text]), [["p1", "Første\n\nmed tom linje"], ["p2", "Anden -->"]]);
  assert.equal(nextParkedId(doc), "p3");
  assert.equal(doc.slice(found[0].from, found[0].from + 4), "<!--");
});

test("ny blok lægges sidst med en tom linje foran", () => {
  const { from, insert } = appendParked("Tekst.", parkedBlock("p1", "2026-10-02", "x"));
  assert.equal(from, 6);
  assert.ok(insert.startsWith("\n\n<!-- gt:parkeret id=p1"));
});

test("tekst uden fraklip til ordtal og eksport", () => {
  const doc = "Artikel.\n\n" + parkedBlock("p1", "2026-10-02", "væk");
  assert.equal(withoutParked(doc).trim(), "Artikel.");
});

test("FRAKLIP.md deles i stykker ved tomme linjer", () => {
  assert.deepEqual(splitClippings("FRAKLIP\n\n\n\nSTEFAN\n\n\"Citat\"\n\nAfsnit to\nmed linje"), ["STEFAN", '"Citat"', "Afsnit to\nmed linje"]);
});

test("lav til tabel ved tabulator og semikolon", () => {
  assert.equal(toTable("Tal\tKilde\n19 ud af 20\tRigsrevisionen"), "| Tal | Kilde |\n|---|---|\n| 19 ud af 20 | Rigsrevisionen |");
  assert.equal(toTable("a;b\nc"), "| a | b |\n|---|---|\n| c |  |");
});

test("fjern formatering beholder teksten", () => {
  assert.equal(clearFormatting("**fed** *kursiv* <u>under</u> ~~væk~~ {--dæmp--} [link](x)"), "fed kursiv under væk dæmp link");
});

test("markeringen flyttes til fraklip i én ændring, med lokal dato", () => {
  const doc = "Første afsnit.\n\nAndet afsnit.\n";
  const changes = parkChanges(doc, ["Andet afsnit."], { from: 16, to: 29 }, "2026-10-02");
  let out = doc;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to ?? c.from);
  assert.equal(out, "Første afsnit.\n\n\n<!-- gt:parkeret id=p1 dato=2026-10-02\nAndet afsnit.\n-->\n");
});
