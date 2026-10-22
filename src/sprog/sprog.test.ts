// Sprogreglerne er Gode Teksters egne (ADR-0066). Testen her viser bare, at de virker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeClarity } from "./clarity.ts";

test("reglerne virker her: fyldord og kancellisprog findes", () => {
  const r = analyzeClarity("Det er faktisk sådan, at vi i forbindelse med sagen skal foretage en vurdering.");
  const kinds = new Set(r.flags.map((f) => f.kind));
  assert.ok(kinds.size > 0, JSON.stringify(r.flags));
  assert.ok(r.lix > 0);
});
