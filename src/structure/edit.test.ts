import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { history, undo, redo } from "@codemirror/commands";
import { authorshipField, authorshipHistory, setAuthorship, OTHERS } from "../editor/authorship.ts";
import { markdown } from "@codemirror/lang-markdown";
import { hiddenBlocks } from "../editor/hidden.ts";
import { addStructurePart, structureParts } from "../editor/structure.ts";
import { selectedBlocks, movePart, applyStructure } from "./edit.ts";
test("markering midt i liste grupperer hele listen", () => {
  const doc = "Indledning.\n\n- Første\n\n  Fortsættelse\n- Andet\n\nEfter.\n";
  const state = EditorState.create({doc,selection:{anchor:doc.indexOf("Forts")},extensions:[markdown()]});
  const span=selectedBlocks(state)!;
  assert.equal(doc.slice(span.from,span.to),"- Første\n\n  Fortsættelse\n- Andet\n");
});
test("slet alt bevarer plan og hele strukturmærker, almindelig flytning kan ikke duplikere dem", () => {
  const doc="Første tekst.\n";
  let state=EditorState.create({doc,extensions:[hiddenBlocks]});
  state=state.update({changes:addStructurePart(doc,0,doc.length,"Start")!,userEvent:"input.structure"}).state;
  const original=state.doc.toString(), id=structureParts(original)[0].id;
  const deleted=state.update({changes:{from:0,to:state.doc.length},userEvent:"delete.selection"}).state.doc.toString();
  assert.equal(structureParts(deleted)[0]?.id,id);
  const moved=state.update({changes:{from:0,to:state.doc.length,insert:original+original},userEvent:"move.section"}).state.doc.toString();
  assert.equal(moved,original);
});
test("tom planlagt del kan oprettes efter EOF uden linjeskift", () => {
  const doc="Sidste ord.";const changes=addStructurePart(doc,doc.length,doc.length,"Senere")!;
  const state=EditorState.create({doc}).update({changes}).state;
  assert.equal(structureParts(state.doc.toString()).length,1);
  assert.match(state.doc.toString(),/^Sidste ord\.\n<!-- gt:del/);
});

test("flytning og fortryd bevarer kildetekst og indsat-markeringer",()=>{
  let state=EditorState.create({doc:"Første.\n\nAnden.\n"});
  state=state.update({changes:addStructurePart(state.doc.toString(),0,8,"A")!}).state;
  state=state.update({changes:addStructurePart(state.doc.toString(),state.doc.length-7,state.doc.length,"B")!}).state;
  state=EditorState.create({doc:state.doc,extensions:[history(),authorshipField,authorshipHistory]});
  const parts=structureParts(state.doc.toString()),span={start:parts[0].contentFrom,end:parts[0].contentFrom+6};
  state=state.update({effects:setAuthorship.of({me:{kind:"human",name:"Test",identifier:null},authors:[{author:OTHERS,spans:[span]}],pasted:[span],external:[span]})}).state;
  const original=state.field(authorshipField);
  const view={get state(){return state;},dispatch(spec:TransactionSpec){state=state.update(spec).state;}} as unknown as EditorView;
  assert.equal(movePart(view,parts[0].id,1),true);
  const moved=state.field(authorshipField);const movedSpan=moved.authors[0].spans[0];
  assert.equal(state.doc.sliceString(movedSpan.start,movedSpan.end),"Første");
  assert.deepEqual(moved.pasted,[movedSpan]);
  undo({state,dispatch:tr=>{state=tr.state;}});assert.deepEqual(state.field(authorshipField),original);
  redo({state,dispatch:tr=>{state=tr.state;}});assert.deepEqual(state.field(authorshipField),moved);
});

test("struktur kan ikke aendre en skrivebeskyttet versionsvisning",()=>{
  let state=EditorState.create({doc:"Historik",extensions:[EditorState.readOnly.of(true)]});
  const view={get state(){return state;},dispatch(spec:TransactionSpec){state=state.update(spec).state;}} as unknown as EditorView;
  applyStructure(view,{from:0,insert:"Ny tekst"});assert.equal(state.doc.toString(),"Historik");
});
