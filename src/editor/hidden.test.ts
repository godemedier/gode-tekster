import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { hiddenBlocks } from "./hidden.ts";

const block = "<!-- gt:parkeret id=p1 dato=2026-10-05\nEt klip.\n-->";
const doc = `# Titel\n\nFørste afsnit.\n\nSidste afsnit.\n${block}\n`;
const state = () => EditorState.create({ doc, extensions: [hiddenBlocks] });

test("sletning fra bunden af teksten tager ikke fraklip med (5/10)", () => {
  const s = state();
  const from = doc.indexOf("Sidste");
  const after = s.update({ changes: { from, to: doc.length }, userEvent: "delete.selection" }).state.doc.toString();
  assert.ok(after.includes(block), after);
  assert.ok(!after.includes("Sidste afsnit"));
  // Linjeskiftet foran blokken står, så den stadig begynder på sin egen linje.
  assert.match(after, /\n<!-- gt:parkeret/);
});

test("Backspace lige efter blokken og Ctrl+A + slet lader den stå", () => {
  const s = state();
  const all = s.update({ changes: { from: 0, to: doc.length }, userEvent: "delete.selection" }).state.doc.toString();
  assert.ok(all.includes(block));
  const end = doc.indexOf(block) + block.length;
  const back = s.update({ changes: { from: end - 1, to: end }, userEvent: "delete.backward" }).state.doc.toString();
  assert.ok(back.includes(block));
});

test("der kan stadig skrives i enden af sidste linje, og fanen kan selv fjerne klippet", () => {
  const s = state();
  const at = doc.indexOf("\n<!--");
  const typed = s.update({ changes: { from: at, insert: " Mere." }, userEvent: "input.type" }).state.doc.toString();
  assert.ok(typed.includes("Sidste afsnit. Mere.\n<!--"));
  const from = doc.indexOf(block);
  const removed = s.update({ changes: { from, to: from + block.length }, userEvent: "delete.park" }).state.doc.toString();
  assert.ok(!removed.includes("gt:parkeret"));
});
