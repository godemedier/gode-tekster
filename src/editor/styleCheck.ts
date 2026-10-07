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

import { categoryOf, type Flag } from "./styleRules.ts";
import { authorshipField } from "./authorship.ts";
import { tr } from "../i18n.ts";

const SUGGESTION = tr("Forslag", "Suggestion");

export { analyze, categoryOf, mask, type Flag } from "./styleRules.ts";

// --- i editoren ----------------------------------------------------------------------------------

let enabled = false;
let lastLix: { lix: number; label: string } | null = null;
let lastFlags: Flag[] = [];
const setFlags = StateEffect.define<Flag[]>();

/** Fundene fra den seneste analyse, til fanen Sprog (tom, når stiltjekket er slået fra). */
export function currentFlags(): Flag[] {
  return enabled ? lastFlags : [];
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
          out.push(Decoration.mark({ class: `gt-style gt-style-${categoryOf(f.kind)}`, attributes: { title } }).range(f.from, f.to));
        }
        return Decoration.set(out, true);
      }
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Teksten med »andres tekst« blanket ud: stiltjekket retter ikke i citater og kilders ord. */
function withoutOthers(state: EditorState): string {
  let text = state.doc.toString();
  const spans = (state.field(authorshipField, false)?.authors ?? []).filter((a) => a.author.kind === "reference").flatMap((a) => a.spans);
  for (const s of spans) text = text.slice(0, s.start) + text.slice(s.start, s.end).replace(/[^\n]/g, " ") + text.slice(s.end);
  return text;
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
        if (this.shown) this.view.dispatch({ effects: setFlags.of([]) });
        this.shown = false;
        return;
      }
      const doc = this.view.state.doc;
      worker ??= new Worker(new URL("./styleWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<{ id: number; flags: Flag[]; lix: number; lixLabel: string }>) => {
        // Et svar på en ældre udgave af teksten kastes væk; en ny kørsel er allerede på vej.
        if (e.data.id !== generation || this.view.state.doc !== doc || !enabled) return;
        lastLix = { lix: e.data.lix, label: e.data.lixLabel };
        lastFlags = e.data.flags;
        this.shown = true;
        this.view.dispatch({ effects: setFlags.of(e.data.flags) });
        window.dispatchEvent(new Event("gt-style"));
      };
      worker.postMessage({ id, doc: withoutOthers(this.view.state), comma });
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
