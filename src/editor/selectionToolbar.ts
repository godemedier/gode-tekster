// Menuen ved markering (9/10, enklere): B, I, U, S, lister, »Overskrift ▾« (brødtekst, H1-H3, manchet),
// AI-hjælpen bag en pen (faktatjek, renskriv, skær) og »···« med resten. Samme punkter står i
// højrekliksmenuen (ui/contextMenu.ts), så de to aldrig kommer ud af trit (`selectionGroups`). Vises
// kun efter en markering med musen, så den aldrig dukker op, mens brugeren skriver.

import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";

import { cmd, type Command } from "./shortcuts.ts";
import { pickImage } from "./insertImage.ts";
import { showMenu, type MenuItem } from "../ui/menu.ts";
import { ICON } from "../ui/icons.ts";
import { tr } from "../i18n.ts";

/** AI-hjælpen på markeringen (fanen Input tager over). */
const ai = (detail: string) => () => window.dispatchEvent(new CustomEvent("gt-claude", { detail }));

/**
 * Punkterne for en markering, i grupper. Værktøjslinjen viser dem som knapper og menuer,
 * højreklik som undermenuer.
 */
export function selectionGroups(view: EditorView): { headings: MenuItem[]; format: MenuItem[]; ai: MenuItem[]; more: MenuItem[] } {
  const run = (c: Command) => () => void c(view);
  const headings: MenuItem[] = [
    { label: tr("Brødtekst (Ctrl+0)", "Body text (Ctrl+0)"), run: run(cmd.heading(0)) },
    { label: tr("Overskrift 1 (Ctrl+1)", "Heading 1 (Ctrl+1)"), run: run(cmd.heading(1)) },
    { label: tr("Overskrift 2 (Ctrl+2)", "Heading 2 (Ctrl+2)"), run: run(cmd.heading(2)) },
    { label: tr("Overskrift 3 (Ctrl+3)", "Heading 3 (Ctrl+3)"), run: run(cmd.heading(3)) },
    { label: tr("Manchet (Ctrl+4)", "Standfirst (Ctrl+4)"), run: run(cmd.heading(4)) },
  ];
  return {
    headings,
    format: [
      { label: tr("Fed", "Bold"), run: run(cmd.bold) },
      { label: tr("Kursiv", "Italic"), run: run(cmd.italic) },
      { label: tr("Understreget", "Underline"), run: run(cmd.underline) },
      { label: tr("Gennemstreget", "Strikethrough"), run: run(cmd.strike) },
      { separator: true },
      ...headings,
      { separator: true },
      { label: tr("Punktliste", "Bulleted list"), run: run(cmd.bullets) },
      { label: tr("Nummereret liste", "Numbered list"), run: run(cmd.numbered) },
      { label: tr("Citat", "Quote"), run: run(cmd.quote) },
      { label: tr("Lav til tabel", "Make a table"), run: run(cmd.table) },
      { separator: true },
      { label: tr("Fjern formatering", "Clear formatting"), run: run(cmd.clear) },
    ],
    ai: [
      { label: tr("Faktatjek", "Fact-check"), run: ai("factcheck") },
      { label: tr("Renskriv som interview", "Clean up as an interview"), run: ai("clean") },
      { label: tr("Skær lidt", "Trim a little"), run: ai("cut") },
    ],
    more: [
      { label: "Link", run: run(cmd.link) },
      { label: tr("Dæmp", "Dim"), run: run(cmd.dim) },
      { label: tr("Flyt til Fraklip", "Move to Clippings"), run: run(cmd.park) },
      { label: tr("Fodnote", "Footnote"), run: run(cmd.footnote) },
      { label: tr("Kommentar til mig selv", "Comment to myself"), run: run(cmd.note) },
      { label: tr("Indsæt billede …", "Insert image …"), run: () => void pickImage(view) },
      { separator: true },
      { label: tr("Citat", "Quote"), run: run(cmd.quote) },
      { label: tr("Lav til tabel", "Make a table"), run: run(cmd.table) },
      { label: tr("Fjern formatering", "Clear formatting"), run: run(cmd.clear) },
    ],
  };
}

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

/** En knap med en lille menu. `icon`: teksten er et af ICON's faste SVG'er. */
function menuButton(content: string, title: string, items: MenuItem[], view: EditorView, icon = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sel-btn sel-menu";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.setAttribute("aria-haspopup", "menu");
  if (icon) b.innerHTML = content;
  else b.textContent = content;
  // En lille pil viser, at knappen åbner en menu (ikke på »···«, der siger det selv).
  if (content !== "···") b.classList.add("sel-drop");
  // Åbnes efter klikket: menuens egen lytter lukker ved mousedown udenfor. Markeringen bliver.
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    window.setTimeout(() => {
      const r = b.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, items);
      view.focus();
    }, 0);
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
      const groups = selectionGroups(view);
      dom.append(
        button("B", tr("Fed (Ctrl+B)", "Bold (Ctrl+B)"), cmd.bold, view, "font-weight:700"),
        button("I", tr("Kursiv (Ctrl+I)", "Italic (Ctrl+I)"), cmd.italic, view, "font-style:italic"),
        button("U", tr("Understreget (Ctrl+U)", "Underline (Ctrl+U)"), cmd.underline, view, "text-decoration:underline"),
        button("S", tr("Gennemstreget (Ctrl+Shift+X)", "Strikethrough (Ctrl+Shift+X)"), cmd.strike, view, "text-decoration:line-through"),
        sep(),
        button("•", tr("Punktliste (Ctrl+Shift+8)", "Bulleted list (Ctrl+Shift+8)"), cmd.bullets, view),
        button("1.", tr("Nummereret liste (Ctrl+Shift+7)", "Numbered list (Ctrl+Shift+7)"), cmd.numbered, view),
        sep(),
        menuButton(tr("Overskrift", "Heading"), tr("Overskrift og manchet", "Heading and standfirst"), groups.headings, view),
        menuButton(ICON.pen, tr("AI-hjælp: faktatjek, renskriv, skær", "AI help: fact-check, clean up, trim"), groups.ai, view, true),
        sep(),
      );
      const more = menuButton("···", tr("Mere", "More"), groups.more, view);
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
  ".sel-menu": { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "4px", padding: "0 8px" },
  ".sel-menu svg": { display: "block" },
  ".sel-drop::after": { content: '""', width: "4px", height: "4px", margin: "0 0 3px 2px", border: "solid currentColor", borderWidth: "0 1.5px 1.5px 0", transform: "rotate(45deg)", opacity: "0.7" },
  ".cm-tooltip": { border: "none", background: "transparent" },
});
