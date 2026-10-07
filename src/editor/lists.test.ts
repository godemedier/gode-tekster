import { test } from "node:test";
import assert from "node:assert/strict";
import { parser } from "@lezer/markdown";
import { fancyListBlocks } from "./lists.ts";

const names = (doc: string) => {
  const out: string[] = [];
  parser.configure([fancyListBlocks]).parse(doc).iterate({ enter: (n) => void out.push(n.name) });
  return out;
};

test("en »-« under en bogstavliste gør den ikke til en overskrift (optagelse 5/10)", () => {
  const n = names("a. Jeg forventer\nb. sadsad\nc. dsf\n-\nundskyldning.");
  assert.ok(!n.includes("SetextHeading2"));
  assert.ok(n.includes("BulletList"));
  // Et almindeligt afsnit med »-« under er stadig en overskrift.
  assert.ok(names("Overskrift\n-").includes("SetextHeading2"));
});
