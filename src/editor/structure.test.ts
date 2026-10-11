import { test } from "node:test";
import assert from "node:assert/strict";
import { addStructurePart, editStructurePart, moveStructurePart, removeStructurePart, setStructureModel, structureParts, structurePlan } from "./structure.ts";
import { withoutParked } from "./parked.ts";
function apply(doc: string, changes: { from: number; to?: number; insert: string }[]) {
  for (const c of [...changes].sort((a,b) => b.from - a.from)) doc = doc.slice(0,c.from) + c.insert + doc.slice(c.to ?? c.from);
  return doc;
}
test("struktur følger tekst i md, bevarer indhold og escaper kommentarer i arbejdsnoter", () => {
  const original = "Første afsnit.\n\nAndet afsnit.\n";
  let doc = apply(original, addStructurePart(original, 0, 16, "Åbning")!);
  let p = structureParts(doc)[0];
  doc = apply(doc, [editStructurePart(doc,p.id,{title:'<!-- x -->',note:'note --!> &amp;#45; <!--',role:'scene'})!]);
  doc = apply(doc,[setStructureModel(doc,'feature')]);
  assert.equal(structurePlan(doc)?.model,'feature');
  p = structureParts(doc)[0];
  assert.equal(p.note,'note --!> &amp;#45; <!--');
  assert.equal(p.title,'<!-- x -->');
  assert.equal(withoutParked(doc).trim(),original.trim());
  const changed = doc.slice(0,p.contentFrom) + 'Nyt indhold.\n' + doc.slice(p.contentTo);
  assert.equal(structureParts(changed)[0].id,p.id);
  assert.equal(changed.slice(structureParts(changed)[0].contentFrom,structureParts(changed)[0].contentTo),'Nyt indhold.\n');
  assert.equal(withoutParked(apply(doc,removeStructurePart(doc,p.id))).trim(),original.trim());
});
test("flytning følger hele tekstblokken og kan vendes om uden tab", () => {
  let doc='A\n\nB\n';
  doc=apply(doc,addStructurePart(doc,3,5,'B')!);
  doc=apply(doc,addStructurePart(doc,0,3,'A')!);
  const original=doc, a=structureParts(doc)[0];
  doc=apply(doc,[moveStructurePart(doc,a.id,1)!]);
  assert.equal(structureParts(doc)[0].title,'B');
  assert.equal(withoutParked(doc).replace(/\s/g,''),'BA');
  assert.equal(apply(doc,[moveStructurePart(doc,a.id,-1)!]),original);
});
test("afviser overlappende blokke, delte kodeblokke, markeringsrester og dublet-id", () => {
  let doc='A\n\nB\n';
  doc=apply(doc,addStructurePart(doc,0,3,'A')!);
  const p=structureParts(doc)[0];
  assert.equal(addStructurePart(doc,p.contentFrom,p.contentTo,'Indeni'),null);
  assert.equal(addStructurePart('```\na\nb\n```\n',4,6,'Halv kode'),null);
  assert.equal(addStructurePart('Ord midt i linje',1,4,'Halvt ord'),null);
  assert.equal(structureParts(doc+doc).length,1);
  assert.equal(structureParts('```\n'+doc+'\n```').length,0);
  assert.equal(structureParts(doc.replace('gt:slut','gt:ukendt')).length,0);
});
test("tomme planlagte dele og modelskift bevarer kort og eksisterende prosa", () => {
  let doc=apply('',addStructurePart('',0,0,'Plan','opening')!);
  const id=structureParts(doc)[0].id;
  doc=apply(doc,[setStructureModel(doc,'news')]);
  doc=apply(doc,[setStructureModel(doc,'three-acts')]);
  assert.equal(structureParts(doc)[0].id,id);
  assert.equal(structureParts(doc)[0].role,'opening');
  assert.equal(withoutParked(doc).trim(),'');
});

test("tekst ved EOF uden linjeskift lukkes rent med egen linje", () => {
  const doc = "Første afsnit.\nSidste linje uden n";
  const changes = addStructurePart(doc, 15, doc.length, "Afslutning")!;
  const result = apply(doc, changes);
  const parts = structureParts(result);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].title, "Afslutning");
  assert.equal(result.slice(parts[0].contentFrom, parts[0].contentTo).trim(), "Sidste linje uden n");
  assert.equal(withoutParked(result).trim(), doc.trim());
});

test("flere sammenhængende tomme dele bevarer adskilte id'er og kan flyttes", () => {
  let doc = apply("", addStructurePart("", 0, 0, "Første")!);
  doc = apply(doc, addStructurePart(doc, doc.length, doc.length, "Anden")!);
  const parts = structureParts(doc);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].title, "Første");
  assert.equal(parts[1].title, "Anden");
  assert.notEqual(parts[0].id, parts[1].id);
  assert.equal(withoutParked(doc).trim(), "");

  // Flyt den anden del op før den første
  const moved = apply(doc, [moveStructurePart(doc, parts[1].id, -1)!]);
  const movedParts = structureParts(moved);
  assert.equal(movedParts[0].title, "Anden");
  assert.equal(movedParts[1].title, "Første");
  assert.equal(withoutParked(moved).trim(), "");

  // Fjern den ene tomme del
  const cleaned = apply(moved, removeStructurePart(moved, movedParts[0].id));
  assert.equal(structureParts(cleaned).length, 1);
  assert.equal(structureParts(cleaned)[0].title, "Første");
});

test("eksterne beskadigede kommentarer og uafsluttede dele krasjer ikke", () => {
  // Manglende slut-tag
  const unclosed = '<!-- gt:del {"version":1,"id":"s-1","title":"Uafsluttet","role":"","note":""} -->\nNoget tekst.\n';
  assert.equal(structureParts(unclosed).length, 0);

  // Mismatch i slut-id
  const mismatched = '<!-- gt:del {"version":1,"id":"s-1","title":"Mismatch","role":"","note":""} -->\nTekst.\n<!-- gt:slut s-2 -->\n';
  assert.equal(structureParts(mismatched).length, 0);

  // Ugyldig JSON
  const invalidJson = '<!-- gt:del {defekt:1} -->\nTekst.\n<!-- gt:slut s-1 -->\n';
  assert.equal(structureParts(invalidJson).length, 0);

  // For langt felt afvises af sikkerhedshensyn
  const tooLong = `<!-- gt:del {"version":1,"id":"s-1","title":"${"x".repeat(300)}","role":"","note":""} -->\nTekst.\n<!-- gt:slut s-1 -->\n`;
  assert.equal(structureParts(tooLong).length, 0);
});
