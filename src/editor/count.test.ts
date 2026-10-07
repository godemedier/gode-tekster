import { test } from "node:test";
import assert from "node:assert/strict";
import { count, formatCount, readableText } from "./count.ts";

test("markdown-tegn tæller ikke", () => {
  const c = count("# Overskrift\n\nEt **fedt** og *kursivt* [link](https://x.dk).\n\n- [ ] punkt");
  assert.equal(c.words, 7);
  assert.equal(readableText("> »Citat«").trim(), "»Citat«");
});

test("fraklip og dæmpet tekst tæller ikke, fodnoterne gør (ADR-0017)", () => {
  const md = "Med en note.[^1] {--Måske ud.--}\n\n[^1]: Kilde her.\n\n<!-- gt:parkeret id=p1 dato=2026-10-02\nParkeret tekst med mange ord\n-->\n";
  assert.equal(count(md).words, 5);
});

test("bindestreg, apostrof og tal er ét ord", () => {
  assert.equal(count("EU-landene købte 1.200 F-35-fly i 2023").words, 6);
});

test("anslag og normalsider", () => {
  const c = count("a".repeat(2400));
  assert.equal(c.chars, 2400);
  assert.equal(c.pages, 1);
  assert.deepEqual(formatCount(c).long.slice(1, 3), ["2.400 anslag", "1,0 normalsider"]);
});

test("ord og anslag tælles som i Word", () => {
  // Word: linjeskift tæller ikke, dobbelte mellemrum gør, og en løs tankestreg er et ord.
  const c = count("Første  linje med dobbelt mellemrum.\nAnden – linje.");
  assert.equal(c.words, 8);
  assert.equal(c.chars, "Første  linje med dobbelt mellemrum.".length + "Anden – linje.".length);
});

test("tom tekst", () => {
  assert.deepEqual(count(""), { words: 0, chars: 0, pages: 0, minutes: 0 });
});
