import { test } from "node:test";
import assert from "node:assert/strict";
import { papirordFlags } from "./papirord.ts";

const fix = (t: string) => papirordFlags(t).map((f) => `${f.kind}:${t.slice(f.from, f.to)}→${f.replacement ?? ""}`);

test("papirord i to lag med forslag i samme bøjning", () => {
  assert.deepEqual(fix("Vi anmoder om at få papirerne fremsendt."), ["papirord:anmoder om→beder om", "papirord:fremsendt→sendt"]);
  assert.deepEqual(fix("Endvidere modtog vi brevet."), ["papirord:Endvidere→Desuden", "papirord-2:modtog→fik"]);
  // Den længste form vinder.
  assert.deepEqual(fix("Det gælder pr. dags dato."), ["papirord:pr. dags dato→i dag"]);
  // Afhænger formen af sætningen, er der intet forslag.
  assert.deepEqual(fix("Det skete forinden."), ["papirord:forinden→"]);
});

test("omkring som opmærksomhedsforskyder", () => {
  assert.deepEqual(fix("Vi informerer omkring reglerne."), ["omkring:omkring→om"]);
  assert.deepEqual(fix("De diskuterede omkring budgettet."), ["omkring:omkring→"]);
  // Omkring et tal betyder cirka.
  assert.deepEqual(fix("Der var en debat omkring 50 gange."), []);
});

test("målebænken 16/10: samt foran led med og, passiv modtaget, om hvorvidt, iværksætter", () => {
  assert.deepEqual(fix("Frihed og fællesskab samt professionalisme og frivillighed."), []);
  assert.deepEqual(fix("Der er modtaget tre klager."), []);
  assert.deepEqual(fix("Spørgsmålet om, hvorvidt det går."), []);
  assert.deepEqual(fix("Som iværksætter ved man det."), []);
});
