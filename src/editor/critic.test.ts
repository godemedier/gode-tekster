import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptChanges, apply, findNotes, findRevisions, markupFor, rejectChanges, resolvePending, withRevisions } from "./critic.ts";

test("noter inde i forslag giver ingen overlappende udskiftninger", () => {
  assert.equal(resolvePending("Start {~~gammel <!-- note -->~>ny~~} slut"), "Start gammel slut");
  assert.equal(resolvePending("Start {~~gammel~>ny <!-- note -->~~} slut"), "Start gammel slut");
  assert.equal(resolvePending("Start {++ny <!-- note -->++} slut"), "Start  slut");
});

const doc = "Det kostede {~~5~>6~~} mia. kr.{++ i alt++} {>> tjek hos FMI <<}og{~~ meget~>~~} mere.";

test("en halv rettelse sluger ikke teksten før den næste rettelse", () => {
  for (const prefix of ["{++", "{~~a~>", "{>>", "<!--"]) {
    const text = `${prefix}\nVigtig tekst.\n{++forslag++}\nRest.`;
    const revisions = findRevisions(text);
    assert.equal(revisions.length, 1);
    assert.equal(apply(text, rejectChanges(revisions[0])), `${prefix}\nVigtig tekst.\n\nRest.`);
  }
  assert.equal(findRevisions("{~~a~>".repeat(20_000)).length, 0);
});

test("forslag i kode, kommentarer og fraklip er ikke aktive", () => {
  const text = "`{++kode++}`\n```\n{~~a~>b~~}\n```\n<!-- note {++skjult++} -->\n<!-- gt:parkeret id=p1 dato=2026-10-10\n{++klip++}\n-->";
  assert.deepEqual(findRevisions(text), []);
  assert.equal(findNotes(text).length, 1);
  assert.ok(resolvePending(text).includes("{++kode++}"));
});

test("noter og rettelser findes", () => {
  assert.deepEqual(findNotes(doc).map((n) => n.text), ["tjek hos FMI"]);
  const r = findRevisions(doc);
  assert.deepEqual(r.map((x) => [x.kind, x.old, x.next]), [
    ["sub", "5", "6"],
    ["ins", "", " i alt"],
    ["sub", " meget", ""],
  ]);
});

test("en rettelse, der ikke er taget stilling til, tæller som den oprindelige tekst", () => {
  assert.equal(resolvePending(doc), "Det kostede 5 mia. kr.og meget mere.");
});

test("godtag og afvis", () => {
  const [sub, ins, del] = findRevisions(doc);
  assert.ok(apply(doc, acceptChanges(sub)).startsWith("Det kostede 6 mia."));
  assert.ok(apply(doc, rejectChanges(sub)).startsWith("Det kostede 5 mia."));
  assert.ok(apply(doc, acceptChanges(ins)).includes("kr. i alt {>>"));
  assert.ok(apply(doc, rejectChanges(ins)).includes("kr. {>>"));
  assert.ok(apply(doc, acceptChanges(del)).endsWith("og mere."));
  assert.ok(apply(doc, rejectChanges(del)).endsWith("og meget mere."));
});

test("sammenligning med en tidligere udgave: kun mærker omkring den nuværende tekst", () => {
  const old = "Prisen var 5 mia. og steg.";
  const now = "Prisen var 6 mia. og steg hurtigt.";
  // ændringer fra old til now, i old's koordinater
  const edits = [
    { from: 11, to: 12, insert: "6" },
    { from: 25, to: 25, insert: " hurtigt" },
  ];
  const marked = apply(now, markupFor(edits, old));
  assert.equal(marked, "Prisen var {~~5~>6~~} mia. og steg{++ hurtigt++}.");
  assert.equal(resolvePending(marked), old);
});

test("redaktørens ændringer skrevet ind i den gamle tekst", () => {
  const old = "Prisen var 5 mia. og steg.";
  const marked = withRevisions(old, [
    { from: 11, to: 12, insert: "6" },
    { from: 25, to: 25, insert: " hurtigt" },
  ]);
  assert.equal(marked, "Prisen var {~~5~>6~~} mia. og steg{++ hurtigt++}.");
  assert.equal(resolvePending(marked), old);
});

test("noter som HTML-kommentarer, men ikke programmets egne gt-blokke (5/10)", () => {
  const d = "Tal <!-- tjek hos DST --> her.\n<!-- gt:parkeret id=p1 dato=2026-10-05\nklip\n-->\nOg {>> gammel note <<}.";
  const notes = findNotes(d);
  assert.deepEqual(notes.map((n) => n.text), ["tjek hos DST", "gammel note"]);
  assert.deepEqual([notes[0].open, notes[0].close, notes[1].open], [4, 3, 3]);
  assert.equal(resolvePending("Tal <!-- tjek --> her."), "Tal her.");
});
