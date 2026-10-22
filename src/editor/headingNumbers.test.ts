import { test } from "node:test";
import assert from "node:assert/strict";
import { nextHeadingNumber } from "./headingNumbers.ts";
import { setHeading } from "./editing.ts";

test("næste overskrift på samme niveau fortsætter nummereringen (5/10)", () => {
  const lines = ["# Bog", "", "## 1. Indledning", "tekst", "### Underpunkt", "tekst"];
  assert.equal(nextHeadingNumber(lines, lines.length, 2), "2. ");
  assert.equal(nextHeadingNumber(["## 3) Tre"], 1, 2), "4) ");
  // Uden nummer, eller med et nyt afsnit på højere niveau imellem: intet nummer.
  assert.equal(nextHeadingNumber(["## Indledning"], 1, 2), null);
  assert.equal(nextHeadingNumber(["## 1. Et", "# Del to"], 2, 2), null);
});

test("Ctrl+2 på en linje giver det næste nummer", () => {
  const text = "## 1. Indledning\n\nAnden del";
  const plan = setHeading(text, text.length, text.length, 2);
  assert.equal(plan.replacement, "## 2. Anden del");
  // Har linjen allerede et nummer, røres det ikke.
  const t2 = "## 1. Et\n\n7. Syv";
  assert.equal(setHeading(t2, t2.length, t2.length, 2).replacement, "## 7. Syv");
});
