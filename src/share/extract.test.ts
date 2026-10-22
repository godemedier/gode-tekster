import { test } from "node:test";
import assert from "node:assert/strict";
import { genitive, restore, shareable } from "./extract.ts";

test("noter, parkeret og dæmpet tekst bliver hjemme", () => {
  const excerpt = [
    "Det var en mørk <!-- tjek vejret --> aften. {>> kilde? <<}",
    "",
    "<!-- gt:parkeret id=p1 dato=2026-10-05",
    "Et gammelt afsnit.",
    "-->",
    "",
    "Vi gik {--langsomt --}hjem.",
  ].join("\n");
  const { base, removed } = shareable(excerpt);
  assert.equal(base, "Det var en mørk aften.\n\n\nVi gik hjem.");
  assert.ok(!/tjek|kilde|gammelt|langsomt|<!--|\{>>|\{--/.test(base), base);
  assert.equal(removed.length, 4);
  assert.equal(restore(base, removed), excerpt);
});

test("en del uden noget privat er uændret", () => {
  const { base, removed } = shareable("Bare tekst med **fed** og [link](https://a.dk).");
  assert.equal(base, "Bare tekst med **fed** og [link](https://a.dk).");
  assert.deepEqual(removed, []);
});

test("rettelser, der ikke er taget stilling til, deles som de står", () => {
  const { base } = shareable("Et {++nyt ++}ord og {~~gammelt~>frisk~~}.");
  assert.equal(base, "Et {++nyt ++}ord og {~~gammelt~>frisk~~}.");
});

test("ejefald af navne", () => {
  assert.equal(genitive("Andreas"), "Andreas'");
  assert.equal(genitive("Kim"), "Kims");
  assert.equal(genitive("Max"), "Max'");
});
