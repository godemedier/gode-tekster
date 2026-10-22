import { test } from "node:test";
import assert from "node:assert/strict";
import { linkAt } from "./links.ts";

test("markdown-link: målet findes overalt i linket", () => {
  const line = "Læs [vejledningen](Vejledning.md) først.";
  assert.equal(linkAt(line, 6), "Vejledning.md");
  assert.equal(linkAt(line, 25), "Vejledning.md");
  assert.equal(linkAt(line, 1), null);
  assert.equal(linkAt(line, 38), null);
});

test("link med titel og kodede mellemrum", () => {
  assert.equal(linkAt('[x](S%C3%A5dan%20virker.md "Titel")', 2), "S%C3%A5dan%20virker.md");
});

test("løs webadresse uden tegnsætningen efter", () => {
  const line = "Se https://godemedier.dk. Tak.";
  assert.equal(linkAt(line, 8), "https://godemedier.dk");
  assert.equal(linkAt(line, 28), null);
  assert.equal(linkAt("(<https://a.dk/b>)", 5), "https://a.dk/b");
});
