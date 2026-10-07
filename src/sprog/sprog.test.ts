// Kopien af Gode Ords sprogregler må ikke glide (L-007). Fejler testen, er Gode Ord rettet: kør
// `node scripts/sprog.mjs`. Kører kun, hvor Gode Ord ligger (udviklerens pc).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { analyzeClarity } from "./clarity.ts";

const SOURCE = "C:/GM/projekter/gode-medier-suite/gode-ord/src/lib/";

for (const f of ["clarity.ts", "quotes.ts", "aitells.ts"]) {
  test(`${f} er den samme som i Gode Ord`, { skip: !existsSync(SOURCE + f) }, () => {
    // Git kan gemme filerne med Windows-linjeskift: de sammenlignes uden.
    const lf = (s: string) => s.replace(/\r\n/g, "\n");
    const copy = lf(readFileSync(new URL(f, import.meta.url), "utf8")).split("\n").slice(1).join("\n");
    const original = lf(readFileSync(SOURCE + f, "utf8")).replace(/from "\.\/(\w+)"/g, 'from "./$1.ts"');
    assert.equal(copy, original, `${f} er gledet fra Gode Ord. Kør: node scripts/sprog.mjs`);
  });
}

test("reglerne virker her: fyldord og kancellisprog findes", () => {
  const r = analyzeClarity("Det er faktisk sådan, at vi i forbindelse med sagen skal foretage en vurdering.");
  const kinds = new Set(r.flags.map((f) => f.kind));
  assert.ok(kinds.size > 0, JSON.stringify(r.flags));
  assert.ok(r.lix > 0);
});
