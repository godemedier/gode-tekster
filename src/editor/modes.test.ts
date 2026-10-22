import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { inOpenCode, movesCaret, paragraphAt, smartQuote } from "./modes.ts";

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

test("anførselstegn efter markdowntegn, /, tal og i indlejrede citater (fejljagt F2-B6, B7)", () => {
  assert.equal(smartQuote("**", "guillemets", false), "»");
  assert.equal(smartQuote("se *", "guillemets", false), "»");
  assert.equal(smartQuote("{++", "guillemets", false), "»");
  assert.equal(smartQuote("og/", "guillemets", false), "»");
  assert.equal(smartQuote("**", "low", false), "„");
  assert.equal(smartQuote("**»citat", "guillemets", false), "«");
  // Tommer efter et tal, når intet citat er åbent. Ellers lukker det citatet.
  assert.equal(smartQuote("En 27", "guillemets", false), "″");
  assert.equal(smartQuote("»Det skete i 2024", "guillemets", false), "«");
  // Indlejret: › lukkes med ‹. Uden åbent › er ' en apostrof.
  assert.equal(smartQuote("»Han sagde ›nej", "guillemets", true), "‹");
  assert.equal(smartQuote("»Han sagde ‚nej", "low", true), "‘");
  assert.equal(smartQuote("i 80", "guillemets", true), "’");
  assert.equal(smartQuote("Niels", "guillemets", true), "’");
  assert.ok(inOpenCode("Brug `a="));
  assert.ok(!inOpenCode("Brug `a` og "));
});
