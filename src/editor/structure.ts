// Strukturen er kommentarer i manuskriptet. Delgrænser følger teksten, også i andre editorer.
import { commentSpans, codeSpans } from "./textSyntax.ts";

export type StructurePart = { id: string; title: string; role: string; note: string; from: number; to: number; contentFrom: number; contentTo: number; markerTo: number };
export type StructurePlan = { model: string; from: number; to: number };
export type StructureChange = { from: number; to?: number; insert: string };
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const encode = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

export function structurePlan(doc: string): StructurePlan | null {
  for (const span of commentSpans(doc)) {
    const match = /^<!-- gt:struktur (.+) -->$/.exec(doc.slice(span.from, span.to));
    if (!match) continue;
    try {
      const data = JSON.parse(match[1]);
      if (data.version === 1 && typeof data.model === "string" && data.model.length <= 80) return { model: data.model, ...span };
    } catch { /* En fremmed eller beskadiget kommentar bevares. */ }
  }
  return null;
}

export function structureParts(doc: string): StructurePart[] {
  const out: StructurePart[] = [];
  const ids = new Set<string>();
  let pending: Omit<StructurePart, "to" | "contentTo"> | null = null;
  for (const span of commentSpans(doc)) {
    const raw = doc.slice(span.from, span.to);
    const start = /^<!-- gt:del (.+) -->$/.exec(raw);
    if (start) {
      // Indlejrede/defekte dele fortolkes aldrig som flytbare områder.
      if (pending) { pending = null; continue; }
      try {
        const data = JSON.parse(start[1]);
        if (data.version !== 1 || !ID.test(data.id) || ids.has(data.id) ||
            [data.title, data.role, data.note].some(v => typeof v !== "string") ||
            data.title.length > 240 || data.role.length > 80 || data.note.length > 10000) continue;
        pending = { id: data.id, title: data.title, role: data.role, note: data.note,
          from: span.from, markerTo: span.to, contentFrom: span.to + (doc[span.to] === "\n" ? 1 : 0) };
      } catch { pending = null; }
    } else {
      const end = /^<!-- gt:slut ([a-zA-Z0-9_-]+) -->$/.exec(raw);
      if (end && pending?.id === end[1]) {
        out.push({ ...pending, contentTo: span.from, to: span.to + (doc[span.to] === "\n" ? 1 : 0) });
        ids.add(pending.id);
        pending = null;
      }
    }
  }
  return out;
}

export function structureSpans(doc: string): { from: number; to: number }[] {
  const plan = structurePlan(doc);
  return [...(plan ? [{ from: plan.from, to: plan.to }] : []), ...structureParts(doc).flatMap(p => [
    { from: p.from, to: p.markerTo }, { from: p.contentTo, to: p.to - (doc[p.to - 1] === "\n" ? 1 : 0) },
  ])].sort((a, b) => a.from - b.from);
}

function marker(part: Pick<StructurePart, "id" | "title" | "role" | "note">): string {
  return `<!-- gt:del ${encode({ version: 1, id: part.id, title: part.title.slice(0, 240), role: part.role.slice(0, 80), note: part.note.slice(0, 10000) })} -->`;
}

export function setStructureModel(doc: string, model: string): StructureChange {
  const plan = structurePlan(doc);
  const insert = `<!-- gt:struktur ${encode({ version: 1, model })} -->`;
  return plan ? { from: plan.from, to: plan.to, insert } : { from: doc.length, insert: `${doc.endsWith("\n") || !doc ? "" : "\n"}\n${insert}\n` };
}

export function addStructurePart(doc: string, from: number, to: number, title: string, role = "", note = ""): StructureChange[] | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > doc.length ||
      (from > 0 && doc[from - 1] !== "\n") || (to < doc.length && to > 0 && doc[to - 1] !== "\n")) return null;
  if (structureParts(doc).some(p => from < p.to && to > p.from || from === to && from > p.from && from < p.to)) return null;
  const spans = [...commentSpans(doc), ...codeSpans(doc).filter(s => doc.slice(s.from, s.to).includes("\n"))];
  if (spans.some(s => from > s.from && from < s.to || to > s.from && to < s.to || /^<!-- gt:/.test(doc.slice(s.from, s.to)) && from < s.to && to > s.from)) return null;
  const id = `s-${crypto.randomUUID()}`;
  const opening = marker({ id, title, role, note }) + "\n";
  const closing = `${to > from && doc[to - 1] !== "\n" ? "\n" : ""}<!-- gt:slut ${id} -->\n`;
  return from === to ? [{ from, insert: opening + closing }] : [{ from, insert: opening }, { from: to, insert: closing }];
}

export function editStructurePart(doc: string, id: string, changes: Partial<Pick<StructurePart, "title" | "role" | "note">>): StructureChange | null {
  const part = structureParts(doc).find(p => p.id === id);
  return part ? { from: part.from, to: part.markerTo, insert: marker({ ...part, ...changes }) } : null;
}

export function removeStructurePart(doc: string, id: string): StructureChange[] {
  const part = structureParts(doc).find(p => p.id === id);
  return part ? [{ from: part.from, to: part.contentFrom, insert: "" }, { from: part.contentTo, to: part.to, insert: "" }] : [];
}

export function moveStructurePart(doc: string, id: string, direction: -1 | 1): StructureChange | null {
  const parts = structureParts(doc), index = parts.findIndex(p => p.id === id), next = index + direction;
  if (index < 0 || next < 0 || next >= parts.length) return null;
  const [a, b] = direction === -1 ? [parts[next], parts[index]] : [parts[index], parts[next]];
  // Ugrupperet tekst må ikke blive flyttet med uden brugerens viden.
  if (doc.slice(a.to, b.from).trim()) return null;
  return { from: a.from, to: b.to, insert: doc.slice(b.from, b.to) + doc.slice(a.to, b.from) + doc.slice(a.from, a.to) };
}
