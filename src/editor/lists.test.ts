import { test } from "node:test";
import assert from "node:assert/strict";
import { parser } from "@lezer/markdown";
import { fancyListBlocks, listLineBreak } from "./lists.ts";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";

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

test("gentagne Shift+Enter bevarer afsnit i samme listepunkt", () => {
  for (const [doc, indent] of [["- Første", "  "], ["12. Første", "    "], ["- [ ] Første", "  "], ["- Ydre\n  - Indre", "    "], ["> - Første", ">   "]]) {
    let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: markdown() });
    for (let i = 0; i < 3; i++) {
      assert.ok(listLineBreak({ state, dispatch: (tr) => { state = tr.state; } }));
      assert.equal(state.doc.lineAt(state.selection.main.head).text, indent);
    }
    state = state.update({ changes: { from: state.selection.main.head, insert: "Nyt afsnit" } }).state;
    const items: number[] = [];
    parser.parse(state.doc.toString()).iterate({ enter: (n) => { if (n.name === "ListItem") items.push(n.from); } });
    assert.equal(items.length, doc.includes("Indre") ? 2 : 1);
  }
});

test("liste-linjeskift overtager ikke almindelig tekst, kode eller skrivebeskyttet tekst", () => {
  for (const doc of ["Almindelig tekst", "```\n- Kode"] ) {
    const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: markdown() });
    assert.equal(listLineBreak({ state, dispatch: () => assert.fail("Må ikke ændre teksten") }), false);
  }
  const state = EditorState.create({ doc: "- Tekst", selection: { anchor: 7 }, extensions: [markdown(), EditorState.readOnly.of(true)] });
  assert.equal(listLineBreak({ state, dispatch: () => assert.fail("Må ikke ændre teksten") }), false);
});
