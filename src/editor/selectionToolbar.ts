// Menuen ved markering (design runde 2, »Detaljer«): B, I, U, S, lister, H1-H4 og »···« med Lav til
// tabel, Citat, Link, Dæmp, Flyt til fraklip, Fodnote, Skær lidt og Faktatjek (fanen Input), Markér
// som mit eller AI, og Fjern formatering. Vises kun efter en
// markering med musen, så den aldrig dukker op, mens brugeren skriver eller markerer med tastaturet.

import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";

import { cmd, type Command } from "./shortcuts.ts";
import { pickImage } from "./insertImage.ts";
import { showMenu } from "../ui/menu.ts";
import { tr } from "../i18n.ts";

const setMouseSelected = StateEffect.define<boolean>();

const mouseSelected = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMouseSelected)) return e.value;
    if (tr.docChanged || (tr.selection && !tr.isUserEvent("select.pointer"))) return false;
    return value;
  },
});

function button(label: string, title: string, run: Command, view: EditorView, style = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sel-btn";
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  if (style) b.setAttribute("style", style);
  // mousedown, ikke click: markeringen må ikke forsvinde, før kommandoen kører.
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    run(view);
  });
  return b;
}

function sep(): HTMLElement {
  const s = document.createElement("span");
  s.className = "sel-sep";
  return s;
}

function toolbar(state: EditorState): Tooltip | null {
  const sel = state.selection.main;
  if (sel.empty || !state.field(mouseSelected)) return null;
  return {
    pos: sel.from,
    above: true,
    arrow: false,
    create: (view) => {
      const dom = document.createElement("div");
      dom.className = "sel-bar";
      dom.setAttribute("role", "toolbar");
      dom.setAttribute("aria-label", tr("Formatering", "Formatting"));
      dom.append(
        button("B", tr("Fed (Ctrl+B)", "Bold (Ctrl+B)"), cmd.bold, view, "font-weight:700"),
        button("I", tr("Kursiv (Ctrl+I)", "Italic (Ctrl+I)"), cmd.italic, view, "font-style:italic"),
        button("U", tr("Understreget (Ctrl+U)", "Underline (Ctrl+U)"), cmd.underline, view, "text-decoration:underline"),
        button("S", tr("Gennemstreget (Ctrl+Shift+X)", "Strikethrough (Ctrl+Shift+X)"), cmd.strike, view, "text-decoration:line-through"),
        sep(),
        button("•", tr("Punktliste (Ctrl+Shift+8)", "Bulleted list (Ctrl+Shift+8)"), cmd.bullets, view),
        button("1.", tr("Nummereret liste (Ctrl+Shift+7)", "Numbered list (Ctrl+Shift+7)"), cmd.numbered, view),
        sep(),
        button("H1", tr("Overskrift 1 (Ctrl+1)", "Heading 1 (Ctrl+1)"), cmd.heading(1), view),
        button("H2", tr("Overskrift 2 (Ctrl+2)", "Heading 2 (Ctrl+2)"), cmd.heading(2), view),
        button("H3", tr("Overskrift 3 (Ctrl+3)", "Heading 3 (Ctrl+3)"), cmd.heading(3), view),
        button("H4", tr("Manchet (Ctrl+4)", "Standfirst (Ctrl+4)"), cmd.heading(4), view),
        sep(),
      );
      const more = button("···", tr("Mere", "More"), () => true, view);
      // Åbnes efter klikket: menuens egen lytter lukker ved mousedown udenfor.
      more.addEventListener("mousedown", () => window.setTimeout(() => {
        const r = more.getBoundingClientRect();
        showMenu(r.left, r.bottom + 4, [
          { label: tr("Lav til tabel", "Make a table"), run: () => cmd.table(view) },
          { label: tr("Citat", "Quote"), run: () => cmd.quote(view) },
          { label: "Link", run: () => cmd.link(view) },
          { label: tr("Dæmp", "Dim"), run: () => cmd.dim(view) },
          { label: tr("Flyt til fraklip", "Move to Clippings"), run: () => cmd.park(view) },
          { label: tr("Fodnote", "Footnote"), run: () => cmd.footnote(view) },
          { label: tr("Note til mig selv", "Note to yourself"), run: () => cmd.note(view) },
          { label: tr("Indsæt billede …", "Insert image …"), run: () => pickImage(view) },
          { separator: true },
          { label: tr("Skær lidt i markeringen", "Trim the selection a little"), run: () => window.dispatchEvent(new CustomEvent("gt-claude", { detail: "cut" })) },
          { label: tr("Faktatjek markeringen", "Fact-check the selection"), run: () => window.dispatchEvent(new CustomEvent("gt-claude", { detail: "factcheck" })) },
          { label: tr("Renskriv markeringen som interview", "Clean up the selection as an interview"), run: () => window.dispatchEvent(new CustomEvent("gt-claude", { detail: "clean" })) },
          // »Markér som mit/AI/andres« er taget ud (4/10), til vi ved, hvad det skal være
          // (docs/IDEER.md). Mærkerne i filen bevares stadig ved gem.
          { separator: true },
          { label: tr("Fjern formatering", "Clear formatting"), run: () => cmd.clear(view) },
        ]);
      }, 0));
      dom.append(more);
      return { dom };
    },
  };
}

const toolbarField = StateField.define<Tooltip | null>({
  create: toolbar,
  update: (_v, tr) => toolbar(tr.state),
  provide: (f) => showTooltip.from(f),
});

/** Markering med musen slutter ved mouseup. Først da må menuen komme frem. */
const mouseWatch = EditorView.domEventHandlers({
  mousedown(_e, view) {
    if (view.state.field(mouseSelected)) view.dispatch({ effects: setMouseSelected.of(false) });
    return false;
  },
  mouseup(_e, view) {
    window.setTimeout(() => {
      if (!view.state.selection.main.empty) view.dispatch({ effects: setMouseSelected.of(true) });
    }, 0);
    return false;
  },
});

export const selectionToolbar = [mouseSelected, toolbarField, mouseWatch];

export const selectionToolbarTheme = EditorView.theme({
  ".cm-tooltip.sel-bar, .sel-bar": {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    background: "var(--kort)",
    border: "1px solid var(--kant)",
    borderRadius: "10px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
    padding: "4px",
    fontFamily: "var(--ui)",
    fontSize: "13px",
  },
  ".sel-btn": {
    minWidth: "32px",
    height: "32px",
    border: "none",
    background: "none",
    borderRadius: "6px",
    color: "var(--blæk)",
    cursor: "pointer",
    font: "inherit",
    fontSize: "13px",
  },
  ".sel-btn:hover": { background: "var(--hover)" },
  ".sel-sep": { width: "1px", height: "20px", background: "var(--streg)", margin: "0 4px" },
  ".cm-tooltip": { border: "none", background: "transparent" },
});
