import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { saetningFlags } from "./saetning.ts";

const lex = JSON.parse(readFileSync(new URL("../assets/ordklasser.json", import.meta.url), "utf8")) as { v: string[]; n: string[] };
const kinds = (t: string) => saetningFlags(t, new Set(lex.v), new Set(lex.n)).map((f) => `${f.kind}:${t.slice(f.from, f.to)}`);

test("kløvning: kun med et navn (målebænken 16/10)", () => {
  assert.deepEqual(kinds("Det er Mette, der bestemmer."), ["kloevning:Det er Mette, der"]);
  assert.deepEqual(kinds("Det er især lærerne, der mærker det."), []);
  // Peger tilbage på sætningen før: ikke kløvning.
  assert.deepEqual(kinds("Det er folk, der arbejder hårdt."), []);
  assert.deepEqual(kinds("Det er svært at vide, hvad der sker."), []);
});

test("langt indskud mellem grundled og udsagnsled", () => {
  assert.deepEqual(kinds("Rapporten, som udvalget har brugt det meste af foråret og hele den lange sommer på at skrive, viser noget nyt."), [
    "indskud:som udvalget har brugt det meste af foråret og hele den lange sommer på at skrive",
  ]);
  assert.deepEqual(kinds("Rapporten, som udvalget skrev, viser noget nyt."), []);
  // Afgrænsende relativsætning: grundleddet kan ikke stå alene.
  assert.deepEqual(kinds("De, der har brugt det meste af foråret og sommeren på at skrive den, ved det."), []);
  assert.deepEqual(kinds("Virksomheder, som har brugt det meste af foråret og sommeren på at skrive den, ved det."), []);
});
