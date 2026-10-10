// Små, lineære skannere til tekst, som ikke må tolkes som programmets egne markeringer.
export type TextSpan = { from: number; to: number };

/** Kodeblokke og inlinekode, inklusive en uafsluttet kodeblok. */
export function codeSpans(doc: string): TextSpan[] {
  const fences: TextSpan[] = [];
  let opened: { from: number; marker: string; length: number } | null = null;
  let pos = 0;
  for (const line of doc.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      if (!opened && (m[1][0] !== "`" || !m[2].includes("`"))) opened = { from: pos, marker: m[1][0], length: m[1].length };
      else if (opened && m[1][0] === opened.marker && m[1].length >= opened.length && !m[2].trim()) {
        fences.push({ from: opened.from, to: Math.min(doc.length, pos + line.length + 1) });
        opened = null;
      }
    }
    pos += line.length + 1;
  }
  if (opened) fences.push({ from: opened.from, to: doc.length });
  const out: TextSpan[] = [];
  let start = 0;
  const inline = (from: number, to: number) => {
    const runs = [...doc.slice(from, to).matchAll(/`+/g)];
    const next = new Map<number, number>();
    const pairs: (number | undefined)[] = [];
    for (let i = runs.length - 1; i >= 0; i--) {
      pairs[i] = next.get(runs[i][0].length);
      next.set(runs[i][0].length, i);
    }
    for (let i = 0; i < runs.length; i++) {
      const end = pairs[i];
      if (end === undefined) continue;
      out.push({ from: from + runs[i].index, to: from + runs[end].index + runs[end][0].length });
      i = end;
    }
  };
  for (const fence of fences) {
    inline(start, fence.from);
    out.push(fence);
    start = fence.to;
  }
  inline(start, doc.length);
  return out;
}

export function outsideCode(doc: string, transform: (text: string) => string): string {
  const out: string[] = [];
  let from = 0;
  for (const code of codeSpans(doc)) {
    out.push(transform(doc.slice(from, code.from)), doc.slice(code.from, code.to));
    from = code.to;
  }
  out.push(transform(doc.slice(from)));
  return out.join("");
}

/** Kun afsluttede kommentarer. En ny åbning starter forfra, så en halv kommentar ikke sluger tekst. */
export function commentSpans(doc: string): TextSpan[] {
  const out: TextSpan[] = [];
  const codes = codeSpans(doc);
  let code = 0;
  let from = -1;
  for (const m of doc.matchAll(/<!--|-->/g)) {
    while (code < codes.length && codes[code].to <= m.index) code++;
    if (from === -1 && code < codes.length && codes[code].from <= m.index) {
      continue;
    }
    if (m[0] === "<!--") from = m.index;
    else if (from !== -1) {
      out.push({ from, to: m.index + 3 });
      from = -1;
    }
  }
  return out;
}

/** Bevarer offsets til fodnoter, tags og andre markeringer. */
export function maskSpans(doc: string, spans: TextSpan[]): string {
  const out: string[] = [];
  let from = 0;
  for (const span of [...spans].sort((a, b) => a.from - b.from || b.to - a.to)) {
    if (span.to <= from) continue;
    const start = Math.max(from, span.from);
    out.push(doc.slice(from, start), doc.slice(start, span.to).replace(/[^\n]/g, " "));
    from = span.to;
  }
  out.push(doc.slice(from));
  return out.join("");
}
