// Søgning og uddrag i notelisten (noteList.ts). Rene funktioner, testet med node --test.

/** Søgeordene skal alle stå i noten, uanset store og små bogstaver. */
export function matches(note: { title: string; text: string }, query: string): boolean {
  const hay = `${note.title}\n${note.text}`.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Uddraget under titlen: teksten efter første linje, eller stedet, hvor søgeordet står. */
export function snippet(note: { title: string; text: string }, query: string): string {
  const flat = note.text.replace(/\s+/g, " ").trim();
  const word = query.trim().split(/\s+/)[0]?.toLocaleLowerCase();
  const hit = word ? flat.toLocaleLowerCase().indexOf(word) : -1;
  if (hit > 40) return `… ${flat.slice(hit - 30, hit + 110)}`;
  // Titlen står allerede over uddraget, også når den er en overskrift (»# Indkøb«).
  const lead = flat.replace(/^#+\s*/, "");
  const body = note.title && lead.startsWith(note.title) ? lead.slice(note.title.length).trim() : flat;
  return body.slice(0, 140);
}
