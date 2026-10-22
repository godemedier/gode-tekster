import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTime, fuzzyScore } from "./format.ts";

test("tid som i iA: klokkeslæt i dag, i går, ellers dato", () => {
  const now = new Date(2026, 9, 2, 15, 0);
  assert.equal(formatTime(new Date(2026, 9, 2, 14, 12).getTime(), now), "14.12");
  assert.equal(formatTime(new Date(2026, 9, 1, 23, 45).getTime(), now), "i går");
  assert.equal(formatTime(new Date(2026, 8, 30, 9, 0).getTime(), now), "30.09.2026");
});

test("søgning i filnavne: tegn i rækkefølge, start og sammenhæng vinder", () => {
  assert.equal(fuzzyScore("xyz", "ARTIKEL.md"), -1);
  assert.ok(fuzzyScore("art", "ARTIKEL.md") > fuzzyScore("art", "FRAKLIP-start.md"));
  assert.ok(fuzzyScore("fra", "FRAKLIP.md") > 0);
  assert.ok(fuzzyScore("fk", "FRAKLIP.md") > 0);
  assert.equal(fuzzyScore("", "x"), 0);
});
