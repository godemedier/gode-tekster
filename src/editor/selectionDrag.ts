// Browseren kan begynde teksttrækket efter CodeMirrors første mousemove. Hold derfor
// den oprindelige markering, indtil dragstart har overtaget. Ellers flyttes kun de
// bogstaver, som den første bevægelse nåede at markere på ny.
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export const selectionDrag = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.detail !== 1 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return null;
  let selection = view.state.selection;
  const hit = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (hit === null || selection.main.empty || hit <= selection.main.from || hit >= selection.main.to) return null;
  let position = hit;
  return {
    get(move) {
      // Et klik uden træk skal stadig placere markøren i teksten.
      return move.type === "mousedown" ? EditorSelection.single(position) : selection;
    },
    update(update) {
      selection = selection.map(update.changes);
      position = update.changes.mapPos(position);
      return false;
    },
  };
});
