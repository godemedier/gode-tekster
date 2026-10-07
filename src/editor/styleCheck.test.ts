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

test("fyldord streges, kancellisprog får et enklere ord, »blev træt« er ikke passiv", () => {
  const doc = "Det var faktisk sådan, at vi i forbindelse med sagen gik. Han blev træt. Sagen blev afgjort.";
  const { flags } = analyze(doc);
  const by = (k: string) => flags.find((f) => f.kind === k);
  assert.equal(doc.slice(by("fyldord")!.from, by("fyldord")!.to), "faktisk");
  assert.equal(categoryOf("fyldord"), "stryg");
  assert.equal(by("omstaendeligt")!.replacement, "ved");
  const passive = flags.filter((f) => f.kind === "passiv").map((f) => doc.slice(f.from, f.to));
  assert.ok(!passive.some((p) => p.includes("træt")), JSON.stringify(passive));
  assert.ok(passive.some((p) => p.includes("afgjort")), JSON.stringify(passive));
});
