import { test } from "node:test";
import assert from "node:assert/strict";
import { matches, snippet } from "./noteSearch.ts";

const note = { title: "Indkøb", text: "Indkøb\n\nMælk, brød og kaffe til mødet torsdag med Anne." };

test("alle søgeord skal stå i noten, store og små bogstaver er lige", () => {
  assert.ok(matches(note, ""));
  assert.ok(matches(note, "MÆLK anne"));
  assert.ok(!matches(note, "mælk ost"));
});

test("uddraget springer titlen over og viser søgeordet i en lang note", () => {
  assert.equal(snippet(note, ""), "Mælk, brød og kaffe til mødet torsdag med Anne.");
  assert.equal(snippet({ title: "Indkøb", text: "# Indkøb\n\nMælk" }, ""), "Mælk");
  const long = { title: "Lang", text: `Lang ${"fyld ".repeat(30)}nøgleordet her` };
  assert.match(snippet(long, "nøgleordet"), /^… .*nøgleordet her$/);
});
