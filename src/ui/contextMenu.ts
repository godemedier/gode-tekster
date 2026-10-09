// Højreklik (9/10): WebView2's egen menu, med stavekontrollens forslag, klip og kopiér, bygges færdig i
// Rust (contextmenu.rs). Lige før den vises, spørger Rust her, hvad der står under musen: et fund fra
// stil- og kommatjekket, en markering, en tabelcelle, eller bare teksten. Et valgt punkt kører her.
// Én menu, ikke to oven på hinanden, og stavekontrollen virker også i tabellerne. En markering får
// de samme punkter som værktøjslinjen (selectionToolbar.ts `selectionGroups`).

import type { EditorView } from "@codemirror/view";

import { flagAt } from "../editor/styleCheck.ts";
import { tableMenuAt } from "../editor/tables.ts";
import { selectionGroups } from "../editor/selectionToolbar.ts";
import type { MenuItem } from "./menu.ts";
import { cmd } from "../editor/shortcuts.ts";
import { pickImage } from "../editor/insertImage.ts";
import { tr } from "../i18n.ts";

/** Et punkt, som Rust laver om til et menupunkt. Uden `id` er det en forklaring, der ikke kan vælges. */
type Entry = { id?: string; label: string; checked?: boolean } | { sep: true };
/** `groups` bliver undermenuer, `plain` står direkte i menuen. Begge lige før »Markér alt«. */
type Context = { word?: string; finding: Entry[]; groups: { label: string; items: Entry[] }[]; plain: Entry[] };

declare global {
  interface Window {
    __gtMenu?: { context: () => string; run: (id: string) => void; replaceWord: (text: string) => void };
  }
}

/** Et fund kan have en lang forklaring. Menuen viser begyndelsen. */
function short(text: string, max = 64): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Ordet under musen, til stavekontrollen i Rust (9/10). I teksten et ord fra CodeMirror, i en
 * tabelcelle ordet i cellens egen tekst: en rettelse skrives i cellen, som skriver sin række om.
 */
function wordUnder(view: EditorView, at: { target: Element; x: number; y: number }, pos: number | null): { text: string; replace: (r: string) => void } | null {
  const isWord = (t: string) => t.length > 1 && /\p{L}/u.test(t) && !/\d/.test(t);
  const cell = at.target.closest<HTMLElement>(".gt-tablebox th, .gt-tablebox td");
  if (cell) {
    const range = document.caretRangeFromPoint(at.x, at.y);
    const node = range?.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE || !cell.contains(node)) return null;
    const text = node.textContent ?? "";
    let from = range.startOffset;
    let to = from;
    while (from > 0 && /[\p{L}\p{M}'’-]/u.test(text[from - 1])) from--;
    while (to < text.length && /[\p{L}\p{M}'’-]/u.test(text[to])) to++;
    const word = text.slice(from, to);
    if (!isWord(word)) return null;
    return {
      text: word,
      replace: (r) => {
        node.textContent = text.slice(0, from) + r + text.slice(to);
        cell.dispatchEvent(new Event("input", { bubbles: true }));
      },
    };
  }
  if (pos === null) return null;
  const range = view.state.wordAt(pos);
  if (!range) return null;
  const word = view.state.sliceDoc(range.from, range.to);
  if (!isWord(word)) return null;
  return {
    text: word,
    replace: (r) => {
      view.dispatch({ changes: { from: range.from, to: range.to, insert: r }, userEvent: "input.spell" });
      view.focus();
    },
  };
}

/** En skillelinje på sin egen linje, med tomme linjer omkring, så markdown læser den. */
function insertRule(view: EditorView): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const insert = line.text.trim() ? `\n\n---\n\n` : `---\n`;
  const at = line.text.trim() ? line.to : line.from;
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: "input.format", scrollIntoView: true });
  view.focus();
}

export function installContextMenu(view: EditorView): void {
  let last: { target: Element; x: number; y: number } | null = null;
  let actions = new Map<string, () => void>();
  let replaceWord: ((r: string) => void) | null = null;
  // Højreklikket kommer her, før WebView2 beder om menuen.
  window.addEventListener(
    "contextmenu",
    (e) => {
      last = e.target instanceof Element ? { target: e.target, x: e.clientX, y: e.clientY } : null;
    },
    true,
  );

  const context = (): Context => {
    actions = new Map();
    replaceWord = null;
    const out: Context = { finding: [], groups: [], plain: [] };
    const at = last;
    if (!at || !view.contentDOM.contains(at.target)) return out;
    const add = (label: string, run: () => void, checked?: boolean): Entry => {
      const id = String(actions.size + 1);
      actions.set(id, run);
      return { id, label, checked };
    };
    const entries = (items: MenuItem[]): Entry[] => items.map((m) => ("separator" in m ? { sep: true } : add(m.label, m.run, m.checked)));

    const pos = view.posAtCoords({ x: at.x, y: at.y });
    // Stavekontrollen: ordet under musen, når der ikke er højreklikket i en markering.
    const sel0 = view.state.selection.main;
    if (sel0.empty || pos === null || pos < sel0.from || pos > sel0.to) {
      const w = wordUnder(view, at, pos);
      if (w) {
        out.word = w.text;
        replaceWord = w.replace;
      }
    }

    // Stil- og kommatjekket: forklaringen og rettelsen, øverst som stavekontrollens forslag.
    const flag = pos === null ? null : flagAt(view.state, pos);
    if (flag) {
      out.finding.push({ label: short(flag.message) });
      if (flag.replacement !== undefined) {
        const { from, to, replacement } = flag;
        out.finding.push(
          add(replacement ? tr(`Ret til »${short(replacement, 40)}«`, `Change to “${short(replacement, 40)}”`) : tr("Fjern", "Remove"), () => {
            view.dispatch({ changes: { from, to, insert: replacement }, userEvent: "input.style" });
            view.focus();
          }),
        );
      }
    }

    // En tabelcelle: tabellens punkter som undermenu, og intet andet.
    const table = tableMenuAt(view, at.target);
    if (table) {
      out.groups.push({ label: tr("Tabel", "Table"), items: entries(table) });
      return out;
    }

    // En markering, og klikket står i den: værktøjslinjens punkter.
    const sel = view.state.selection.main;
    if (!sel.empty && pos !== null && pos >= sel.from && pos <= sel.to) {
      const g = selectionGroups(view);
      out.groups.push({ label: tr("Formatér", "Format"), items: entries(g.format) }, { label: tr("AI-hjælp", "AI help"), items: entries(g.ai) });
      out.plain.push(
        add(tr("Dæmp", "Dim"), () => void cmd.dim(view)),
        add(tr("Flyt til Fraklip", "Move to Clippings"), () => void cmd.park(view)),
        add(tr("Gem som skabelon …", "Save as a template …"), () => window.dispatchEvent(new Event("gt-template-from-selection"))),
      );
    }

    // Tilføj: det, man ellers kun når med genveje og /-kommandoer.
    out.groups.push({
      label: tr("Tilføj", "Add"),
      items: [
        add(tr("Fodnote", "Footnote"), () => cmd.footnote(view)),
        add(tr("Kommentar", "Comment"), () => cmd.note(view)),
        add(tr("Link", "Link"), () => cmd.link(view)),
        { sep: true },
        add(tr("Billede …", "Image …"), () => pickImage(view)),
        add(tr("Tabel", "Table"), () => void import("../commands/run.ts").then((m) => m.insertEmptyTable(view))),
        add(tr("Skillelinje", "Divider"), () => insertRule(view)),
      ],
    });
    return out;
  };

  window.__gtMenu = {
    context: () => JSON.stringify(context()),
    run: (id) => actions.get(id)?.(),
    replaceWord: (text) => replaceWord?.(text),
  };
}
