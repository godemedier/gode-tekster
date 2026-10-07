import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { movesCaret, paragraphAt, smartQuote } from "./modes.ts";

test("» åbner efter mellemrum og linjestart, « lukker efter et bogstav", () => {
  assert.equal(smartQuote("", "guillemets", false), "»");
  assert.equal(smartQuote(" ", "guillemets", false), "»");
  assert.equal(smartQuote("(", "guillemets", false), "»");
  assert.equal(smartQuote("t", "guillemets", false), "«");
  assert.equal(smartQuote(".", "guillemets", false), "«");
  assert.equal(smartQuote(" ", "curly", false), "”");
  assert.equal(smartQuote("t", "curly", false), "”");
});

test("' i et ord er en apostrof", () => {
  assert.equal(smartQuote("s", "guillemets", true), "’");
  assert.equal(smartQuote(" ", "guillemets", true), "›");
  // De hævede og sænkede (6/10): „…“ og ‚…‘.
  assert.equal(smartQuote(" ", "low", false), "„");
  assert.equal(smartQuote("t", "low", false), "“");
  assert.equal(smartQuote(" ", "low", true), "‚");
  assert.equal(smartQuote("s", "low", true), "’");
});

test("afsnittet med markøren går fra tom linje til tom linje", () => {
  const s = EditorState.create({ doc: "Første.\n\nAnden linje\nfortsat.\n\nTredje." });
  const p = paragraphAt(s, 12);
  assert.equal(s.sliceDoc(p.from, p.to), "Anden linje\nfortsat.");
});

test("fast rulning følger tastaturet, ikke musen", () => {
  const state = EditorState.create({ doc: "En linje\nTo linjer" });
  assert.equal(movesCaret(state.update({ changes: { from: 0, insert: "x" }, userEvent: "input.type" })), true);
  assert.equal(movesCaret(state.update({ selection: { anchor: 12 }, userEvent: "select" })), true);
  assert.equal(movesCaret(state.update({ selection: { anchor: 12 }, userEvent: "select.pointer" })), false);
  assert.equal(movesCaret(state.update({ changes: { from: 0, insert: "x" }, userEvent: "input.drop" })), false);
  assert.equal(movesCaret(state.update({})), false);
});
