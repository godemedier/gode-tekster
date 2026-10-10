import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { addStructurePart, moveStructurePart, structureParts, type StructureChange } from "../editor/structure.ts";
import { authorshipField, restoreMovedAuthorship } from "../editor/authorship.ts";

/** Hele blokke fra Markdown-parseren: også lister og tabeller med tomme linjer. */
export function selectedBlocks(state: EditorState): { from: number; to: number } | null {
  const selection = state.selection.main;
  const blocks: { from: number; to: number }[] = [];
  for (let n = syntaxTree(state).topNode.firstChild; n; n = n.nextSibling) {
    if (n.to > selection.from && n.from < selection.to || selection.empty && n.from <= selection.from && n.to >= selection.to) blocks.push(n);
  }
  if (!blocks.length) return null;
  const from = state.doc.lineAt(blocks[0].from).from;
  const end = state.doc.lineAt(blocks.at(-1)!.to).to;
  return { from, to: Math.min(state.doc.length, end + 1) };
}

export function groupSelection(view: EditorView): boolean {
  if(view.state.readOnly)return false;
  const range = selectedBlocks(view.state);
  if (!range) return false;
  const doc = view.state.doc.toString();
  const title = doc.slice(range.from, range.to).trim().replace(/^#+\s*/, "").split("\n")[0].slice(0, 80);
  const changes = addStructurePart(doc, range.from, range.to, title);
  if (!changes) return false;
  view.dispatch({ changes, userEvent: "input.structure" });
  return true;
}

export function applyStructure(view: EditorView, changes: StructureChange | StructureChange[]): void {
  if(view.state.readOnly)return;
  view.dispatch({ changes, userEvent: "input.structure" });
}

/** Flytning bevarer både kendte forfattere og markeringen af indsat/ekstern tekst. */
export function movePart(view: EditorView, id: string, direction: -1 | 1): boolean {
  if(view.state.readOnly)return false;
  const doc = view.state.doc.toString(), parts = structureParts(doc);
  const index = parts.findIndex(p => p.id === id), other = parts[index + direction];
  const change = moveStructurePart(doc, id, direction);
  if (!change || !other) return false;
  const [a, b] = direction < 0 ? [other, parts[index]] : [parts[index], other];
  const regions = [
    { from: 0, to: a.from, offset: 0 },
    { from: a.from, to: a.to, offset: b.to - a.to },
    { from: a.to, to: b.from, offset: (b.to - b.from) - (a.to - a.from) },
    { from: b.from, to: b.to, offset: a.from - b.from },
    { from: b.to, to: doc.length, offset: 0 },
  ];
  const value = view.state.field(authorshipField, false);
  const map = (spans: { start: number; end: number }[]) => regions.flatMap(r => spans.map(s => ({ start: Math.max(s.start, r.from) + r.offset, end: Math.min(s.end, r.to) + r.offset })).filter(s => s.end > s.start)).sort((a,b) => a.start-b.start);
  view.dispatch({ changes: change, userEvent: "input.structure", effects: value ? restoreMovedAuthorship.of({ ...value, authors: value.authors.map(a => ({ ...a, spans: map(a.spans) })), pasted: map(value.pasted), external: map(value.external) }) : [] });
  return true;
}
