import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeSet, EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { addSpan, applyChanges, assign, authorshipField, authorshipHistory, mapSpans, setAuthorship, subtract, type Author, type AuthorshipState } from "./authorship.ts";

const skribent: Author = { kind: "human", name: "Kim Skribent", identifier: null };
const ai: Author = { kind: "ai", name: "Claude", identifier: null };

function state(): AuthorshipState {
  // "Hej verden. Dette er AI." : skribenten 0-11, AI 12-24
  return {
    me: skribent,
    pasted: [],
    external: [],
    authors: [
      { author: skribent, spans: [{ start: 0, end: 11 }] },
      { author: ai, spans: [{ start: 12, end: 24 }] },
    ],
  };
}

test("intervaller flyttes med tekst sat ind før dem", () => {
  const cs = ChangeSet.of({ from: 0, insert: "Nå. " }, 24);
  assert.deepEqual(mapSpans([{ start: 12, end: 24 }], cs), [{ start: 16, end: 28 }]);
});

test("tastet tekst inde i AI-tekst bliver skribentens og deler AI-intervallet", () => {
  const cs = ChangeSet.of({ from: 18, insert: "xx" }, 24);
  const s = applyChanges(state(), cs, "typed", [{ start: 18, end: 20 }]);
  const aiSpans = s.authors.find((a) => a.author.kind === "ai")!.spans;
  const mine = s.authors.find((a) => a.author.kind === "human")!.spans;
  assert.deepEqual(aiSpans, [{ start: 12, end: 18 }, { start: 20, end: 26 }]);
  assert.deepEqual(mine, [{ start: 0, end: 11 }, { start: 18, end: 20 }]);
});

test("indsat tekst får ingen forfatter", () => {
  const cs = ChangeSet.of({ from: 11, insert: " INDSAT" }, 24);
  const s = applyChanges(state(), cs, "unknown", [{ start: 11, end: 18 }]);
  for (const a of s.authors) {
    for (const sp of a.spans) assert.ok(sp.end <= 11 || sp.start >= 18, JSON.stringify(sp));
  }
});

test("slettet tekst forsvinder fra intervallerne", () => {
  const cs = ChangeSet.of({ from: 12, to: 24 }, 24);
  const s = applyChanges(state(), cs, "unknown", []);
  assert.equal(s.authors.find((a) => a.author.kind === "ai"), undefined, "en forfatter uden tekst fjernes");
});

test("skribentens første tegn i en fil uden forfatterskab opretter skribenten", () => {
  const empty: AuthorshipState = { me: skribent, authors: [], pasted: [], external: [] };
  const cs = ChangeSet.of({ from: 0, insert: "a" }, 0);
  const s = applyChanges(empty, cs, "typed", [{ start: 0, end: 1 }]);
  assert.deepEqual(s.authors, [{ author: skribent, spans: [{ start: 0, end: 1 }] }]);
});

test("hjælpefunktionerne", () => {
  assert.deepEqual(subtract([{ start: 0, end: 10 }], { start: 3, end: 5 }), [
    { start: 0, end: 3 },
    { start: 5, end: 10 },
  ]);
  assert.deepEqual(addSpan([{ start: 0, end: 3 }], { start: 3, end: 5 }), [{ start: 0, end: 5 }]);
});

test("indsat tekst markeres som indsat, til skribenten vælger", () => {
  const cs = ChangeSet.of({ from: 11, insert: " INDSAT" }, 24);
  const s = applyChanges(state(), cs, "pasted", [{ start: 11, end: 18 }]);
  assert.deepEqual(s.pasted, [{ start: 11, end: 18 }]);
  const mine = assign(s, { start: 11, end: 18 }, "me");
  assert.deepEqual(mine.pasted, []);
  assert.ok(mine.authors.find((a) => a.author.kind === "human")!.spans.some((sp) => sp.start <= 11 && sp.end >= 18));
});

test("Ctrl+Alt+V: indsat som AI", () => {
  const cs = ChangeSet.of({ from: 0, insert: "AI: " }, 24);
  const s = applyChanges(state(), cs, "ai", [{ start: 0, end: 4 }]);
  assert.ok(s.authors.find((a) => a.author.kind === "ai")!.spans.some((sp) => sp.start === 0 && sp.end >= 4));
});

test("tekst rettet udefra bliver Claudes og får stribe", () => {
  const cs = ChangeSet.of({ from: 11, insert: " NY" }, 24);
  const s = applyChanges(state(), cs, "external", [{ start: 11, end: 14 }]);
  assert.deepEqual(s.external, [{ start: 11, end: 14 }]);
  assert.ok(s.authors.find((a) => a.author.kind === "ai")!.spans.some((sp) => sp.start === 11));
});

test("fortryd giver slettet tekst sin forfatter igen", () => {
  let st = EditorState.create({ doc: "Hej verden. Dette er AI.", extensions: [history(), authorshipField, authorshipHistory] });
  st = st.update({ effects: setAuthorship.of(state()) }).state;
  st = st.update({ changes: { from: 12, to: 24 }, userEvent: "delete.backward" }).state;
  assert.equal(st.field(authorshipField).authors.find((a) => a.author.kind === "ai"), undefined);
  undo({ state: st, dispatch: (tr) => (st = tr.state) });
  assert.equal(st.doc.toString(), "Hej verden. Dette er AI.");
  assert.deepEqual(st.field(authorshipField).authors.find((a) => a.author.kind === "ai")!.spans, [{ start: 12, end: 24 }]);
});
