// Markeringen følger ordene (6/10: »markeringen bør følge ordenes linje, ikke hele linjen«).
// CodeMirrors egen markering trækkes ud til venstre og højre kant, og den venstre kant er den
// første linjes, så i et listepunkt med hængende indrykning stak markeringen ud foran teksten.
// Her tegnes markeringen af de rektangler, browseren selv regner ud for den markerede tekst: ét
// pr. synlig linje, så højt som linjen. En tom linje midt i markeringen får en smal blok, så man
// kan se, at den er med. CodeMirrors markering bliver stående, men usynlig (iaTheme i setup.ts),
// fordi drawSelection også tegner markøren.

import type { SelectionRange } from "@codemirror/state";
import { EditorView, RectangleMarker, layer } from "@codemirror/view";

const CLASS = "gt-selection";

/** Dokumentets nulpunkt for lagets markører, som CodeMirror selv regner det (getBase). */
function base(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  return { left: rect.left - view.scrollDOM.scrollLeft * view.scaleX, top: rect.top - view.scrollDOM.scrollTop * view.scaleY };
}

type Box = { left: number; right: number; top: number; bottom: number };

function markersFor(view: EditorView, range: SelectionRange): RectangleMarker[] {
  const from = Math.max(range.from, view.viewport.from);
  const to = Math.min(range.to, view.viewport.to);
  if (from >= to) return [];
  const boxes: Box[] = [];
  const lineHeights = new Map<Element, number>();
  const pad = (node: Node, height: number): number => {
    const line = node.parentElement?.closest(".cm-line");
    if (!line) return 0;
    let lh = lineHeights.get(line);
    if (lh === undefined) {
      lh = parseFloat(getComputedStyle(line).lineHeight) || height;
      lineHeights.set(line, lh);
    }
    return Math.max(0, (lh - height) / 2);
  };

  // Tekstnoderne i det markerede, hver for sig: et Range over flere elementer ville også give
  // elementernes egne kasser, og så var vi tilbage ved hele linjer.
  const start = view.domAtPos(from);
  const end = view.domAtPos(to);
  const whole = document.createRange();
  try {
    whole.setStart(start.node, start.offset);
    whole.setEnd(end.node, end.offset);
  } catch {
    return [...RectangleMarker.forRange(view, CLASS, range)];
  }
  const walker = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
  const piece = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!whole.intersectsNode(node)) continue;
    const text = node as Text;
    piece.selectNodeContents(text);
    if (text === whole.startContainer) piece.setStart(text, whole.startOffset);
    if (text === whole.endContainer) piece.setEnd(text, whole.endOffset);
    for (const r of piece.getClientRects()) {
      if (r.width < 0.5 || r.height <= 0) continue;
      const p = pad(text, r.height);
      boxes.push({ left: r.left, right: r.right, top: r.top - p, bottom: r.bottom + p });
    }
  }

  // Tomme linjer helt inde i markeringen: en smal blok ved linjens start.
  const doc = view.state.doc;
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
    const line = doc.line(n);
    if (line.length > 0 || line.from < from || line.to >= to) continue;
    const c = view.coordsAtPos(line.from, 1);
    if (c) boxes.push({ left: c.left, right: c.left + view.defaultCharacterWidth * 0.6, top: c.top, bottom: c.bottom });
  }

  // Ét felt pr. synlig linje: kasser, der overlapper lodret, lægges sammen.
  boxes.sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: Box[] = [];
  for (const b of boxes) {
    const last = merged[merged.length - 1];
    const mid = (b.top + b.bottom) / 2;
    if (last && mid > last.top && mid < last.bottom) {
      last.left = Math.min(last.left, b.left);
      last.right = Math.max(last.right, b.right);
      last.top = Math.min(last.top, b.top);
      last.bottom = Math.max(last.bottom, b.bottom);
    } else {
      merged.push({ ...b });
    }
  }
  // Linjer, der næsten rører hinanden, mødes på midten, så der ikke står en hårfin sprække.
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i].top - merged[i - 1].bottom;
    if (gap > 0 && gap < 3) merged[i - 1].bottom = merged[i].top;
  }
  const o = base(view);
  return merged.map((b) => new RectangleMarker(CLASS, b.left - o.left, b.top - o.top, b.right - b.left, b.bottom - b.top));
}

export const wordSelection = [
  layer({
    above: false,
    class: "gt-selection-layer",
    markers(view) {
      return view.state.selection.ranges.flatMap((r) => (r.empty ? [] : markersFor(view, r)));
    },
    update(u) {
      return u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged;
    },
  }),
  EditorView.baseTheme({
    ".gt-selection-layer .gt-selection": { backgroundColor: "var(--markering)", borderRadius: "2px" },
  }),
];
