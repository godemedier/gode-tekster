import { test } from "node:test";
import assert from "node:assert/strict";
import { spellText } from "./languagePanel.ts";

test("stavekontrollen ser ikke listemarkører, og positionerne passer (5/10: »ii« blev til »ia«)", () => {
  const doc = "i. Et\nii. To\niii. Tre\n\na) Et\nb) To\n\nEn tekts.";
  const t = spellText(doc);
  assert.equal(t.length, doc.length);
  assert.doesNotMatch(t, /\bii\b|\biii\b|\bb\)/);
  assert.equal(t.indexOf("tekts"), doc.indexOf("tekts"));
});
