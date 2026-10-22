import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import { spellCandidates, spellTokens } from "./spelling.ts";
import { hiddenBlocks } from "./hidden.ts";

const checks = (text: string) => spellTokens(text).map((t) => t.check);

test("ord og positioner som i Rust (spelling.rs `ord_og_positioner`)", () => {
  const t = spellTokens("Én tekts, bl.a. med e-mail og kr. 5.");
  assert.deepEqual(
    t.map((x) => x.check),
    ["Én", "tekts", "bl.a.", "med", "e-mail", "og", "kr."],
  );
  assert.deepEqual([t[1].from, t[1].to], [3, 8]);
  // Stregen går under »kr«, punktummet sendes med til Hunspell.
  assert.deepEqual([t[6].from, t[6].to, t[6].word], [30, 32, "kr"]);
});

test("springer tal, CamelCase, forkortelser, #tags, adresser og enkeltbogstaver over (som spelling.rs `springer_over`)", () => {
  const text =
    "OneDrive iPhone GPL 3D 10kr H2O #tag @navn https://godemedier.dk/a www.dr.dk " +
    "godemedier.dk mail@x.dk C:\\Brugere\\x src/editor/x.ts a i Nord-Korea f.eks. og/eller";
  assert.deepEqual(checks(text), ["Nord-Korea", "f.eks.", "og", "eller"]);
});

test("positioner efter tegn uden for BMP (UTF-16 som i Rust)", () => {
  const t = spellTokens("😀 hej");
  assert.deepEqual([t[0].from, t[0].to], [3, 6]);
});

test("ingen streger i kode, links, skjulte blokke og fodnotehenvisninger, men i overskriftens tekst", () => {
  const doc = [
    "# Overskrft med tekts",
    "",
    "Brødtekts med `kodeord` og [linktekst](https://x.dk/sti) og <https://y.dk> og fodnote[^kildeord].",
    "",
    "```",
    "kodeblokord",
    "```",
    "",
    "<!-- gt:parkeret id=p1 dato=2026-10-09",
    "Parkeretord.",
    "-->",
    "",
    "#idé #kladde",
  ].join("\n");
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), hiddenBlocks] });
  ensureSyntaxTree(state, doc.length, 5000);
  const words = spellCandidates(state, [{ from: 0, to: doc.length }]).map((t) => t.word);
  assert.deepEqual(words, ["Overskrft", "med", "tekts", "Brødtekts", "med", "og", "og", "og", "fodnote"]);
});

test("kun de ønskede intervaller", () => {
  const doc = "første linje\nanden linje\ntredje linje";
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, doc.length, 5000);
  const from = doc.indexOf("anden");
  const words = spellCandidates(state, [{ from, to: from + "anden linje".length }]).map((t) => t.word);
  assert.deepEqual(words, ["anden", "linje"]);
});
