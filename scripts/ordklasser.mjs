// Bygger src/assets/ordklasser.json af den danske træbank UD Danish-DDT (CC BY-SA 4.0).
// Hver ordform får den ordklasse, den oftest har i træbanken. Kun de fem klasser, iA viser:
// navneord (n), udsagnsord (v), tillægsord (a), biord (d) og bindeord (c).
//
//   node scripts/ordklasser.mjs <mappe med da_ddt-ud-*.conllu>
//
// Filerne hentes fra https://github.com/UniversalDependencies/UD_Danish-DDT.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("Brug: node scripts/ordklasser.mjs <mappe med da_ddt-ud-*.conllu>");
  process.exit(1);
}

const CLASS = { NOUN: "n", PROPN: "n", VERB: "v", AUX: "v", ADJ: "a", ADV: "d", CCONJ: "c", SCONJ: "c" };
const counts = new Map(); // form -> Map(upos -> n)

for (const f of readdirSync(dir).filter((f) => f.endsWith(".conllu"))) {
  for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 4 || cols[0].includes("-") || cols[0].includes(".")) continue;
    const form = cols[1].toLowerCase();
    if (!/^[\p{L}][\p{L}-]*$/u.test(form)) continue;
    const m = counts.get(form) ?? new Map();
    m.set(cols[3], (m.get(cols[3]) ?? 0) + 1);
    counts.set(form, m);
  }
}

const out = { n: [], v: [], a: [], d: [], c: [] };
for (const [form, m] of counts) {
  const [upos] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  const c = CLASS[upos];
  if (c) out[c].push(form);
}
for (const k of Object.keys(out)) out[k].sort((a, b) => a.localeCompare(b, "da"));

const target = new URL("../src/assets/ordklasser.json", import.meta.url);
writeFileSync(target, JSON.stringify({ kilde: "UD Danish-DDT, CC BY-SA 4.0", ...out }));
console.log(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])));
