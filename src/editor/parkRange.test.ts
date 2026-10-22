import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { hiddenBlocks, visibleText } from "./hidden.ts";
import { parkChanges } from "./parked.ts";
import { addStructurePart, structureParts } from "./structure.ts";
import { expandParkRange, paragraphAt, parkPlan } from "./parkRange.ts";

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

// 14/10: en markering hen over en Struktur-del stoppede ved delens mærke, og et træk til spalten
// fjernede intet, fordi trækket bar teksten uden mærkerne.
function withPart(): { s: EditorState; doc: string } {
  const before = "Første afsnit.\n\n### Udspil\n- a\n\n";
  const inside = "### Del\n- b\n";
  const after = "\n### Efter\n- c\n";
  let doc = before + inside + after;
  let s = state(doc);
  s = s.update({ changes: addStructurePart(doc, before.length, before.length + inside.length, "Del")!, userEvent: "input.structure" }).state;
  doc = s.doc.toString();
  return { s: state(doc), doc };
}

test("fraklip hen over en Struktur-del: al teksten flyttes, delens mærker bliver", () => {
  const { s, doc } = withPart();
  assert.match(doc, /<!-- gt:del[\s\S]*### Del[\s\S]*<!-- gt:slut/);
  const span = expandParkRange(s, { from: doc.indexOf("### Udspil"), to: doc.length });
  const plan = parkPlan(s, span)!;
  assert.equal(plan.text, "### Udspil\n- a\n\n### Del\n- b\n\n### Efter\n- c");
  const out = s.update({ changes: parkChanges(doc, [plan.text], plan.remove, "2026-10-14"), userEvent: "delete.park" }).state.doc.toString();
  const body = out.slice(0, out.indexOf("<!-- gt:parkeret"));
  assert.ok(body.startsWith("Første afsnit."));
  assert.doesNotMatch(body, /- a|- b|- c/);
  assert.equal(structureParts(out).length, 1);
  assert.match(out, /<!-- gt:parkeret id=p1 dato=2026-10-14\n### Udspil\n- a\n\n### Del\n- b\n\n### Efter\n- c\n-->/);
});

test("trækket bærer teksten uden mærkerne, så spalten kan genkende markeringen", () => {
  const { s, doc } = withPart();
  const text = visibleText(s, doc.indexOf("### Udspil"), doc.length);
  assert.doesNotMatch(text, /gt:del|gt:slut/);
  assert.match(text, /### Udspil[\s\S]*### Del[\s\S]*### Efter/);
});
