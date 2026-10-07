import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { hiddenBlocks } from "./hidden.ts";
import { expandParkRange, paragraphAt } from "./parkRange.ts";

const state = (doc: string) => {
  const s = EditorState.create({ doc, extensions: [hiddenBlocks, markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(s, s.doc.length, 5000);
  return s;
};
const slice = (s: EditorState, r: { from: number; to: number } | null) => (r ? s.sliceDoc(r.from, r.to) : null);

test("en markering, der slutter før en usynlig »-->«, tager hele noten med (5/10)", () => {
  const doc = "Tallet er 5 mia. <!-- tjek hos DST --> og mere.";
  const s = state(doc);
  const from = doc.indexOf("Tallet");
  const to = doc.indexOf(" -->");
  assert.equal(slice(s, expandParkRange(s, { from, to })), "Tallet er 5 mia. <!-- tjek hos DST -->");
});

test("halve ord, fed og dæmpning bliver hele", () => {
  const doc = "Et **meget vigtigt** ord og {--dæmpet tekst--} her.";
  const s = state(doc);
  assert.equal(slice(s, expandParkRange(s, { from: doc.indexOf("eget"), to: doc.indexOf("igt") })), "**meget vigtigt**");
  assert.equal(slice(s, expandParkRange(s, { from: doc.indexOf("pet"), to: doc.indexOf(" her") })), "{--dæmpet tekst--}");
  assert.equal(slice(s, expandParkRange(s, { from: 1, to: 2 })), "Et");
});

test("det sidste afsnit stopper før fraklippene", () => {
  const block = "<!-- gt:parkeret id=p1 dato=2026-10-05\nEt klip.\n-->";
  const doc = `Første.\n\nSidste afsnit\nover to linjer.\n${block}\n`;
  const s = state(doc);
  assert.equal(slice(s, paragraphAt(s, doc.indexOf("over"))), "Sidste afsnit\nover to linjer.");
  assert.equal(paragraphAt(s, doc.indexOf("\n\nSidste") + 1), null);
});
