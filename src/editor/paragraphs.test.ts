import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bookLines as lines } from "./paragraphs.ts";

const state = (doc: string, cursor = doc.length) =>
  EditorState.create({ doc, selection: { anchor: cursor }, extensions: [markdown({ base: markdownLanguage })] });
// Det færdigparsede træ, ikke statens eget (det kan være halvt under belastning).
const bookLines = (s: EditorState) => lines(s, ensureSyntaxTree(s, s.doc.length, 5000)!);
const lineNo = (s: EditorState, positions: number[]) => positions.map((p) => s.doc.lineAt(p).number);

test("kun afsnit efter afsnit rykkes ind, og luften imellem klappes sammen", () => {
  const s = state("# Overskrift\n\nFørste afsnit.\n\nAndet afsnit.\n\nTredje.\n\n- liste\n\nEfter listen.");
  const { indents, gaps } = bookLines(s);
  assert.deepEqual(lineNo(s, indents), [5, 7]);
  assert.deepEqual(lineNo(s, gaps), [4, 6]);
});

test("den tomme linje med markøren bliver stående", () => {
  const doc = "Et.\n\nTo.";
  const s = state(doc, 4);
  assert.deepEqual(bookLines(s).gaps, []);
  assert.deepEqual(lineNo(s, bookLines(s).indents), [3]);
});

test("citat og overskrift bryder kæden", () => {
  const s = state("Et.\n\n> citat\n\nTo.\n\n## H\n\nTre.");
  assert.deepEqual(bookLines(s).indents, []);
});

test("to tomme linjer giver luft: den første står, næste afsnit rykkes ikke ind", () => {
  const s = state("Et.\n\nTo.\n\n\nTre.\n\nFire.", 0);
  const { indents, gaps } = bookLines(s);
  assert.deepEqual(lineNo(s, indents), [3, 8]);
  assert.deepEqual(lineNo(s, gaps), [2, 5, 7]);
});
