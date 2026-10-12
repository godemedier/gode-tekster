// Strukturen er kommentarer i manuskriptet. Delgrænser følger teksten, også i andre editorer.
import { commentSpans, codeSpans } from "./textSyntax.ts";

export type StructurePart = { id: string; title: string; role: string; note: string; from: number; to: number; contentFrom: number; contentTo: number; markerTo: number };
export type StructurePlan = { model: string; from: number; to: number };
export type StructureChange = { from: number; to?: number; insert: string };
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
// U+2028/U+2029 escapes også: JSON.stringify lader dem stå, og så kunne mønstrene ikke læse delen.
const encode = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function structurePlan(doc: string): StructurePlan | null {
  for (const span of commentSpans(doc)) {
    const match = /^<!-- gt:struktur (.+) -->$/s.exec(doc.slice(span.from, span.to));
    if (!match) continue;
    try {
      const data = JSON.parse(match[1]);
      if (data.version === 1 && typeof data.model === "string" && data.model.length <= 80) return { model: data.model, ...span };
    } catch { /* En fremmed eller beskadiget kommentar bevares. */ }
  }
  return null;
}

export function structureParts(doc: string): StructurePart[] {
  if (!doc.includes("<!-- gt:del ")) return [];
  const out: StructurePart[] = [];
  const ids = new Set<string>();
  let pending: Omit<StructurePart, "to" | "contentTo"> | null = null;
  for (const span of commentSpans(doc)) {
    const raw = doc.slice(span.from, span.to);
    const start = /^<!-- gt:del (.+) -->$/s.exec(raw);
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

export function structureContext(doc: string) {
  return { parts: structureParts(doc), spans: [...commentSpans(doc), ...codeSpans(doc).filter(s => doc.slice(s.from, s.to).includes("\n"))] };
}
export function addStructurePart(doc: string, from: number, to: number, title: string, role = "", note = "", context = structureContext(doc)): StructureChange[] | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > doc.length ||
      (from > 0 && from < doc.length && doc[from - 1] !== "\n") || (to < doc.length && to > 0 && doc[to - 1] !== "\n")) return null;
  if (context.parts.some(p => from < p.to && to > p.from || from === to && from > p.from && from < p.to)) return null;
  const spans = context.spans;
  if (spans.some(s => from > s.from && from < s.to || to > s.from && to < s.to || /^<!-- gt:/.test(doc.slice(s.from, s.to)) && from < s.to && to > s.from)) return null;
  const id = `s-${crypto.randomUUID()}`;
  const opening = `${from === doc.length && from > 0 && doc[from - 1] !== "\n" ? "\n" : ""}${marker({ id, title, role, note })}\n`;
  const closing = `${to > from && doc[to - 1] !== "\n" ? "\n" : ""}<!-- gt:slut ${id} -->\n`;
  return from === to ? [{ from, insert: opening + closing }] : [{ from, insert: opening }, { from: to, insert: closing }];
}

export function editStructurePart(doc: string, id: string, changes: Partial<Pick<StructurePart, "title" | "role" | "note">>, parts = structureParts(doc)): StructureChange | null {
  const part = parts.find(p => p.id === id);
  return part ? { from: part.from, to: part.markerTo, insert: marker({ ...part, ...changes }) } : null;
}

export function removeStructurePart(doc: string, id: string): StructureChange[] {
  const part = structureParts(doc).find(p => p.id === id);
  return part ? [{ from: part.from, to: part.contentFrom, insert: "" }, { from: part.contentTo, to: part.to, insert: "" }] : [];
}

export function moveStructurePart(doc: string, id: string, direction: -1 | 1): StructureChange | null {
  const parts = structureParts(doc), index = parts.findIndex(p => p.id === id);
  return reorderStructurePart(doc, id, index + direction, parts)?.change ?? null;
}

/** Et stykke af den gamle tekst og hvor langt det er flyttet (til forfatterskabet). */
export type MovedRegion = { from: number; to: number; offset: number };

/**
 * Flyt en del til plads `target` i én ændring, så et træk over flere pladser er ét fortryd-trin.
 * Mellemrummene mellem delene bliver stående. En del uden linjeskift sidst i filen får et, når den
 * flyttes op, så to markører aldrig havner på samme linje.
 */
export function reorderStructurePart(doc: string, id: string, target: number, parts = structureParts(doc)): { change: StructureChange; regions: MovedRegion[] } | null {
  const from = parts.findIndex(p => p.id === id);
  if (from < 0 || target < 0 || target >= parts.length || target === from) return null;
  const slots = parts.slice(Math.min(from, target), Math.max(from, target) + 1);
  const gaps = slots.slice(0, -1).map((p, i) => ({ from: p.to, to: slots[i + 1].from }));
  // Ugrupperet tekst må ikke blive flyttet med uden brugerens viden.
  if (gaps.some(g => doc.slice(g.from, g.to).trim())) return null;
  const order = slots.map((_, i) => i);
  const [moved] = order.splice(from - Math.min(from, target), 1);
  order.splice(target - Math.min(from, target), 0, moved);
  const start = slots[0].from, end = slots[slots.length - 1].to;
  const regions: MovedRegion[] = [{ from: 0, to: start, offset: 0 }];
  let text = "";
  order.forEach((k, j) => {
    const p = slots[k];
    regions.push({ from: p.from, to: p.to, offset: start + text.length - p.from });
    text += doc.slice(p.from, p.to);
    if (j < order.length - 1 && !text.endsWith("\n")) text += "\n";
    const g = gaps[j];
    if (g) {
      regions.push({ from: g.from, to: g.to, offset: start + text.length - g.from });
      text += doc.slice(g.from, g.to);
    }
  });
  regions.push({ from: end, to: doc.length, offset: text.length - (end - start) });
  return { change: { from: start, to: end, insert: text }, regions };
}
