import { test } from "node:test";
import assert from "node:assert/strict";
import { fancyRun, marker, parseItem } from "./fancyLists.ts";

test("bogstaver med punktum og parentes bliver lister", () => {
  const a = fancyRun(["a. Første", "b. Anden", "c. Tredje"]);
  assert.equal(a?.length, 3);
  assert.equal(a?.[2].text, "Tredje");
  assert.equal(fancyRun(["a) Et", "b) To"])?.[1].delim, ")");
  assert.equal(fancyRun(["A. Et", "B. To"])?.[0].type, "A");
});

test("romertal genkendes, også i, der ligner et bogstav", () => {
  const r = fancyRun(["i. Et", "ii. To", "iii. Tre", "iv. Fire"]);
  assert.equal(r?.length, 4);
  assert.equal(r?.[3].type, "i");
});

test("navne og forkortelser bliver ikke til lister", () => {
  assert.equal(fancyRun(["A. P. Møller købte rederiet."]), null, "én linje er ikke en liste");
  assert.equal(fancyRun(["B. Jensen sagde det."]), null, "starter ikke med a/A/i/I");
  assert.equal(fancyRun(["a. Et", "c. Tre"]), null, "springer et bogstav over");
  assert.equal(fancyRun(["a. Et", "b) To"]), null, "blandede afgrænsere");
  assert.equal(parseItem("Almindelig tekst."), null);
});

test("næste markør", () => {
  assert.equal(marker("a", 1, "."), "b.");
  assert.equal(marker("A", 2, ")"), "C)");
  assert.equal(marker("i", 3, "."), "iv.");
  assert.equal(marker("I", 1, ")"), "II)");
});
