import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chapters, chapterTexts, chapterTitle, expandChapters, findChapters, setChapterTexts } from "./chapters.ts";

test("kapitellinjer som i iA Writer, men ikke i kode, ikke // og ikke andre filtyper", () => {
  const doc = "# Ansøgning\n\n/Indledning.md\n/dele/Metode og data.md  \n//kommentar.md\n/ ikke.md\n/billede.png\n```\n/i-kode.md\n```\nTekst /midt.md i linjen";
  assert.deepEqual(findChapters(doc).map((c) => c.name), ["Indledning.md", "dele/Metode og data.md"]);
  const first = findChapters(doc)[0];
  assert.equal(doc.slice(first.from, first.to), "/Indledning.md");
});

test("kapitlets titel er første overskrift, ellers filnavnet", () => {
  assert.equal(chapterTitle("Ind.md", "Tekst\n\n## Baggrund\n"), "Baggrund");
  assert.equal(chapterTitle("dele/Metode.md", "Ingen overskrift"), "Metode");
  assert.equal(chapterTitle("Mangler.md", null), "Mangler");
});

test("print samler kapitlerne, og fodnoterne får kapitlets nummer", () => {
  const doc = "# Bog\n\n/A.md\n\n/B.md\n\n/C.md\n\nSlut.";
  const texts = new Map<string, string | null>([["A.md", "Et[^1].\n\n[^1]: a"], ["B.md", "To[^1].\n\n[^1]: b\n"], ["C.md", null]]);
  const out = expandChapters(doc, texts);
  assert.match(out, /^# Bog\n\nEt\[\^k1-1\]\.\n\n\[\^k1-1\]: a\n\nTo\[\^k2-1\]\.\n\n\[\^k2-1\]: b\n\n\*Kapitlet mangler: C\.md\*\n\nSlut\.$/);
  assert.equal(expandChapters("Ingen kapitler", texts), "Ingen kapitler");
});

test("felterne kan oprettes og opdateres med kapitellinjer i teksten", () => {
  const s = EditorState.create({ doc: "# A\n\n/Indledning.md\n/dele/Metode.md\n\nSlut", extensions: chapters });
  const s2 = s.update({ effects: setChapterTexts.of(new Map([["Indledning.md", "# Ind\n\ntekst"], ["dele/Metode.md", null]])) }).state;
  assert.equal(s2.field(chapterTexts).size, 2);
});

test("kapitler lige under hinanden får en tom linje imellem, så en fodnote ikke tager det næste med", () => {
  const texts = new Map<string, string | null>([["A.md", "Et[^1].\n\n[^1]: a"], ["B.md", "To."]]);
  assert.equal(expandChapters("# Bog\n\n/A.md\n/B.md\n/C.md\nSlut.", texts), "# Bog\n\nEt[^k1-1].\n\n[^k1-1]: a\n\nTo.\n\n*Kapitlet mangler: C.md*\n\nSlut.");
  assert.equal(expandChapters("/A.md", texts), "Et[^k1-1].\n\n[^k1-1]: a");
});

/** De kort, der står i stedet for en kapitellinje: teksten, de dækker. */
function covered(s: EditorState): string[] {
  const out: string[] = [];
  for (const d of s.facet(EditorView.decorations)) {
    if (typeof d === "function") continue;
    d.between(0, s.doc.length, (from, to) => {
      if (to > from) out.push(s.doc.sliceString(from, to));
    });
  }
  return out;
}

test("kortene flytter med teksten, og et nyt kapitel kommer med (gennemgang 22/10)", () => {
  let s = EditorState.create({ doc: "# A\n\nTekst her.\n\n/Ind.md\n/To.md\n", extensions: chapters });
  const texts = new Map<string, string | null>([["Ind.md", "# Ind\n\nen to tre"], ["To.md", "fire"]]);
  s = s.update({ effects: setChapterTexts.of(texts) }).state;
  assert.deepEqual(covered(s), ["/Ind.md", "/To.md"]);
  s = s.update({ changes: { from: 5, insert: "Mere " } }).state;
  assert.deepEqual(covered(s), ["/Ind.md", "/To.md"]);
  s = s.update({ changes: { from: s.doc.length, insert: "/Tre.md" } }).state;
  assert.deepEqual(findChapters(s.doc.toString()).map((c) => c.name), ["Ind.md", "To.md", "Tre.md"]);
  assert.deepEqual(covered(s), ["/Ind.md", "/To.md", "/Tre.md"]);
  // De samme tekster igen (ved fokus): feltet er uændret.
  const same = s.update({ effects: setChapterTexts.of(new Map(texts)) }).state;
  assert.equal(same.field(chapterTexts), s.field(chapterTexts));
});
