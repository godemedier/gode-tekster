import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { grammarFlags } from "./grammar.ts";

const lex = JSON.parse(readFileSync(new URL("../assets/ordklasser.json", import.meta.url), "utf8")) as { v: string[] };
const verbs = new Set(lex.v);
const fix = (t: string) => grammarFlags(t, verbs).map((f) => `${t.slice(f.from, f.to)}→${f.replacement}`);

test("navnemåde efter »at« og mådesudsagnsord", () => {
  assert.deepEqual(fix("Det er svært at giver slip."), ["giver→give"]);
  assert.deepEqual(fix("Hun vil spørger chefen."), ["spørger→spørge"]);
  assert.deepEqual(fix("Det kan er rigtigt."), ["er→være"]);
  assert.deepEqual(fix("Vi skal har det klar."), ["har→have"]);
  assert.deepEqual(fix("Det er svært at give slip."), []);
});

test("nutid efter jeg, du, han, hun, vi og man", () => {
  assert.deepEqual(fix("Vi lære meget af det."), ["lære→lærer"]);
  assert.deepEqual(fix("Hun tro, at det går."), ["tro→tror"]);
  assert.deepEqual(fix("Jeg være glad."), ["være→er"]);
  assert.deepEqual(fix("Vi lærer meget."), []);
});

test("omvendt ordstilling er rigtig og markeres ikke", () => {
  assert.deepEqual(fix("Kan vi lære det?"), []);
  assert.deepEqual(fix("I morgen skal jeg skrive."), []);
  assert.deepEqual(fix("Det er godt at du ser det."), []);
});

test("dobbelte småord, men ikke over et punktum eller en linje", () => {
  assert.deepEqual(fix("Han kom og og gik."), ["og→"]);
  assert.deepEqual(fix("Han kom med med bilen."), ["med→"]);
  assert.deepEqual(fix("Det er det, du mener."), []);
  assert.deepEqual(fix("Han gik ud og.\nOg så kom han."), []);
});

test("stort begyndelsesbogstav følger med, og citater markeres ikke", () => {
  assert.deepEqual(fix("At giver op er svært."), ["giver→give"]);
  assert.deepEqual(fix("Han sagde: »vi lære af det«."), []);
});

test("falske fund fundet i et korpus af fagbladsartikler (7/10) markeres ikke", () => {
  assert.deepEqual(fix("Povl Gad er cand.mag."), []);
  assert.deepEqual(fix("men kunne ved hjemkomsten se det"), []);
  assert.deepEqual(fix("så lod han være."), []);
  assert.deepEqual(fix("som jeg få dage inden havde mødt"), []);
  assert.deepEqual(fix("Underforstået at søger man hjælp, får man den."), []);
  assert.deepEqual(fix("Der bliver lagt vægt på, at lærer og pædagog arbejder sammen."), []);
  assert.deepEqual(fix("bruge mit liv på på kort sigt"), []);
  assert.deepEqual(fix("Nu bliver ph.d.en en reel karrierevej."), []);
  assert.deepEqual(fix("skulle min mand og jeg melde fra"), []);
  assert.deepEqual(fix("luskede jeg stille hjem"), []);
});
