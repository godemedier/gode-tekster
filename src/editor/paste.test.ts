import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { pastePlain } from "./paste.ts";

// `|` er markøren, `⟦…⟧` en markering.
function at(text: string): EditorState {
  const doc = text.replace(/[|⟦⟧]/g, "");
  const a = text.indexOf("⟦");
  const selection = a >= 0 ? { anchor: a, head: text.indexOf("⟧") - 1 } : { anchor: text.indexOf("|") };
  return EditorState.create({ doc, selection });
}

test("indsæt i et tomt punkt dobbelter ikke listetegnet, og afkrydsningsfeltet går med (F1-B12)", () => {
  assert.equal(pastePlain("- [ ] opgave", at("- |")), "[ ] opgave");
  assert.equal(pastePlain("- [ ] opgave", at("- [ ] |")), "opgave");
  assert.equal(pastePlain("1. a\n2. b", at("1. |")), "a\n2. b");
  // Flere linjer uden tegn bliver punkter, der tæller videre.
  assert.equal(pastePlain("x\ny", at("1. a\n2. |\n3. c")), "x\n3. y");
  assert.equal(pastePlain("x\ny", at("- |")), "x\n- y");
  // Uden for et tomt punkt røres teksten ikke.
  assert.equal(pastePlain("- a\n- b", at("Tekst |")), "- a\n- b");
});

test("en adresse over en markering bliver et link, usynlige tegn ryger", () => {
  assert.equal(pastePlain("https://dr.dk", at("se **⟦her⟧** nu")), "[her](https://dr.dk)");
  assert.equal(pastePlain("Kl: 10", at("se ⟦her⟧ nu")), "Kl: 10");
  assert.equal(pastePlain("a​b﻿c­d", at("|")), "abcd");
});
