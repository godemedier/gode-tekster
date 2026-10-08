// Resultater fra tjek og AI-kommandoer (plan 2026-10-05, research 3.5). De vises i fanen Input i
// højre spalte og skriver intet i teksten, før brugeren klikker. Fund: det ordrette uddrag og en
// kommentar; klik springer til stedet, »Dæmp« sætter {-- --} om det, »Note« lægger kommentaren som
// note til mig selv efter stedet. Spørgsmål kan lægges som note ved markøren. Resultaterne gemmes
// ikke i filen og forsvinder, når en anden tekst åbnes. Alt vises med textContent, aldrig som HTML.

import type { EditorView } from "@codemirror/view";

import { dimmedInBody } from "../editor/dimming.ts";
import { tr } from "../i18n.ts";
import type { CommandResult, Finding } from "../commands/types.ts";

type Shown = { id: number; view: EditorView; result: CommandResult; offset: number; /** Fund, hvis sted ikke står i teksten længere. */ gone: Set<number> };

/** Så mange rækker tegnes der højst. Et tjek kan give flere, og spalten skal kunne følge med. */
const MAX_ROWS = 100;
const MAX_RESULTS = 4;

let next = 0;
let shown: Shown[] = [];
const listeners: ((isNew: boolean) => void)[] = [];

const changed = (isNew: boolean) => listeners.forEach((l) => l(isNew));

/** Vis et resultat i fanen Input. `offset` er pladsen i dokumentet for den tekst, fundene peger ind i. */
export function showCommandResult(view: EditorView, result: CommandResult, offset = 0): void {
  // En ny kørsel af samme kommando afløser den gamle.
  shown = [{ id: ++next, view, result, offset, gone: new Set<number>() }, ...shown.filter((s) => s.result.title !== result.title)].slice(0, MAX_RESULTS);
  changed(true);
}

/** En anden tekst er åbnet: positionerne passer ikke længere. */
export function clearCommandResults(): void {
  if (!shown.length) return;
  shown = [];
  changed(false);
}

export function hasCommandResults(): boolean {
  return shown.length > 0;
}

/** Fanen Input lytter: `isNew` betyder, at fanen skal frem. */
export function onCommandResults(cb: (isNew: boolean) => void): void {
  listeners.push(cb);
}

/**
 * Find uddraget i teksten, som den ser ud nu. Først der, hvor det stod. Er der skrevet siden, tages
 * den forekomst, der ligger nærmest. null: uddraget står der ikke længere.
 */
export function locateExcerpt(doc: string, excerpt: string, expected: number): { from: number; to: number } | null {
  if (!excerpt) return expected <= doc.length ? { from: expected, to: expected } : null;
  if (doc.startsWith(excerpt, expected)) return { from: expected, to: expected + excerpt.length };
  let best = -1;
  for (let at = doc.indexOf(excerpt); at !== -1; at = doc.indexOf(excerpt, at + 1)) {
    if (best === -1 || Math.abs(at - expected) < Math.abs(best - expected)) best = at;
    else break; // forekomsterne kommer i rækkefølge, så herfra bliver afstanden kun større
  }
  return best === -1 ? null : { from: best, to: best + excerpt.length };
}

/** Læg hvert uddrag på sin plads i den tekst, der blev sendt. Samme uddrag to gange får to forskellige steder. */
export function placeExcerpts(text: string, items: { excerpt: string; comment: string }[]): Finding[] {
  const from = new Map<string, number>();
  const out: Finding[] = [];
  for (const it of items) {
    if (!it.excerpt) continue;
    let at = text.indexOf(it.excerpt, from.get(it.excerpt) ?? 0);
    if (at === -1) at = text.indexOf(it.excerpt);
    if (at === -1) continue;
    from.set(it.excerpt, at + it.excerpt.length);
    out.push({ from: at, to: at + it.excerpt.length, excerpt: it.excerpt, comment: it.comment });
  }
  return out;
}

/** En note til mig selv. `-->` inde i teksten ville lukke noten for tidligt. */
export function noteMarkup(text: string): string {
  return `<!-- ${text.replace(/\s+/g, " ").trim().replace(/-->/g, "-- >")} -->`;
}

// --- tegningen (kaldes af ClaudePanel.render) -------------------------------------------------------

export function commandResultBlocks(): HTMLElement[] {
  return shown.map((s) => block(s));
}

function block(s: Shown): HTMLElement {
  const box = document.createElement("section");
  box.className = "cr-result";
  // Esc fører tilbage til teksten.
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    s.view.focus();
  });
  const head = document.createElement("div");
  head.className = "cl-saved-head";
  const title = document.createElement("strong");
  title.textContent = heading(s.result);
  head.append(
    title,
    tools([
      [
        tr("Luk", "Close"),
        () => {
          shown = shown.filter((x) => x.id !== s.id);
          changed(false);
        },
      ],
    ]),
  );
  box.append(head);
  if (s.result.note) box.append(para(s.result.note, "cl-note"));
  if (s.result.kind === "findings") {
    const all = s.result.findings;
    if (!all.length && !s.result.note) box.append(para(tr("Ingen fund.", "No findings."), "cl-note"));
    all.slice(0, MAX_ROWS).forEach((f, i) => box.append(findingCard(s, f, i)));
    if (all.length > MAX_ROWS) box.append(para(tr(`Her står de første ${MAX_ROWS}. Ret dem, og kør kommandoen igen.`, `These are the first ${MAX_ROWS}. Fix them and run the command again.`), "cl-note"));
  } else {
    const all = s.result.questions;
    if (!all.length && !s.result.note) box.append(para(tr("Ingen spørgsmål.", "No questions."), "cl-note"));
    for (const q of all.slice(0, MAX_ROWS)) box.append(questionCard(s, q));
  }
  return box;
}

function heading(r: CommandResult): string {
  const n = r.kind === "findings" ? r.findings.length : r.questions.length;
  if (!n) return r.title;
  const what = r.kind === "findings" ? tr("fund", n === 1 ? "finding" : "findings") : tr("spørgsmål", n === 1 ? "question" : "questions");
  return `${r.title}: ${n} ${what}`;
}

function findingCard(s: Shown, f: Finding, index: number): HTMLElement {
  const c = card();
  const quote = document.createElement("button");
  quote.type = "button";
  quote.className = "cl-quote";
  quote.textContent = short(f.excerpt) || tr("(stedet i teksten)", "(the place in the text)");
  quote.title = tr("Gå til stedet", "Go to the place");
  const at = () => {
    const place = locateExcerpt(s.view.state.doc.toString(), f.excerpt, s.offset + f.from);
    if (!place && !s.gone.has(index)) {
      s.gone.add(index);
      changed(false);
    }
    return place;
  };
  quote.addEventListener("click", () => {
    const place = at();
    if (!place) return;
    s.view.dispatch({ selection: { anchor: place.from, head: place.to }, scrollIntoView: true });
    s.view.focus();
  });
  c.append(quote);
  if (f.comment) c.append(para(f.comment, "cr-comment"));
  if (s.gone.has(index)) {
    c.append(para(tr("Stedet står ikke længere sådan i teksten.", "The text no longer reads like this here."), "cl-unverified"));
    return c;
  }
  const actions: [string, () => void][] = [
    [
      tr("Dæmp", "Dim"),
      () => {
        const place = at();
        if (!place || place.to === place.from) return;
        const doc = s.view.state.doc.toString();
        // Står stedet allerede i dæmpet tekst, er der intet at gøre.
        if (dimmedInBody(doc).some((d) => place.from < d.to && place.to > d.from)) return;
        s.view.dispatch({
          changes: [
            { from: place.from, insert: "{--" },
            { from: place.to, insert: "--}" },
          ],
          userEvent: "input.dim",
          scrollIntoView: true,
        });
      },
    ],
  ];
  if (f.comment) {
    actions.push([
      tr("Kommentar", "Comment"),
      () => {
        const place = at();
        if (!place) return;
        s.view.dispatch({ changes: { from: place.to, insert: ` ${noteMarkup(f.comment)}` }, userEvent: "input.note", scrollIntoView: true });
      },
    ]);
  }
  c.append(tools(actions));
  return c;
}

function questionCard(s: Shown, question: string): HTMLElement {
  const c = card();
  c.append(
    para(question, "cr-comment"),
    tools([
      [
        tr("Som kommentar", "As comment"),
        () => {
          const pos = s.view.state.selection.main.head;
          s.view.dispatch({ changes: { from: pos, insert: noteMarkup(question) }, userEvent: "input.note", scrollIntoView: true });
        },
      ],
    ]),
  );
  return c;
}

function card(): HTMLElement {
  const c = document.createElement("div");
  c.className = "rp-card cl-card";
  return c;
}

function para(text: string, cls: string): HTMLElement {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}

function tools(items: [string, () => void][]): HTMLElement {
  const t = document.createElement("div");
  t.className = "cl-tools";
  for (const [label, run] of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", run);
    t.append(b);
  }
  return t;
}

function short(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 197)}…` : t;
}
