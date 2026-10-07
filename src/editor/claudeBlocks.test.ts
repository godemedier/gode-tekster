import { test } from "node:test";
import assert from "node:assert/strict";
import { findClaudeBlocks, saveChanges } from "./claudeBlocks.ts";
import { withoutParked } from "./parked.ts";

function apply(doc: string, changes: { from: number; to?: number; insert: string }[]): string {
  let out = doc;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to ?? c.from);
  return out;
}

const finding = { question: "Hvor mange?", findings: [{ summary: "Et citat med --> og <!-- i.", source: { url: "https://dst.dk" } }] };

test("research gemmes i filen og kan læses igen, også med kommentartegn i citatet", () => {
  const doc = apply("Tekst.\n", saveChanges("Tekst.\n", "research", finding, "2026-10-02"));
  const [b] = findClaudeBlocks(doc);
  assert.equal(b.kind, "research");
  assert.equal(b.date, "2026-10-02");
  assert.deepEqual(b.data, finding);
  assert.equal(doc.match(/-->/g)?.length, 1, "kun blokkens egen slutning");
});

test("nyt faktatjek erstatter det forrige, research lægges ved siden af", () => {
  let doc = "Tekst.\n";
  doc = apply(doc, saveChanges(doc, "faktatjek", { claims: [1] }));
  doc = apply(doc, saveChanges(doc, "research", finding));
  doc = apply(doc, saveChanges(doc, "faktatjek", { claims: [2] }));
  const blocks = findClaudeBlocks(doc);
  assert.deepEqual(blocks.map((b) => b.kind).sort(), ["faktatjek", "research"]);
  assert.deepEqual(blocks.find((b) => b.kind === "faktatjek")!.data, { claims: [2] });
});

test("resultaterne tælles ikke og eksporteres ikke", () => {
  const doc = apply("Tekst.\n", saveChanges("Tekst.\n", "research", finding));
  assert.equal(withoutParked(doc).trim(), "Tekst.");
});
