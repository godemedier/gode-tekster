import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { trimmed } from "./selection.ts";

const s = EditorState.create({ doc: "## Overskrift\nAfsnittet her.\nNæste linje." });

test("trippelklik på en linje: linjeskiftet tages fra", () => {
  // Linje 1 er 0-13, linje 2 starter i 14.
  assert.deepEqual(trimmed(s, 0, 14), { anchor: 0, head: 13 });
  assert.deepEqual(trimmed(s, 14, 29), { anchor: 14, head: 28 });
});

test("baglæns markering rettes også", () => {
  assert.deepEqual(trimmed(s, 14, 0), { anchor: 13, head: 0 });
});

test("markeringer, der slutter midt i en linje, røres ikke", () => {
  assert.equal(trimmed(s, 0, 10), null);
  assert.equal(trimmed(s, 3, 20), null);
  assert.equal(trimmed(s, 5, 5), null);
});
