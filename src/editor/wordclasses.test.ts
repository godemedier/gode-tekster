import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLexicon, classify } from "./wordclasses.ts";

const lex = buildLexicon(JSON.parse(readFileSync(new URL("../assets/ordklasser.json", import.meta.url), "utf8")));

test("almindelige ord slås op", () => {
  assert.equal(classify("og", lex), "c");
  assert.equal(classify("Hus", lex), "n");
  assert.equal(classify("købte", lex), "v");
  assert.equal(classify("smuk", lex), "a");
  assert.equal(classify("ikke", lex), "d");
});

test("sammensætninger får sidste leds ordklasse", () => {
  assert.equal(classify("forsvarschef", lex), "n");
  assert.equal(classify("rigsrevisionen", lex), "n");
});

test("endelser gætter, når opslag ikke kan", () => {
  assert.equal(classify("skrivefrihed", lex), "n");
  assert.equal(classify("overskuelig", lex), "a");
  assert.equal(classify("xyz", lex), null);
});
