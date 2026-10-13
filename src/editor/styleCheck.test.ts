import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, categoryOf, mask } from "./styleCheck.ts";

test("markdown, kode og skjulte blokke analyseres ikke, men positionerne passer", () => {
  const doc = "# Titel\n\nEt **ord** og `kode`.\n<!-- gt:parkeret id=p1\nfaktisk\n-->\n";
  const m = mask(doc);
  assert.equal(m.length, doc.length);
  assert.ok(!m.includes("faktisk"));
  assert.ok(!m.includes("**") && !m.includes("kode"));
});

test("fyldord streges, kancellisprog får et enklere ord", () => {
  const doc = "Det var faktisk sådan, at vi med henblik på sagen gik. Han blev træt. Sagen blev afgjort.";
  const { flags } = analyze(doc, undefined, undefined, true);
  const by = (k: string) => flags.find((f) => f.kind === k);
  assert.equal(doc.slice(by("fyldord")!.from, by("fyldord")!.to), "faktisk");
  assert.equal(categoryOf("fyldord"), "stryg");
  assert.equal(by("omstaendeligt")!.replacement, "for at");
});

test("passiv og navneordsstil er et mål for hele teksten, ikke fund (fase 1, 13/10)", () => {
  const doc = "Han blev træt. Sagen blev afgjort. Vurderingen af implementeringen og ledelsens forventning tog tid. Vi gik hjem.";
  const { flags, density } = analyze(doc, undefined, undefined, true);
  assert.ok(!flags.some((f) => f.kind === "passiv" || f.kind === "nominalisering"));
  // »blev træt« er ikke passiv, »blev afgjort« er.
  assert.deepEqual(density, { sentences: 4, passive: 1, nominal: 1 });
});

test("passiv i et citat tæller ikke med", () => {
  const { density } = analyze("Han sagde: »Sagen blev afgjort i går.« Vi gik hjem.", undefined, undefined, true);
  assert.equal(density.passive, 0);
});

test("som standard kun de regler, der sjældent tager fejl (målebænken 12/10)", () => {
  const doc = "Det var faktisk sådan, at vi med henblik på sagen gik; Sagen blev afgjort.";
  const kinds = (strict: boolean) => new Set(analyze(doc, undefined, undefined, strict).flags.map((f) => f.kind));
  assert.ok(kinds(true).has("fyldord"));
  assert.deepEqual([...kinds(false)], ["hus:semikolon"]);
});
