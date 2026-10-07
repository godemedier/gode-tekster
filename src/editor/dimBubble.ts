// Står markøren i dæmpet tekst, kommer en lille boble: »Fjern dæmpning« eller »Til fraklip«
// (2/10: dæmpning skal let kunne klikkes væk). Erstatter de gamle skær-forslag, som skulle
// godkendes ét ad gangen.

import { StateField, type EditorState } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";

import { parkDimmedChanges, undimChanges } from "./dimming.ts";
import { tr } from "../i18n.ts";

/** Det dæmpede stykke om markøren. Søger højst et stykke tilbage og frem, så et tastetryk er billigt. */
export function dimmedAround(state: EditorState, pos: number): { from: number; to: number; body: string } | null {
  const start = Math.max(0, pos - 20_000);
  const before = state.sliceDoc(start, Math.min(state.doc.length, pos + 2));
  const o = before.lastIndexOf("{--");
  if (o === -1) return null;
  const from = start + o;
  const after = state.sliceDoc(from, Math.min(state.doc.length, from + 40_000));
  const c = after.indexOf("--}", 3);
  if (c === -1) return null;
  const to = from + c + 3;
  if (pos < from || pos > to) return null;
  return { from, to, body: state.sliceDoc(from + 3, to - 3) };
}

function bubble(state: EditorState): Tooltip | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const d = dimmedAround(state, sel.head);
  if (!d) return null;
  return {
    pos: d.from,
    above: true,
    arrow: false,
    create: (view) => {
      const dom = document.createElement("div");
      dom.className = "gt-dim-bubble";
      const button = (label: string, run: () => void) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.addEventListener("mousedown", (e) => {
          e.preventDefault();
          run();
        });
        return b;
      };
      dom.append(
        button(tr("Fjern dæmpning", "Undim"), () => view.dispatch({ changes: undimChanges(d), userEvent: "input.undim" })),
        button(tr("Til fraklip", "To Clippings"), () => {
          view.dispatch({ changes: parkDimmedChanges(view.state.doc.toString(), [d]), userEvent: "delete.park" });
          window.dispatchEvent(new Event("gt-parked"));
        }),
      );
      return { dom };
    },
  };
}

const bubbleField = StateField.define<Tooltip | null>({
  create: bubble,
  update: (value, tr) => (tr.docChanged || tr.selection ? bubble(tr.state) : value),
  provide: (f) => showTooltip.from(f),
});

export const dimBubble = [
  bubbleField,
  EditorView.theme({
    ".gt-dim-bubble": {
      display: "flex",
      gap: "6px",
      background: "var(--kort)",
      border: "1px solid var(--kant)",
      borderRadius: "10px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
      padding: "5px",
      fontFamily: "var(--ui)",
      fontSize: "13px",
    },
    ".gt-dim-bubble button": { font: "inherit", border: "1px solid var(--kant)", background: "var(--kort)", color: "var(--blæk)", borderRadius: "8px", height: "28px", padding: "0 10px", cursor: "pointer" },
    ".gt-dim-bubble button:hover": { background: "var(--hover)" },
  }),
];
