import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { commentPosition, directEdit, finishComposition, setSuggesting, suggest, suggestMode, suggesting } from "./suggest.ts";

// `|` er markøren, `[…]` en markering.
function start(text: string): EditorState {
  const doc = text.replace(/[|[\]]/g, "");
  const caret = text.indexOf("|");
  const a = text.indexOf("[");
  const selection = a >= 0 ? { anchor: a, head: text.indexOf("]") - 1 } : { anchor: caret };
  return EditorState.create({ doc, selection, extensions: suggestMode(true) });
}
const show = (s: EditorState) => {
  const d = s.doc.toString();
  const h = s.selection.main.head;
  return d.slice(0, h) + "|" + d.slice(h);
};
const type = (s: EditorState, text: string) => {
  for (const ch of text) {
    const { from, to } = s.selection.main;
    s = s.update({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: "input.type" }).state;
  }
  return s;
};
const back = (s: EditorState, n = 1) => {
  for (let i = 0; i < n; i++) {
    const { from, to } = s.selection.main;
    const spec: TransactionSpec = from === to ? { changes: { from: from - 1, to: from }, userEvent: "delete.backward" } : { changes: { from, to }, userEvent: "delete.selection" };
    s = s.update(spec).state;
  }
  return s;
};
const del = (s: EditorState, n = 1) => {
  for (let i = 0; i < n; i++) {
    const h = s.selection.main.head;
    s = s.update({ changes: { from: h, to: h + 1 }, userEvent: "delete.forward" }).state;
  }
  return s;
};

test("skrevet tekst bliver ét indsættelsesforslag, og markøren bliver i det", () => {
  assert.equal(show(type(start("Et |ord"), "nyt ")), "Et {++nyt |++}ord");
});

test("Backspace foreslår sletning og samler den med sletningen ved siden af", () => {
  assert.equal(show(back(start("Et ord|."), 3)), "Et |{~~ord~>~~}.");
});

test("Delete foreslår sletning fremad og samler den", () => {
  assert.equal(show(del(start("Et |ord."), 3)), "Et {~~ord~>~~}|.");
});

test("skrive over en markering giver en erstatning", () => {
  assert.equal(show(type(start("Et [ord] her"), "andet")), "Et {~~ord~>andet|~~} her");
});

test("skrive lige efter en sletning giver en erstatning", () => {
  assert.equal(show(type(back(start("Et ord| her"), 3), "andet")), "Et {~~ord~>andet|~~} her");
});

test("Backspace i egen indsættelse sletter direkte, og et tomt forslag forsvinder", () => {
  let s = type(start("Et |ord"), "ny");
  s = back(s);
  assert.equal(show(s), "Et {++n|++}ord");
  s = back(s);
  assert.equal(show(s), "Et |ord");
});

test("en foreslået sletning kan ikke slettes igen: Backspace går videre til tegnet før", () => {
  let s = back(start("abc|d"), 1);
  assert.equal(show(s), "ab|{~~c~>~~}d");
  // Markøren efter forslaget (fx sat med musen): Backspace sletter »b«, ikke mærket.
  s = s.update({ selection: { anchor: s.doc.length - 1 } }).state;
  s = back(s);
  assert.equal(s.doc.toString(), "a{~~bc~>~~}d");
});

test("tekst skrevet før en foreslået sletning lægges sammen med den", () => {
  const s = type(back(start("abc|d"), 1), "x");
  assert.equal(s.doc.toString(), "ab{~~c~>x~~}d");
});

test("æøå og emoji bevares som hele tegn", () => {
  assert.equal(show(type(start("Hej |"), "blåbær 😀")), "Hej {++blåbær 😀|++}");
  assert.equal(show(back(start("ø😀|"), 1)), "ø|{~~😀~>~~}");
});

test("godtag, afvis, fortryd og rettelser udefra går uden om filteret", () => {
  const s = start("Et |ord");
  const direct = s.update({ changes: { from: 0, insert: "X" }, annotations: directEdit.of(true) }).state;
  assert.equal(direct.doc.toString(), "XEt ord");
  const ext = s.update({ changes: { from: 0, insert: "Y" }, userEvent: "input.external" }).state;
  assert.equal(ext.doc.toString(), "YEt ord");
});

test("slået fra skrives der direkte", () => {
  const s = start("Et |ord").update({ effects: setSuggesting.of(false) }).state;
  assert.equal(s.field(suggesting), false);
  assert.equal(show(type(s, "nyt ")), "Et nyt |ord");
});

test("en komposition (IME, Gboard) laves om, når den er færdig", () => {
  let s = start("Et |ord");
  for (const step of ["d", "da", "dan"]) {
    const h = s.selection.main.head;
    const from = h - (step.length - 1);
    s = s.update({ changes: { from, to: h, insert: step }, selection: { anchor: from + step.length }, userEvent: "input.type.compose" }).state;
  }
  assert.equal(s.doc.toString(), "Et danord");
  const done = finishComposition(s);
  assert.ok(done);
  s = s.update({ changes: done.changes, selection: { anchor: done.caret }, annotations: directEdit.of(true) }).state;
  assert.equal(show(s), "Et {++dan|++}ord");
});

test("kernen: et forslag midt i et ord og flere linjer", () => {
  assert.deepEqual(suggest("abcd", { from: 1, to: 3, insert: "" }, "back"), { from: 1, to: 3, insert: "{~~bc~>~~}", caret: 1 });
  const r = suggest("En.\n\nTo.", { from: 3, to: 5, insert: "" }, "forward");
  assert.equal(r?.insert, "{~~\n\n~>~~}");
});

test("det, der skrives i en kommentar, er ikke et forslag", () => {
  let s = start("Et ord <!-- | --> her");
  s = type(s, "tjek");
  assert.equal(s.doc.toString(), "Et ord <!-- tjek --> her");
  s = back(s, 2);
  assert.equal(s.doc.toString(), "Et ord <!-- tj --> her");
});

test("en kommentar lægges efter et forslag, aldrig inde i det", () => {
  const doc = "Et {~~gammelt ord~>nyt~~} her <!-- note --> slut";
  assert.equal(commentPosition(doc, doc.indexOf("ord")), doc.indexOf(" her"));
  assert.equal(commentPosition(doc, doc.indexOf("note")), doc.indexOf(" slut"));
  assert.equal(commentPosition(doc, 2), 2);
});

test("en kommentar lægges efter ordet, når markeringen slutter midt i det", () => {
  const doc = "Det lyder enkelt, og {++det++} er så.";
  assert.equal(commentPosition(doc, doc.indexOf("kelt")), doc.indexOf(","));
  assert.equal(commentPosition(doc, doc.indexOf("et++}")), doc.indexOf(" er"));
  assert.equal(commentPosition(doc, doc.indexOf(" så")), doc.indexOf(" så"));
});

test("en markering hen over en kommentar sletter kommentaren direkte og foreslår resten slettet", () => {
  assert.equal(show(back(start("Før [to <!-- husk --> ord] efter"))), "Før {~~to  ord~>~~}| efter");
  assert.equal(show(type(start("Før [to <!-- husk --> ord] efter"), "x")), "Før {~~to  ord~>x|~~} efter");
  // Kun kommentaren markeret: den forsvinder uden forslag.
  assert.equal(show(back(start("Før [<!-- husk -->] efter"))), "Før | efter");
  // En kommentar inde i et forslag røres ikke.
  assert.equal(show(back(start("Før [{++a <!-- k --> b++}] efter"))), "Før | efter");
});
