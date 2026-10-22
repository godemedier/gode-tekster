import { test } from "node:test";
import assert from "node:assert/strict";
import { findClaudeBlocks, saveChanges, setHandled } from "./claudeBlocks.ts";
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

test("flueben i faktatjekket (9/10): sættes, fjernes og føres over til et nyt tjek", () => {
  const claims = [
    { quote: "A steg 12 procent", verdict: "upræcis" },
    { quote: "B er 2,9 mio.", verdict: "forkert" },
  ];
  let doc = apply("Tekst.\n", saveChanges("Tekst.\n", "faktatjek", { what: "teksten", claims, seal: "s1" }, "2026-10-09"));
  const id = findClaudeBlocks(doc)[0].id;
  const c = setHandled(doc, id, 1, { how: "står", date: "2026-10-09" });
  assert.ok(c);
  doc = doc.slice(0, c.from) + c.insert + doc.slice(c.to);
  const data = findClaudeBlocks(doc)[0].data as { claims: unknown[]; handled: Record<string, unknown>; seal: string };
  assert.deepEqual(data.handled, { "1": { how: "står", date: "2026-10-09" } });
  assert.equal(data.seal, "s1");
  assert.deepEqual(data.claims, claims);
  // Et nyt tjek: samme citat og dom er stadig håndteret, en ny dom åbner igen.
  const fresh = [
    { quote: "B er 2,9 mio.", verdict: "forkert" },
    { quote: "A steg 12 procent", verdict: "korrekt" },
  ];
  const doc2 = apply(doc, saveChanges(doc, "faktatjek", { what: "teksten", claims: fresh }, "2026-10-10"));
  const blocks = findClaudeBlocks(doc2);
  assert.equal(blocks.length, 1);
  assert.deepEqual((blocks[0].data as { handled: unknown }).handled, { "0": { how: "står", date: "2026-10-09" } });
  // Fjernes igen.
  const off = setHandled(doc2, blocks[0].id, 0, null);
  assert.ok(off);
  const doc3 = doc2.slice(0, off.from) + off.insert + doc2.slice(off.to);
  assert.deepEqual((findClaudeBlocks(doc3)[0].data as { handled: unknown }).handled, {});
  // Research og ukendte blokke røres ikke.
  assert.equal(setHandled(doc3, "c99", 0, null), null);
});
