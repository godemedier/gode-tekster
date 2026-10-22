import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { keepMarks } from "./keepMarks.ts";

/** `[…]` er markeringen, som skrives over med `insert`. */
function replace(text: string, insert: string): string {
  const from = text.indexOf("[");
  const to = text.indexOf("]") - 1;
  const doc = text.replace("[", "").replace("]", "");
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, doc.length, 1000);
  const edits = keepMarks(state, { from, to, insert }) ?? [{ from, to, insert }];
  let out = doc;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

test("en markering ind i fed beholder det åbnende mærke, og det skrevne står uden for", () => {
  assert.equal(replace("Den[ **samme bes]ked**: ja", "et samme"), "Denet samme**ked**: ja");
});

test("en markering ud af fed beholder det lukkende mærke, og det skrevne står inde i", () => {
  assert.equal(replace("Den **sam[me besked**: j]a", "X"), "Den **samX**a");
});

test("hen over begge ender af kursiv: hele parret går, som det skal", () => {
  assert.equal(replace("Er [*færdig*.] Ja", "klar."), "Er klar. Ja");
});

test("en markering helt inde i fed rører ikke mærkerne", () => {
  assert.equal(replace("**sa[mm]e**", "x"), "**saxe**");
});

test("gennemstreget og fed på én gang, og mærket flytter hen over mellemrummet", () => {
  assert.equal(replace("a[ ~~b c~~ **d] e**", "Z"), "aZ **e**");
});

test("slettet ud af fed lige efter et mellemrum: mærket flytter før mellemrummet", () => {
  assert.equal(replace("**sam [me** x]y", ""), "**sam** y");
});
