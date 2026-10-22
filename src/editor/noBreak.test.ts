import { test } from "node:test";
import assert from "node:assert/strict";
import { Text } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { noBreakMarks } from "./noBreak.ts";

const hide = Decoration.replace({});
const marks = (s: string, ranges: [number, number][]) =>
  noBreakMarks(Text.of(s.split("\n")), ranges.map(([a, b]) => hide.range(a, b))).map((r) => s.slice(r.from, r.to));

test("komma efter fed holdes sammen med ordet før (19/10)", () => {
  const s = "kræver **samtykke**, medmindre";
  const a = s.indexOf("**");
  const b = s.lastIndexOf("**");
  // Åbningen holdes sammen med »s« (mellemrummet foran må brydes). Lukningen står mellem »e« og »,«.
  assert.deepEqual(marks(s, [[a, a + 2], [b, b + 2]]), ["**s", "e**,"]);
});

test("fodnotetallet følger tegnet før, også med mellemrum efter (19/10)", () => {
  const s = "bedt om.[^6] Login";
  const a = s.indexOf("[^6]");
  assert.deepEqual(marks(s, [[a, a + 4]]), [".[^6]"]);
});

test("skjulte tegn, der støder op til hinanden, er ét hul", () => {
  const s = "ord***fed og kursiv***.";
  const b = s.lastIndexOf("***");
  assert.deepEqual(marks(s, [[b, b + 1], [b + 1, b + 3]]), ["v***."]);
});

test("ved linjens kant holdes kun den side sammen, der har tekst", () => {
  const s = "**Fed** ord\n*kursiv*";
  assert.deepEqual(marks(s, [[0, 2], [5, 7], [12, 13], [19, 20]]), ["**F", "d**", "*k", "v*"]);
});

test("mellemrum på begge sider: intet at holde sammen", () => {
  assert.deepEqual(marks("ord ** ord", [[4, 6]]), []);
});

test("tegn uden for BMP deles ikke midt over", () => {
  const s = "ord😀**fed**";
  const a = s.indexOf("**");
  assert.deepEqual(marks(s, [[a, a + 2]]), ["😀**f"]);
});

test("blokke og widgets uden længde tæller ikke", () => {
  const doc = Text.of(["før**efter"]);
  const out = noBreakMarks(doc, [Decoration.replace({ block: true }).range(3, 5), Decoration.widget({ widget: null as never }).range(4)]);
  assert.deepEqual(out, []);
});
