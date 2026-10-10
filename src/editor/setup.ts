// Skrivefladen: samler alle editor-udvidelser (live preview, forfatterskab, fraklip, billeder,
// tilstande, ordklasser, Claudes forslag) og laver en EditorState for en tekst.

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, drawSelection, dropCursor, keymap, tooltips } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

import { authorshipField, authorshipHistory, setAuthorship, type AuthorshipState } from "./authorship.ts";
import { livePreview, livePreviewTheme } from "./livePreview.ts";
import { pasteTables, tablePreview, tableTheme } from "./tables.ts";
import { wordSelection } from "./wordSelection.ts";
import { findExtension } from "./find.ts";
import { shortcuts } from "./shortcuts.ts";
import { hiddenBlocks } from "./hidden.ts";
import { tagLineStyle, tagLineTheme } from "./textStatus.ts";
import { selectionToolbar, selectionToolbarTheme } from "./selectionToolbar.ts";
import { parkedDrop } from "./parkedDrop.ts";
import { authorshipView, authorshipTheme } from "./authorshipView.ts";
import { modeExtensions } from "./modes.ts";
import { wordClasses, wordClassTheme } from "./wordclasses.ts";
import { dimBubble } from "./dimBubble.ts";
import { images, imagesTheme } from "./images.ts";
import { imageDropAndPaste } from "./insertImage.ts";
import { revisions, revisionsTheme } from "./revisionsView.ts";
import { outline } from "./outline.ts";
import { styleCheck, styleCheckTheme } from "./styleCheck.ts";
import { linkClicks } from "./links.ts";
import { trimLineBreakSelection } from "./selection.ts";
import { selectionDrag } from "./selectionDrag.ts";
import { fancyListBlocks, fancyListSupport, headingNumberInput } from "./lists.ts";
import { paragraphStyle } from "./paragraphs.ts";
import { slashCommands } from "../commands/slashMenu.ts";
import type { CommandHooks } from "../commands/types.ts";

/**
 * CodeMirror-genveje, der rammer forkert på et dansk tastatur (tastaturgennemgang 5/10). Shift+7 er
 * »/«, så Ctrl+Shift+7 (nummereret liste) blev til Mod-/ (kommentar, nu en skjult note). AltGr+< er
 * Ctrl+Alt+»\«, så Mod-Alt-\ (indryk markering) slugte backslash.
 */
const DANISH_CLASHES = new Set(["Mod-/", "Mod-Alt-\\"]);

const iaHighlight = HighlightStyle.define([
  // Overskrifter i større grader (2/10). #### er manchet i mange artikler, så den er en
  // større indledning frem for en overskrift.
  // Graderne ligger på linjeklasserne i livePreview.ts (gt-h1 … gt-h6), så linjen har samme højde,
  // hvad enten tegnene vises eller ej.
  { tag: [t.heading1, t.heading2, t.heading3, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.heading4, fontWeight: "400" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.processingInstruction, color: "var(--dæmpet)" },
  { tag: t.url, color: "var(--svag)" },
  { tag: t.link, textDecoration: "underline", textDecorationColor: "var(--pynt)" },
  { tag: t.monospace, color: "var(--kode-tekst)" },
  { tag: t.comment, color: "var(--dæmpet)" },
]);

const iaTheme = EditorView.theme({
  // Ctrl+plus og Ctrl+minus ganger størrelsen med --zoom (main.ts, WCAG 1.4.4, testprotokollen 2/10).
  "&": { fontSize: "calc(clamp(15px, 0.45vw + 10px, 19px) * var(--zoom, 1))" },
  ".cm-scroller": {
    fontFamily: 'var(--skrift, "Recursive Halvmono"), "Segoe UI Emoji", "Segoe UI Symbol", ui-monospace, monospace',
    // Lys tekst på mørk bund ser federe ud: mørk og aften skriver lidt lettere (ADR-0037).
    fontWeight: "var(--skrift-vægt, 400)",
    lineHeight: "1.85",
    letterSpacing: "0.01em",
    // Tabeller og billeder må gå ud over spalten (9/10): de regner pladsen ud fra rulleområdets bredde.
    containerType: "inline-size",
  },
  ".cm-content": {
    // Bredden måles i den valgte skrift (ui/lineWidth.ts), så 72 tegn er 72 tegn i alle skrifter.
    // Feltet regner bredden med sin egen polstring (border-box), så de 2 × 24 px lægges oveni
    // (8/10: målt 59 tegn i stedet for 72).
    boxSizing: "border-box",
    maxWidth: "calc(var(--linjelaengde, 72ch) + 48px)",
    margin: "0 auto",
    padding: "72px 24px 45vh",
    caretColor: "var(--accent)",
    // Udfaldet: den tomme plads ved siden af spalten (plus polstringen), minus 16 px luft, højst 10 em.
    "--udfald": "clamp(0px, (100cqw - min(100cqw, var(--linjelaengde, 72ch) + 48px)) / 2 + 8px, 10em)",
  },
  ".cm-line": { padding: "0" },
  // CodeMirrors egen animation helt væk; timeren nedenfor blinker.
  // Blødt blink (ADR-0037): markøren toner ud og ind i stedet for at klikke af og på.
  "& .cm-cursorLayer": { animation: "none !important", transition: "opacity 260ms ease" },
  "&.gt-caret-off .cm-cursorLayer": { opacity: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "3px solid var(--accent)", borderRadius: "1px" },
  // Markeringen tegnes af wordSelection.ts, så den følger ordene. CodeMirrors egen er usynlig.
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "transparent !important",
  },
  "::selection": {
    backgroundColor: "var(--markering) !important",
  },
});

/**
 * Markørens blink med en timer i stedet for CodeMirrors CSS-animation, og kun de første 8 sekunder
 * efter et tastetryk eller klik. Derefter står markøren stille og synlig. Hvert blink får WebView2 til
 * at tegne og sammensætte hele vinduet: i ro kostede blinket 1,3-2,7 % af en processorkerne, mens
 * brugeren læser eller tænker (målt 2/10). Uden fokus blinker den slet ikke.
 */
const BLINK_MS = 550;
const BLINK_FOR_MS = 8000;
const blinkingCursor = ViewPlugin.fromClass(
  class {
    timer: number | undefined;
    stop: number | undefined;
    view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      this.restart();
    }
    update(u: { docChanged: boolean; selectionSet: boolean; focusChanged: boolean }) {
      if (u.docChanged || u.selectionSet || u.focusChanged) this.restart();
    }
    restart() {
      this.view.dom.classList.remove("gt-caret-off");
      window.clearInterval(this.timer);
      window.clearTimeout(this.stop);
      if (!this.view.hasFocus) return;
      this.timer = window.setInterval(() => this.view.dom.classList.toggle("gt-caret-off"), BLINK_MS);
      this.stop = window.setTimeout(() => {
        window.clearInterval(this.timer);
        this.view.dom.classList.remove("gt-caret-off");
      }, BLINK_FOR_MS);
    }
    destroy() {
      window.clearInterval(this.timer);
      window.clearTimeout(this.stop);
    }
  },
);

export type OnChange = () => void;

/** Én lytter på markeringen (ordtallet i hjørnet tæller kun det markerede). */
let selectionHook: () => void = () => {};
export function onSelectionChange(hook: () => void): void {
  selectionHook = hook;
}

/** Det, kommandoerne har brug for fra resten af programmet (main.ts sætter dem før første tekst). */
let commandHooks: CommandHooks | null = null;
export function setCommandHooks(hooks: CommandHooks): void {
  commandHooks = hooks;
}
/** Til testscenarierne (measure.ts). */
export const getCommandHooks = (): CommandHooks | null => commandHooks;

export function baseExtensions(onChange: OnChange): Extension[] {
  return [
    history(),
    drawSelection({ cursorBlinkRate: 0 }),
    wordSelection,
    selectionDrag,
    blinkingCursor,
    dropCursor(),
    shortcuts(),
    findExtension(),
    keymap.of([...defaultKeymap.filter((b) => !DANISH_CLASHES.has(b.key ?? "")), ...historyKeymap]),
    markdown({ base: markdownLanguage, extensions: [fancyListBlocks] }),
    syntaxHighlighting(iaHighlight),
    EditorView.lineWrapping,
    // Stavekontrollens understregning følger sproget (sættes på <html> i main.ts).
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "off" }),
    iaTheme,
    livePreview,
    livePreviewTheme,
    tablePreview,
    tableTheme,
    pasteTables,
    hiddenBlocks,
    tagLineStyle,
    tagLineTheme,
    selectionToolbar,
    selectionToolbarTheme,
    // Bobler og værktøjslinjen holdes inden for skrivefladen (9/10): CodeMirror regner ellers med hele
    // vinduet, og linjen ved en markering havnede under et fastgjort sidepanel.
    tooltips({ tooltipSpace: (view) => view.scrollDOM.getBoundingClientRect() }),
    parkedDrop,
    authorshipView,
    authorshipTheme,
    modeExtensions(),
    wordClasses,
    wordClassTheme,
    dimBubble,
    images,
    imagesTheme,
    imageDropAndPaste,
    revisions,
    revisionsTheme,
    outline,
    styleCheck,
    styleCheckTheme,
    // Ctrl+Alt+V (indsæt som AI) er taget ud med »Markér som AI« (4/10).
    linkClicks(),
    trimLineBreakSelection,
    fancyListSupport,
    // Egne kommandoer og skabeloner med »/« (commands/slashMenu.ts).
    ...(commandHooks ? [slashCommands(commandHooks)] : []),
    headingNumberInput,
    paragraphStyle(),
    authorshipField,
    authorshipHistory,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange();
      else if (u.selectionSet) selectionHook();
    }),
  ];
}

export function createState(text: string, authorship: AuthorshipState, cursor: number | null, onChange: OnChange): EditorState {
  const anchor = cursor === null ? 0 : Math.min(cursor, text.length);
  const state = EditorState.create({
    doc: text,
    selection: { anchor },
    extensions: baseExtensions(onChange),
  });
  return state.update({ effects: setAuthorship.of(authorship) }).state;
}
