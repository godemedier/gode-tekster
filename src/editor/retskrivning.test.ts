import { test } from "node:test";
import assert from "node:assert/strict";
import { retskrivningFlags } from "./retskrivning.ts";

const fix = (t: string) => retskrivningFlags(t).map((f) => `${t.slice(f.from, f.to)}→${f.replacement}`);

test("faste udtryk i to ord", () => {
  assert.deepEqual(fix("Vi er igang idag."), ["igang→i gang", "idag→i dag"]);
  assert.deepEqual(fix("Idag kom han tilsidst."), ["Idag→I dag", "tilsidst→til sidst"]);
  assert.deepEqual(fix("Det var al ting værd."), ["al ting→alting"]);
  // Rigtige ord, der ligner: ihjel, itu, igen, imens, ifølge, tilsammen, tilrettelægge.
  // »tilrette« er også et udsagnsord (målebænken 16/10).
  assert.deepEqual(fix("Det er svært at tilrette loven."), []);
  assert.deepEqual(fix("Han slog den ihjel, den gik itu igen imens ifølge planen. Tilsammen tilrettelægger de."), []);
});

test("forvekslinger", () => {
  assert.deepEqual(fix("Han gik ned af trappen."), ["af→ad"]);
  assert.deepEqual(fix("Han gik ud af vejen."), []);
  assert.deepEqual(fix("Hvad heder hun? Hun heder Anne."), ["heder→hedder", "heder→hedder"]);
  assert.deepEqual(fix("Vi kunde ikke se det, men en kunde kom ind."), ["kunde→kunne"]);
  assert.deepEqual(fix("Du som kunde har ret til det."), []);
  assert.deepEqual(fix("Det er standart, vel og mærke."), ["standart→standard", "vel og mærke→vel at mærke"]);
  assert.deepEqual(fix("Se jvf. bilaget."), ["jvf.→jf."]);
  // Med stort er det et navn: Extra Bladet.
  assert.deepEqual(fix("Det skrev Extra Bladet."), []);
});

test("forkortelser", () => {
  assert.deepEqual(fix("Det er dvs det samme, ca 50 kr. kl 14."), ["dvs→dvs.", "ca→ca.", "kl→kl."]);
  assert.deepEqual(fix("Det er fx. svært, bla. her."), ["fx.→fx", "bla.→bl.a."]);
  // Sidst i en sætning og med punktum er det rigtigt.
  assert.deepEqual(fix("Han tog æbler, pærer osv. Det er f.eks. svært, fx her. Han kom kl. 14."), []);
});

test("tal", () => {
  assert.deepEqual(fix("En 3 årig fra 1990erne og 1980 tallet."), ["3 årig→3-årig", "1990erne→1990'erne", "1980 tallet→1980-tallet"]);
  assert.deepEqual(fix("En 3-årig fra 1990'erne, 1.000 personer, 2,5 år."), []);
});

test("komma efter men og og", () => {
  assert.deepEqual(fix("Men, det er svært."), ["Men,→Men"]);
  assert.deepEqual(fix("Det gik. Og, så kom han."), ["Og,→Og"]);
  // Et indskud: »Men, som sagt, …«
  assert.deepEqual(fix("Men, som sagt, det er svært."), []);
  assert.deepEqual(fix("Men, som prodekanen skriver i sit lange svar til os, det er svært."), []);
});

test("citater markeres ikke", () => {
  assert.deepEqual(fix("Han sagde: »Vi er igang idag.«"), []);
});
