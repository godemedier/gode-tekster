import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";

import { cutChanges, dimmedInBody, parkDimmedChanges, undimChanges } from "./dimming.ts";

const apply = (doc: string, changes: { from: number; to?: number; insert: string }[]) =>
  EditorState.create({ doc }).update({ changes }).state.doc.toString();

test("Skær dæmper alle forslag på én gang og springer det umulige over", () => {
  const doc = "Det er en klar dag. Det var i øvrigt en meget kold dag. {--Allerede dæmpet--} slut.";
  const r = cutChanges(doc, [{ quote: "i øvrigt " }, { quote: "meget " }, { quote: "findes ikke" }, { quote: "Allerede" }]);
  assert.equal(r.count, 2);
  assert.equal(r.words, 3);
  assert.equal(apply(doc, r.changes), "Det er en klar dag. Det var {--i øvrigt --}en {--meget --}kold dag. {--Allerede dæmpet--} slut.");
});

test("Skær rører ikke fraklip og andre skjulte blokke sidst i filen", () => {
  const doc = "Tekst med ord.\n\n<!-- gt:parkeret id=p1 dato=2026-10-02\nord\n-->\n";
  const r = cutChanges(doc, [{ quote: "ord" }]);
  assert.equal(apply(doc, r.changes), "Tekst med {--ord--}.\n\n<!-- gt:parkeret id=p1 dato=2026-10-02\nord\n-->\n");
});

test("Fjern dæmpning lader teksten stå", () => {
  const doc = "En {--meget --}kold dag.";
  const [d] = dimmedInBody(doc);
  assert.equal(apply(doc, undimChanges(d)), "En meget kold dag.");
});

test("al dæmpet tekst til fraklip: uden dobbelte mellemrum og tomme afsnit", () => {
  const doc = "En {--meget--} kold dag.\n\n{--Et helt afsnit, der skal ud.--}\n\nSidste afsnit.\n";
  const out = apply(doc, parkDimmedChanges(doc, dimmedInBody(doc), "2026-10-02"));
  assert.equal(
    out,
    "En kold dag.\n\nSidste afsnit.\n\n<!-- gt:parkeret id=p1 dato=2026-10-02\nmeget\n-->\n\n<!-- gt:parkeret id=p2 dato=2026-10-02\nEt helt afsnit, der skal ud.\n-->\n",
  );
});
