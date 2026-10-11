import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { hiddenBlocks } from "./hidden.ts";
import { addStructurePart, structureParts } from "./structure.ts";

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

test("note og formatering over strukturmærker bevarer del og arbejdsnote", () => {
  let s = EditorState.create({ doc: "Første afsnit.\n", extensions: [hiddenBlocks] });
  s = s.update({ changes: addStructurePart(s.doc.toString(), 0, s.doc.length, "Start", "", "Bevar noten")!, userEvent: "input.structure" }).state;
  const before = s.doc.toString(), part = structureParts(before)[0];
  for (const userEvent of ["input.note", "input.format"]) {
    const selected = before.slice(part.contentFrom);
    const after = s.update({ changes: { from: part.contentFrom, to: s.doc.length, insert: `<!-- ${selected.replace(/-->/g, "-- >")} -->` }, userEvent }).state;
    assert.equal(after.doc.toString(), before);
    assert.equal(structureParts(after.doc.toString())[0].note, "Bevar noten");
  }
});

test("ændret kodeafgrænsning giver samme skjulte områder før og efter genåbning", () => {
  let s = EditorState.create({ doc: "Første.\n\nAnden.\n", extensions: [hiddenBlocks] });
  s = s.update({ changes: addStructurePart(s.doc.toString(), 0, s.doc.length, "Start")!, userEvent: "input.structure" }).state;
  const p = structureParts(s.doc.toString())[0];
  s = s.update({ changes: { from: p.contentFrom, insert: "```\n" }, userEvent: "input.type" }).state;
  const reopened = EditorState.create({ doc: s.doc, extensions: [hiddenBlocks] });
  const ranges = (state: EditorState) => { const out: number[] = []; state.field(hiddenBlocks).between(0, state.doc.length, (a,b) => { out.push(a,b); }); return out; };
  assert.deepEqual(ranges(s), ranges(reopened));
});
