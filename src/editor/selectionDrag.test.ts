import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { selectionDrag } from "./selectionDrag.ts";

const state = EditorState.create({ doc: "Dansk æøå og emoji 🐈. Mere tekst.", selection: { anchor: 0, head: 21 }, extensions: selectionDrag });
const makeStyle = state.facet(EditorView.mouseSelectionStyle)[0];
const click = { button: 0, detail: 1, clientX: 20, clientY: 10, type: "mousedown" } as MouseEvent;
const viewAt = (position: number | null) => ({ state, posAtCoords: () => position }) as unknown as EditorView;

test("hurtigt træk bevarer hele markeringen, mens et klik placerer markøren", () => {
  const style = makeStyle(viewAt(8), click);
  assert.ok(style);
  assert.ok(style.get({ type: "mousemove" } as MouseEvent, false, false).eq(state.selection));
  assert.equal(style.get(click, false, false).main.head, 8);
  assert.ok(style.get({ type: "mousemove" } as MouseEvent, false, false).eq(state.selection));
});

test("nye markeringer, dobbeltklik og tastaturmodifikatorer beholder normal adfærd", () => {
  for (const position of [null, 0, 21, 29]) assert.equal(makeStyle(viewAt(position), click), null);
  for (const override of [{ button: 2 }, { detail: 2 }, { detail: 3 }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(makeStyle(viewAt(8), { ...click, ...override } as MouseEvent), null);
  }
});

test("markering og kliksted følger ændringer i dokumentet under trækket", () => {
  const style = makeStyle(viewAt(8), click);
  assert.ok(style);
  const changes = state.changes({ from: 0, insert: "Ny: " });
  style.update({ changes } as ViewUpdate);
  const moved = style.get({ type: "mousemove" } as MouseEvent, false, false).main;
  assert.equal(moved.to, 25);
  assert.equal(style.get(click, false, false).main.head, 12);
});
