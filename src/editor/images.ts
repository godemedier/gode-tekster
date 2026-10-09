// Billeder i teksten (TODO-teknisk, »Billeder i fladen og i print«): en linje med kun
// `![alt](sti)` får billedet vist under sig. Stien er relativ til tekstens mappe, som i iA. Filen
// hentes gennem Tauris asset-protokol, som Rust kun har åbnet for bibliotekerne og mappen med den
// åbne fil. Billeder fra nettet vises ikke: CSP'en tillader kun programmets egne kilder.

import { StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";

import { touchesMarkers } from "./touches.ts";
import { tr } from "../i18n.ts";

const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)\s*$/;

let baseDir = "";
let docPath: string | null = null;

/** Sættes, når en tekst åbnes. Relative billedstier slås op herfra. */
export function setImageBase(path: string): void {
  docPath = path;
  baseDir = path.slice(0, path.lastIndexOf("\\"));
}

/** Den åbne tekst (insertImage.ts lægger billeder i `medier` ved siden af den). */
export function currentDocPath(): string | null {
  return docPath;
}

/** Den lokale sti til et billede, eller null, hvis det ligger på nettet. */
export function resolveImage(src: string, base = baseDir): string | null {
  let s: string;
  try {
    s = decodeURI(src.trim());
  } catch {
    s = src.trim();
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^data:/i.test(s)) return null;
  let p = s.replace(/\//g, "\\");
  if (!/^[a-zA-Z]:\\/.test(p)) p = `${base}\\${p}`;
  const parts: string[] = [];
  for (const seg of p.split("\\")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("\\");
}

/** URL'en, WebView2 kan vise billedet fra. */
export function imageUrl(src: string): string | null {
  const path = resolveImage(src);
  return path ? convertFileSrc(path) : null;
}

class ImageWidget extends WidgetType {
  url: string;
  alt: string;
  constructor(url: string, alt: string) {
    super();
    this.url = url;
    this.alt = alt;
  }
  eq(other: ImageWidget): boolean {
    return other.url === this.url && other.alt === this.alt;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("div");
    box.className = "gt-img";
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    // Klik på billedet: markøren på billedlinjen, så koden kommer frem og kan rettes.
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      view.dispatch({ selection: { anchor: view.state.doc.lineAt(pos).to } });
      view.focus();
    });
    img.addEventListener("error", () => {
      // HEIC og TIFF findes måske fint, men WebView2 kan ikke vise dem. Indsat med Ctrl+Alt+I bliver de JPEG.
      const alt = this.alt ? `: ${this.alt}` : "";
      box.textContent = /\.(heic|heif|tiff?)$/i.test(this.url)
        ? tr(
            `Billedet er HEIC eller TIFF og kan ikke vises. Sæt det ind med Ctrl+Alt+I, så bliver det en JPEG${alt}`,
            `The image is HEIC or TIFF and can't be shown. Insert it with Ctrl+Alt+I to turn it into a JPEG${alt}`,
          )
        : tr(`Billedet blev ikke fundet${alt}`, `Image not found${alt}`);
      box.classList.add("gt-img-missing");
    });
    box.append(img);
    return box;
  }
}

/** Billedlinjen med markøren, eller -1. Kun den viser koden. */
function activeImageLine(state: EditorState): number {
  const line = state.doc.lineAt(state.selection.main.head);
  return line.text.includes("![") && IMAGE_LINE.test(line.text) ? line.from : -1;
}

/**
 * Som overskrifterne (2/10): koden `![…](…)` ses kun, når markøren står på billedlinjen.
 * Ellers står billedet i linjens sted. Med markøren på linjen står koden over billedet.
 */
function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  const active = activeImageLine(state);
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (!line.text.includes("![")) continue;
    const m = IMAGE_LINE.exec(line.text);
    const url = m ? imageUrl(m[2]) : null;
    if (!m || !url) continue;
    const widget = new ImageWidget(url, m[1]);
    out.push(
      line.from === active
        ? Decoration.widget({ widget, block: true, side: 1 }).range(line.to)
        : Decoration.replace({ widget, block: true }).range(line.from, line.to),
    );
  }
  return Decoration.set(out);
}

// Blokke skal komme fra et StateField, ikke et ViewPlugin (CodeMirrors regel). Der bygges kun om,
// når et billedmærke røres, eller markøren går ind på eller ud af en billedlinje.
export const images = StateField.define<{ deco: DecorationSet; active: number }>({
  create: (state) => ({ deco: build(state), active: activeImageLine(state) }),
  update: (value, tr) => {
    const active = activeImageLine(tr.state);
    if (active !== value.active || (tr.docChanged && touchesMarkers(tr, ["!["]))) return { deco: build(tr.state), active };
    return tr.docChanged ? { deco: value.deco.map(tr.changes), active } : value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export const imagesTheme = EditorView.theme({
  // Billeder må gå ud over spalten (9/10, --udfald i setup.ts) og står midt i den.
  ".gt-img": { padding: "0.4em 0 1em", marginInline: "calc(-1 * var(--udfald, 0px))" },
  ".gt-img img": { display: "block", maxWidth: "100%", maxHeight: "60vh", margin: "0 auto", borderRadius: "4px" },
  ".gt-img-missing": { fontFamily: "var(--ui)", fontSize: "13px", color: "var(--svag)" },
});
