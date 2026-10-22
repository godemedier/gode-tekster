import { test } from "node:test";
import assert from "node:assert/strict";

import { locateExcerpt, noteMarkup, placeExcerpts } from "./commandResults.ts";

test("et fund findes, hvor det stod, eller nærmest derved, når der er skrevet siden", () => {
  const doc = "Et ord. Et ord. Et ord.";
  assert.deepEqual(locateExcerpt(doc, "Et ord.", 8), { from: 8, to: 15 });
  // Der er sat tre tegn ind foran: den nærmeste forekomst er stadig den midterste.
  assert.deepEqual(locateExcerpt(`abc${doc}`, "Et ord.", 8), { from: 11, to: 18 });
  assert.equal(locateExcerpt(doc, "Findes ikke", 8), null);
});

test("uddrag lægges på plads i teksten, og samme uddrag to gange får to steder", () => {
  const text = "pct. her og pct. der";
  const found = placeExcerpts(text, [
    { excerpt: "pct.", comment: "a" },
    { excerpt: "pct.", comment: "b" },
    { excerpt: "mangler", comment: "c" },
  ]);
  assert.deepEqual(found.map((f) => [f.from, f.to, f.comment]), [[0, 4, "a"], [12, 16, "b"]]);
});

test("en note kan ikke lukkes indefra", () => {
  assert.equal(noteMarkup("a -->\n b"), "<!-- a -- > b -->");
});
