import { test } from "node:test";
import assert from "node:assert/strict";
import { afterMove, isStarred, toggleStar } from "./stars.ts";

test("stjerner slås til og fra uden forskel på store og små bogstaver", () => {
  const s = toggleStar([], "C:\\Tekster\\Bog.md");
  assert.ok(isStarred(s, "c:/tekster/bog.md"));
  assert.deepEqual(toggleStar(s, "C:\\tekster\\BOG.md"), []);
});

test("stjernen følger med ved omdøbning og flytning, også inde i en mappe", () => {
  const s = ["C:\\T\\Bog", "C:\\T\\Bog\\kapitel 1.md", "C:\\T\\Bogholderi.md"];
  assert.deepEqual(afterMove(s, "C:\\T\\Bog", "C:\\T\\Roman"), ["C:\\T\\Roman", "C:\\T\\Roman\\kapitel 1.md", "C:\\T\\Bogholderi.md"]);
  assert.deepEqual(afterMove(s, "C:\\T\\Bog", null), ["C:\\T\\Bogholderi.md"]);
});
