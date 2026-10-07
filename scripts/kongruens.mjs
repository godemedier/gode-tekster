// Bygger src/assets/kongruens.json af den danske træbank UD Danish-DDT (CC BY-SA 4.0) til
// kongruenstjekket (grammar.ts, 7/10):
//   n: ubestemte navneord i ental → "c" (fælleskøn, en) eller "n" (intetkøn, et). Kun ord, træbanken
//      altid giver samme køn.
//   a: tillægsord, grundform → [t-form, e-form], fx "stor" → ["stort", "store"]. Kun når t-formen er
//      set i træbanken og er forskellig fra grundformen (»dansk« bliver ikke til »danskt«).
//
//   node scripts/kongruens.mjs <mappe med da_ddt-ud-*.conllu>
//
// Filerne hentes fra https://github.com/UniversalDependencies/UD_Danish-DDT.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("Brug: node scripts/kongruens.mjs <mappe med da_ddt-ud-*.conllu>");
  process.exit(1);
}

const feats = (s) => Object.fromEntries(s === "_" ? [] : s.split("|").map((p) => p.split("=")));
const gender = new Map(); // ubestemt ental -> Set(Com|Neut)
const adj = new Map(); // lemma -> { base, t, e }

for (const f of readdirSync(dir).filter((f) => f.endsWith(".conllu"))) {
  for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const c = line.split("\t");
    if (c.length < 6 || c[0].includes("-") || c[0].includes(".")) continue;
    const form = c[1].toLowerCase();
    const lemma = c[2].toLowerCase();
    if (!/^\p{L}[\p{L}-]*$/u.test(form)) continue;
    const ft = feats(c[5]);
    if (c[3] === "NOUN" && ft.Definite === "Ind" && ft.Number === "Sing" && ft.Gender) {
      const s = gender.get(form) ?? new Set();
      s.add(ft.Gender);
      gender.set(form, s);
    }
    if (c[3] === "ADJ" && ft.Degree === "Pos") {
      const a = adj.get(lemma) ?? {};
      if (ft.Definite === "Ind" && ft.Number === "Sing" && ft.Gender === "Com") a.base = form;
      if (ft.Definite === "Ind" && ft.Number === "Sing" && ft.Gender === "Neut") a.t = form;
      if (ft.Definite === "Def" || ft.Number === "Plur") a.e = form;
      adj.set(lemma, a);
    }
  }
}

const n = {};
for (const [form, s] of [...gender].sort((a, b) => a[0].localeCompare(b[0], "da"))) {
  if (s.size === 1) n[form] = s.has("Neut") ? "n" : "c";
}
const a = {};
for (const [lemma, f] of [...adj].sort((x, y) => x[0].localeCompare(y[0], "da"))) {
  const base = f.base ?? lemma;
  if (f.t && f.t !== base && f.e) a[base] = [f.t, f.e];
}

const target = new URL("../src/assets/kongruens.json", import.meta.url);
writeFileSync(target, JSON.stringify({ kilde: "UD Danish-DDT, CC BY-SA 4.0", n, a }));
console.log({ navneord: Object.keys(n).length, tillaegsord: Object.keys(a).length });
