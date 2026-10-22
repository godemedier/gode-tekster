// Billeder ind i teksten (2/10): Ctrl+Alt+I eller »Indsæt billede …« åbner Windows' vælger,
// et billede kan trækkes ind fra Stifinder, og et skærmbillede kan sættes ind med Ctrl+V. Rust
// kopierer det til `medier` ved siden af teksten (media.rs), og her sættes `![](medier/…)` ind
// på sin egen linje, med markøren i billedteksten.

import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";

import { currentDocPath } from "./images.ts";
import { errorText, showBanner } from "../ui/banner.ts";
import { tr } from "../i18n.ts";

/** Hvor billedet skal stå: på en tom linje, ellers som eget afsnit efter linjen. */
export function imageInsert(doc: string, pos: number, rel: string): { from: number; insert: string; cursor: number } {
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  const end = doc.indexOf("\n", pos);
  const lineEnd = end === -1 ? doc.length : end;
  const md = `![](${rel})`;
  if (doc.slice(lineStart, lineEnd).trim() === "") return { from: lineStart, insert: md, cursor: lineStart + 2 };
  return { from: lineEnd, insert: `\n\n${md}`, cursor: lineEnd + 4 };
}

function put(view: EditorView, pos: number, rel: string): void {
  const plan = imageInsert(view.state.doc.toString(), pos, rel);
  view.dispatch({
    changes: { from: plan.from, insert: plan.insert },
    selection: { anchor: plan.cursor },
    userEvent: "input.image",
    scrollIntoView: true,
  });
  view.focus();
}

/** Ctrl+Alt+I: vælg et billede. */
export function pickImage(view: EditorView): boolean {
  const doc = currentDocPath();
  if (!doc) return false;
  const pos = view.state.selection.main.head;
  invoke<string | null>("pick_image", { doc })
    .then((rel) => rel && put(view, pos, rel))
    .catch((e) => showBanner(errorText(e)));
  return true;
}

async function saveFile(view: EditorView, file: File, pos: number, name = file.name): Promise<void> {
  const doc = currentDocPath();
  if (!doc) return;
  try {
    const rel = await invoke<string>("save_image", new Uint8Array(await file.arrayBuffer()), {
      headers: { "x-doc": encodeURIComponent(doc), "x-name": encodeURIComponent(name) },
    });
    put(view, pos, rel);
  } catch (e) {
    showBanner(errorText(e));
  }
}

/** Endelserne, Rust tager imod (media.rs). Windows giver ofte HEIC og TIFF en tom MIME-type. */
const IMAGE_EXT = /.(png|jpe?g|gif|webp|svg|avif|bmp|heic|heif|tiff?)$/i;

export const isImage = (f: { name: string; type: string }) => f.type.startsWith("image/") || IMAGE_EXT.test(f.name);

const images = (list: FileList | undefined | null) => [...(list ?? [])].filter(isImage);

export const imageDropAndPaste = EditorView.domEventHandlers({
  drop(event, view) {
    const files = images(event.dataTransfer?.files);
    if (!files.length) return false;
    event.preventDefault();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    void (async () => {
      for (const f of files) await saveFile(view, f, pos);
    })();
    return true;
  },
  paste(event, view) {
    const files = images(event.clipboardData?.files);
    if (!files.length) return false;
    event.preventDefault();
    // Et skærmbillede hedder »image.png« i udklipsholderen; det siger ingenting i mappen.
    const name = (f: File) => (/^image\.\w+$/i.test(f.name) ? `${tr("skærmbillede", "screenshot")}.${f.name.split(".").pop()}` : f.name);
    void (async () => {
      for (const f of files) await saveFile(view, f, view.state.selection.main.head, name(f));
    })();
    return true;
  },
});
