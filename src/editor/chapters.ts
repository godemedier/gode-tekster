// Lange tekster, fase 1 (21/10, ADR-0061): en hovedfil samler
// kapitler med iA Writers content blocks, én linje pr. kapitel: `/Indledning.md`. Stien er relativ
// til hovedfilens mappe. Rækkefølgen bor kun i hovedfilen, og i iA Writer virker filen, som den er.
//
// I skrivefladen står hver kapitellinje som et kort med kapitlets overskrift og ordtal, og under
// det sidste står det samlede tal. Klik åbner kapitlet. Print, PDF og Word samler kapitlerne
// (`expandChapters`). Teksterne hentes af Rust (`read_chapters`) og bor i et StateField.

import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";

import { count } from "./count.ts";
import { TextMemo } from "./touches.ts";
import { tr, currentLang } from "../i18n.ts";

/** En linje med kun `/sti/til/Kapitel.md`. `//` er ikke et kapitel, og et mellemrum efter / heller ikke. */
const CHAPTER_LINE = /^\/([^/\s][^\n]*?\.(?:md|markdown|txt))\s*$/i;
const FENCE = /^\s*(`{3,}|~{3,})/;

export type ChapterLine = { from: number; to: number; name: string };

/** Kapitellinjerne uden for kodeblokke, i rækkefølge. */
export function findChapters(doc: string): ChapterLine[] {
  const out: ChapterLine[] = [];
  if (!doc.includes("\n/") && !doc.startsWith("/")) return out;
  let pos = 0;
  let fence: string | null = null;
  for (const line of doc.split("\n")) {
    const f = FENCE.exec(line)?.[1];
    if (f && (!fence || f[0] === fence[0])) fence = fence ? null : f;
    else if (!fence) {
      const m = CHAPTER_LINE.exec(line);
      if (m) out.push({ from: pos, to: pos + line.length, name: m[1] });
    }
    pos += line.length + 1;
  }
  return out;
}

/** Kapitlets titel: første overskrift, ellers filnavnet uden endelse. */
export function chapterTitle(name: string, text: string | null | undefined): string {
  const h = text ? /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text)?.[1] : undefined;
  return h ?? name.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
}

/**
 * Hovedfilen med kapitlerne sat ind, til print, PDF og Word. Fodnoternes navne får kapitlets nummer
 * foran (`[^k2-1]`), så to kapitler med `[^1]` ikke støder sammen. Et kapitel, der mangler, står
 * som en linje, der siger det. Kapitler i et kapitel sættes ikke ind (ingen ring).
 */
export function expandChapters(doc: string, texts: ReadonlyMap<string, string | null>): string {
  const lines = findChapters(doc);
  if (!lines.length) return doc;
  let out = "";
  let at = 0;
  lines.forEach((c, i) => {
    const text = texts.get(c.name);
    const body = text == null
      ? tr(`*Kapitlet mangler: ${c.name}*`, `*Chapter missing: ${c.name}*`)
      : text.replace(/\[\^([^\]\s]+)\]/g, `[^k${i + 1}-$1]`).trim();
    // Altid en tom linje før og efter kapitlet: ellers læses den næste kapitellinje som en del af
    // kapitlets sidste fodnote (prøven 21/10). Aldrig to tomme linjer, som print læser som luft.
    const before = doc.slice(at, c.from);
    out += before;
    if (out && !out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n";
    out += body;
    at = c.to;
    const next = doc.slice(at, at + 2);
    if (next !== "\n\n" && at < doc.length) out += next.startsWith("\n") ? "\n" : "\n\n";
  });
  return out + doc.slice(at);
}

// --- i editoren --------------------------------------------------------------------------------

/** Kapitlernes tekster, navn → tekst (null: mangler). Sættes af hovedvinduet efter `read_chapters`. */
export const setChapterTexts = StateEffect.define<Map<string, string | null>>();

export const chapterTexts = StateField.define<Map<string, string | null>>({
  create: () => new Map(),
  update(v, tr) {
    // Kapitlerne hentes igen ved hver vinduesfokus. Er intet ændret, bliver feltet det samme, så
    // kortene ikke bygges forfra (gennemgang 22/10).
    for (const e of tr.effects) if (e.is(setChapterTexts)) return sameTexts(v, e.value) ? v : e.value;
    return v;
  },
});

function sameTexts(a: ReadonlyMap<string, string | null>, b: ReadonlyMap<string, string | null>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, text] of b) if (!a.has(name) || a.get(name) !== text) return false;
  return true;
}

/**
 * Kapitellinjerne flyttes med teksten og findes kun forfra, når en ændring rører en linje, der
 * begynder med `/`, eller en kodeblok. Før blev hele teksten læst ved hvert tastetryk og hver
 * markørflytning (gennemgang 22/10).
 */
const lineMemo = new TextMemo<ChapterLine[]>(
  [/^\//m, "```", "~~~"],
  findChapters,
  (lines, changes) => lines.map((l) => ({ name: l.name, from: changes.mapPos(l.from), to: changes.mapPos(l.to) })),
  (lines) => lines,
);

type ChapterStats = { words: number | null; title: string };

/** Ordtal og titel pr. kapitel, regnet én gang pr. hentning af teksterne, ikke ved hver opbygning. */
const stats = new WeakMap<ReadonlyMap<string, string | null>, Map<string, ChapterStats>>();

function statsOf(texts: ReadonlyMap<string, string | null>, name: string): ChapterStats {
  let byName = stats.get(texts);
  if (!byName) stats.set(texts, (byName = new Map()));
  let hit = byName.get(name);
  if (!hit) {
    const text = texts.get(name);
    hit = { words: text == null ? null : count(text).words, title: chapterTitle(name, text) };
    byName.set(name, hit);
  }
  return hit;
}

const words = (n: number) => n.toLocaleString(currentLang() === "en" ? "en-GB" : "da-DK");

class ChapterCard extends WidgetType {
  name: string;
  title: string;
  count: number | null;
  loaded: boolean;
  constructor(name: string, title: string, count: number | null, loaded: boolean) {
    super();
    this.name = name;
    this.title = title;
    this.count = count;
    this.loaded = loaded;
  }
  eq(o: ChapterCard): boolean {
    return o.name === this.name && o.title === this.title && o.count === this.count && o.loaded === this.loaded;
  }
  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement("div");
    card.className = "gt-chapter" + (this.loaded && this.count === null ? " gt-chapter-missing" : "");
    card.title = tr(`Klik for at åbne ${this.name}. Klik ved siden af for at rette linjen.`, `Click to open ${this.name}. Click beside it to edit the line.`);
    const title = document.createElement("span");
    title.className = "gt-chapter-title";
    title.textContent = this.title;
    const meta = document.createElement("span");
    meta.className = "gt-chapter-meta";
    meta.textContent = !this.loaded ? "" : this.count === null ? tr("findes ikke", "not found") : tr(`${words(this.count)} ord`, `${words(this.count)} words`);
    card.append(title, meta);
    card.addEventListener("mousedown", (e) => {
      e.preventDefault();
      // Klik på kortet åbner kapitlet. Uden for kortets tekst står markøren på linjen, så stien kan rettes.
      if (e.target === card) {
        view.dispatch({ selection: { anchor: view.state.doc.lineAt(view.posAtDOM(card)).to } });
        view.focus();
      } else if (this.count !== null) window.dispatchEvent(new CustomEvent("gt-open-link", { detail: this.name }));
    });
    return card;
  }
}

class ChapterTotal extends WidgetType {
  text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  eq(o: ChapterTotal): boolean {
    return o.text === this.text;
  }
  toDOM(): HTMLElement {
    const p = document.createElement("div");
    p.className = "gt-chapter-total";
    p.textContent = this.text;
    return p;
  }
}

function activeLine(state: EditorState, lines: ChapterLine[]): number {
  const head = state.selection.main.head;
  return lines.find((l) => head >= l.from && head <= l.to)?.from ?? -1;
}

function build(state: EditorState, lines: ChapterLine[]): DecorationSet {
  if (!lines.length) return Decoration.none;
  const texts = state.field(chapterTexts);
  const active = activeLine(state, lines);
  const out: Range<Decoration>[] = [];
  let total = 0;
  let missing = 0;
  for (const l of lines) {
    const loaded = texts.has(l.name);
    const { words: n, title } = statsOf(texts, l.name);
    if (n !== null) total += n;
    else if (loaded) missing++;
    const widget = new ChapterCard(l.name, title, n, loaded);
    // Som billederne: står markøren på linjen, ses stien, og kortet står under den.
    out.push(l.from === active ? Decoration.widget({ widget, block: true, side: 1 }).range(l.to) : Decoration.replace({ widget, block: true }).range(l.from, l.to));
  }
  if (texts.size) {
    const sum = tr(`I alt ${words(total)} ord i ${lines.length} kapitler`, `${words(total)} words in ${lines.length} chapters`);
    const gone = missing ? tr(`, ${missing} findes ikke`, `, ${missing} not found`) : "";
    out.push(Decoration.widget({ widget: new ChapterTotal(sum + gone), block: true, side: 2 }).range(lines[lines.length - 1].to));
  }
  return Decoration.set(out, true);
}

const cards = StateField.define<{ deco: DecorationSet; key: string }>({
  create: (state) => ({ deco: build(state, lineMemo.get(state.doc)), key: "" }),
  update(v, tr) {
    lineMemo.advanceTr(tr);
    const textsChanged = tr.startState.field(chapterTexts) !== tr.state.field(chapterTexts);
    if (!tr.docChanged && !tr.selection && !textsChanged) return v;
    const lines = lineMemo.get(tr.state.doc);
    const key = `${activeLine(tr.state, lines)}|${lines.map((l) => l.name).join("\n")}`;
    if (key !== v.key || textsChanged) return { deco: build(tr.state, lines), key };
    return tr.docChanged ? { deco: v.deco.map(tr.changes), key } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

let loader: ((names: string[]) => void) | null = null;
/** Hovedvinduet henter kapitlerne, når linjerne ændrer sig (main.ts). */
export function setChapterLoader(fn: (names: string[]) => void): void {
  loader = fn;
}

/** Navnene, der skal hentes. Kun når listen ændrer sig, og et halvt sekund efter sidste tastetryk. */
const watch = ViewPlugin.fromClass(
  class {
    names = "";
    timer: number | undefined;
    constructor(view: EditorView) {
      this.check(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.check(u.view);
    }
    check(view: EditorView) {
      const names = lineMemo.get(view.state.doc).map((l) => l.name);
      const key = names.join("\n");
      if (key === this.names) return;
      this.names = key;
      window.clearTimeout(this.timer);
      if (names.length) this.timer = window.setTimeout(() => loader?.(names), 500);
    }
    destroy() {
      window.clearTimeout(this.timer);
    }
  },
);

export const chapters = [chapterTexts, cards, watch];

export const chaptersTheme = EditorView.theme({
  ".gt-chapter": { display: "flex", alignItems: "baseline", gap: "12px", fontFamily: "var(--ui)", fontSize: "14px", padding: "7px 12px", margin: "3px 0", border: "1px solid var(--streg)", borderRadius: "6px", cursor: "pointer" },
  ".gt-chapter:hover": { borderColor: "var(--kant-hover)" },
  ".gt-chapter-title": { flex: "1", color: "var(--blæk)", cursor: "pointer" },
  ".gt-chapter-meta": { fontSize: "12px", color: "var(--svag)", cursor: "pointer" },
  ".gt-chapter-missing .gt-chapter-title": { color: "var(--svag)", textDecoration: "line-through" },
  ".gt-chapter-total": { fontFamily: "var(--ui)", fontSize: "12px", color: "var(--svag)", padding: "4px 12px 10px" },
});
