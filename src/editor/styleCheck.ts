// Dansk stiltjek uden AI (valgt efter research 2/10, som iA Writers Style Check og Hemingway).
// Reglerne er Gode Ords (src/sprog/, kopi med commit-stempel): fyldord, floskler og klichéer,
// kancellisprog og fremmedord med et enklere ord, tunge sætninger (lange, passiv, nominaliseringer,
// tung optakt, svagt anslag) og husets egne regler fra SKRIVESTIL (em-dash, AI-ord, vage kilder).
//
// Slået fra som standard; F7 slår det til, som Words stave- og grammatiktjek. Kun farve og streger,
// så intet hopper. Tekst inde i citater markeres ikke. Beregnes 400 ms efter sidste tastetryk i en
// worker, så skrivefladen aldrig venter på reglerne (styleRules.ts, styleWorker.ts).

import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

import { categoryOf, type Density, type Flag } from "./styleRules.ts";
import { authorshipField } from "./authorship.ts";
import { tr } from "../i18n.ts";

const SUGGESTION = tr("Forslag", "Suggestion");

export { analyze, categoryOf, mask, type Category, type Density, type Flag } from "./styleRules.ts";

// --- i editoren ----------------------------------------------------------------------------------

let enabled = false;
let lastLix: { lix: number; label: string } | null = null;
let lastFlags: Flag[] = [];
let lastDensity: Density | null = null;
/** Alle fund fra analysen, før skjulte kategorier og afviste fund er trukket fra. */
let allFlags: Flag[] = [];
const setFlags = StateEffect.define<Flag[]>();

/** Kategorier, der er slået fra i fanen Sprog (indstillingen hiddenStyle, fase 1 13/10). */
let hidden = new Set<string>();
/**
 * Fund, der er afvist med »Ikke nyttigt«: regel og ord. Samme ord med samme regel vises ikke igen,
 * så længe programmet kører. Tælleren pr. regel gemmes i indstillingerne (styleNotUseful).
 */
const dismissed = new Set<string>();
const dismissKey = (kind: string, text: string) => `${kind}|${text.toLowerCase()}`;

/** Det, der skal vises af et sæt fund: ikke skjulte kategorier, ikke afviste fund. */
function visible(flags: Flag[], doc: { sliceString(from: number, to: number): string }): Flag[] {
  return flags.filter((f) => !hidden.has(categoryOf(f.kind)) && !dismissed.has(dismissKey(f.kind, doc.sliceString(f.from, f.to))));
}

/** Fundene fra den seneste analyse, til fanen Sprog (tom, når stiltjekket er slået fra). */
export function currentFlags(): Flag[] {
  return enabled ? lastFlags : [];
}

/** Passiv og navneordsstil for hele teksten (fase 1, 13/10), til fanen Sprog. */
export function currentDensity(): Density | null {
  return enabled ? lastDensity : null;
}

/** LIX for den seneste analyse, til ordtalshjørnet (kun når stiltjekket er slået til). */
export function currentLix(): { lix: number; label: string } | null {
  return enabled ? lastLix : null;
}

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setFlags)) {
        const out: Range<Decoration>[] = [];
        for (const f of e.value) {
          if (f.to <= f.from || f.to > tr.state.doc.length) continue;
          const title = f.replacement ? `${f.message} ${SUGGESTION}: »${f.replacement}«` : f.message;
          out.push(Decoration.mark({ class: `gt-style gt-style-${categoryOf(f.kind)}`, attributes: { title }, flag: f }).range(f.from, f.to));
        }
        return Decoration.set(out, true);
      }
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Fundet ved `pos`, med dets plads nu (flyttet med teksten siden analysen), til højreklik (9/10).
 */
export function flagAt(state: EditorState, pos: number): { from: number; to: number; kind: string; message: string; replacement?: string } | null {
  let hit: { from: number; to: number; kind: string; message: string; replacement?: string } | null = null;
  state.field(field, false)?.between(pos, pos, (from, to, deco) => {
    const f = (deco.spec as { flag?: Flag }).flag;
    if (!f || pos < from || pos > to) return;
    hit = { from, to, kind: f.kind, message: f.message, replacement: f.replacement ?? undefined };
    return false;
  });
  return hit;
}

/**
 * »Ikke nyttigt« (højreklik): fundet og alle med samme regel og samme ord forsvinder. Kalderen
 * tæller reglen op i indstillingerne (contextMenu.ts).
 */
export function dismissFlag(view: EditorView, flag: { from: number; to: number; kind: string }): void {
  dismissed.add(dismissKey(flag.kind, view.state.sliceDoc(flag.from, flag.to)));
  redraw(view);
}

/** Kategorierne, der ikke vises. Tegner om med det samme, uden ny analyse. */
export function setHiddenStyle(view: EditorView, categories: readonly string[]): void {
  const next = new Set(categories);
  if (next.size === hidden.size && [...next].every((c) => hidden.has(c))) return;
  hidden = next;
  redraw(view);
}

/** Teksten, analysen sidst blev vist på. Er den ændret, passer positionerne i allFlags ikke længere. */
let lastShownDoc: EditorState["doc"] | null = null;
function redraw(view: EditorView): void {
  if (!enabled) return;
  // Er teksten ændret siden analysen, passer positionerne ikke: analysér igen.
  if (lastShownDoc !== view.state.doc) return void view.plugin(runner)?.schedule(0);
  lastFlags = visible(allFlags, view.state.doc);
  view.dispatch({ effects: setFlags.of(lastFlags) });
  window.dispatchEvent(new Event("gt-style"));
}

/** Teksten med »andres tekst« blanket ud: stiltjekket retter ikke i citater og kilders ord. */
function withoutOthers(state: EditorState): string {
  const text = state.doc.toString();
  const spans = (state.field(authorshipField, false)?.authors ?? []).filter((a) => a.author.kind === "reference").flatMap((a) => a.spans);
  const chunks: string[] = [];
  let end = 0;
  for (const s of spans.sort((a,b) => a.start-b.start)) {
    const from=Math.max(end,s.start), to=Math.min(text.length,s.end);
    if(to<=from)continue;
    chunks.push(text.slice(end,from),text.slice(from,to).replace(/[^\n]/g," "));
    end=to;
  }
  chunks.push(text.slice(end));
  return chunks.join("");
}

let worker: Worker | null = null;
let generation = 0;

const runner = ViewPlugin.fromClass(
  class {
    timer: number | undefined;
    view: EditorView;
    shown = false;
    constructor(view: EditorView) {
      this.view = view;
      this.schedule(0);
    }
    update(u: ViewUpdate) {
      if (u.docChanged && enabled) this.schedule(400);
    }
    schedule(ms: number) {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.run(), ms);
    }
    run() {
      const id = ++generation;
      if (!enabled) {
        lastLix = null;
        lastFlags = [];
        allFlags = [];
        lastDensity = null;
        if (this.shown) this.view.dispatch({ effects: setFlags.of([]) });
        this.shown = false;
        return;
      }
      const doc = this.view.state.doc;
      worker ??= new Worker(new URL("./styleWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<{ id: number; flags: Flag[]; lix: number; lixLabel: string; density: Density }>) => {
        // Et svar på en ældre udgave af teksten kastes væk; en ny kørsel er allerede på vej.
        if (e.data.id !== generation || this.view.state.doc !== doc || !enabled) return;
        lastLix = { lix: e.data.lix, label: e.data.lixLabel };
        lastDensity = e.data.density;
        allFlags = e.data.flags;
        lastFlags = visible(allFlags, doc);
        lastShownDoc = doc;
        this.shown = true;
        this.view.dispatch({ effects: setFlags.of(lastFlags) });
        window.dispatchEvent(new Event("gt-style"));
      };
      worker.postMessage({ id, doc: withoutOthers(this.view.state), comma, strict });
    }
    destroy() {
      window.clearTimeout(this.timer);
    }
  },
);

/** F7 og indstillingen »Stiltjek«: slå til eller fra og tegn med det samme. */
export function setStyleCheck(view: EditorView, on: boolean): void {
  enabled = on;
  view.plugin(runner)?.schedule(0);
}

/** Kommatjekket (Indstillinger › Tekst, 7/10): "start", "uden" eller "fra". Et skift tjekker igen. */
let comma = "start";
/** »Alle forslag« (Indstillinger › Tekst): også de regler, der oftere tager fejl. Et skift tjekker igen. */
let strict = false;
export function setStrictStyle(view: EditorView, on: boolean): void {
  if (on === strict) return;
  strict = on;
  view.plugin(runner)?.schedule(0);
}

export function setCommaStyle(view: EditorView, style: string): void {
  if (style === comma) return;
  comma = style;
  view.plugin(runner)?.schedule(0);
}

export const styleCheck = [field, runner];

export const styleCheckTheme = EditorView.theme({
  ".gt-style-stryg": { textDecoration: "line-through", textDecorationColor: "var(--svag)", color: "var(--svag)" },
  ".gt-style-enklere": { textDecoration: "underline dotted var(--link)", textUnderlineOffset: "4px" },
  ".gt-style-saetning": { backgroundColor: "var(--fund)", borderRadius: "2px" },
  // Grammatik som i Word: en blå bølget streg (7/10).
  ".gt-style-grammatik": { textDecoration: "underline wavy var(--link)", textDecorationThickness: "1px", textUnderlineOffset: "4px" },
  ".gt-style-hus": { textDecoration: "underline wavy var(--fejl)", textDecorationThickness: "1px", textUnderlineOffset: "4px" },
});
