// »/«-menuen på skrivefladen (plan 2026-10-05, research 3.4). Menuen åbner kun, når »/« tastes et
// sted, hvor en kommando giver mening, og aldrig midt i et ord, et tal eller en webadresse. Den
// lukker på Esc, mellemrum og når det skrevne ikke passer på noget, og en afvist menu åbner ikke
// igen på samme skråstreg. »/« med tekst markeret og Ctrl+Shift+P (openCommandMenu) åbner samme menu
// uden at skrive noget i teksten, så markeringen bliver stående.
//
// Selve listen er CodeMirrors @codemirror/autocomplete med `filter: false`: rækkefølgen og søgningen
// er vores egen (rankCommands), fordi standarden kun matcher på etiketten og ikke kender aliaser
// eller »senest brugte først«. Om menuen er tændt, står i et felt (menuField), ikke hos autocomplete,
// så reglerne for åbning og lukning kan testes uden en editor.

import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
  startCompletion,
  type Completion,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { MapMode, Prec, StateEffect, StateField, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import { tr } from "../i18n.ts";
import { runCommand, tabStops } from "./run.ts";
import { allCommands, markUsed, recentNames } from "./store.ts";
import { SHORTCUT_KEYS, type Command, type CommandHooks, type Kind } from "./types.ts";

// --- hvornår »/« åbner menuen (ren) ------------------------------------------------------------------

/** Tegn, »/« må stå lige efter: en startparentes eller et åbnende citationstegn. Ellers kun blanktegn og linjestart. */
const OPENERS = new Set(["(", '"', "'", "»", "«", "“", "”", "„", "‘", "‚"]);

/**
 * Må et tastet »/« åbne menuen? `before` er linjen før skråstregen, `after` er resten af linjen.
 * Nej midt i et ord, efter et tal, et kolon eller en anden skråstreg (»og/eller«, »5/10«,
 * »https://«, »km/t«), foran et mellemrum eller et ord (»10 / 2«), og i kode, adresser og
 * fodnotedefinitioner.
 */
export function opensMenu(before: string, after = ""): boolean {
  const prev = before.slice(-1);
  if (prev !== "" && !/\s/.test(prev) && !OPENERS.has(prev)) return false;
  if (after !== "" && /^[\s\p{L}\p{N}/]/u.test(after)) return false;
  // Adressen i et link eller et billede: [tekst](/sti
  if (/\]\([^)]*$/.test(before)) return false;
  // En fodnotedefinition: [^1]: tekst
  if (/^\[\^[^\]\s]+\]:/.test(before)) return false;
  // Kode på linjen: et ulige antal backticks før markøren.
  if ((before.match(/`/g) ?? []).length % 2 === 1) return false;
  return true;
}

/** Står markøren i en note til mig selv eller en skjult blok, der ikke er lukket endnu? */
export function insideNote(textBefore: string): boolean {
  return textBefore.lastIndexOf("<!--") > textBefore.lastIndexOf("-->") || textBefore.lastIndexOf("{>>") > textBefore.lastIndexOf("<<}");
}

/** Det skrevne efter »/« er stadig et muligt navn: bogstaver, tal og bindestreg, højst 24 tegn. */
export function isQuery(text: string): boolean {
  return text.length <= 24 && /^[\p{L}\p{N}-]*$/u.test(text);
}

// --- søgning og rækkefølge (ren) -----------------------------------------------------------------------

/** Små bogstaver, og æ, ø og å som ae, oe og aa, så begge skrivemåder finder det samme. */
export function fold(text: string): string {
  return text.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa");
}

/** Står alle tegn i `q` i `n` i samme rækkefølge? */
function inOrder(q: string, n: string): boolean {
  let at = 0;
  for (const ch of q) {
    at = n.indexOf(ch, at) + 1;
    if (at === 0) return false;
  }
  return true;
}

/**
 * Hvor godt det skrevne passer på et navn. 5: præcis. 4: navnet begynder sådan. 3: et led efter en
 * bindestreg begynder sådan. 2: står midt i navnet. 1: uskarpt (samme forbogstav og tegnene i
 * rækkefølge), eller intet er skrevet. 0: intet træf.
 */
export function matchTier(query: string, name: string): number {
  const q = fold(query);
  const n = fold(name);
  if (!q) return 1;
  if (n === q) return 5;
  if (n.startsWith(q)) return 4;
  if (n.split("-").some((part) => part.startsWith(q))) return 3;
  if (n.includes(q)) return 2;
  return q.length >= 2 && n[0] === q[0] && inOrder(q, n) ? 1 : 0;
}

/** Navnet tæller lidt mere end et alias på samme trin. 0: kommandoen passer ikke. */
export function scoreCommand(query: string, command: Command): number {
  const alias = Math.max(0, ...command.aliases.map((a) => matchTier(query, a)));
  return Math.max(matchTier(query, command.name) * 2, alias * 2 - 1, 0);
}

export type Section = "recent" | "own" | Kind;
export type Row = { command: Command; section: Section };

const KIND_ORDER: Kind[] = ["template", "transform", "check", "ai"];
/** Med en markering står det, der virker på den, først. */
const KIND_ORDER_SELECTION: Kind[] = ["transform", "ai", "template", "check"];

/**
 * Menuens rækker. Uden søgning: senest brugte (højst tre), egne, og de indbyggede i grupperne
 * Skabeloner, Omform, Tjek og AI. Med en markering grupperes der kun efter slags, med omformninger
 * og AI først. Med søgning vinder det bedste træf, og rækkefølgen ovenfor afgør resten.
 */
export function rankCommands(commands: Command[], query: string, recent: string[], hasSelection: boolean): Row[] {
  const byName = new Map(commands.map((c) => [c.name, c]));
  const recents = recent.slice(0, 3).flatMap((n) => byName.get(n) ?? []);
  const isRecent = new Set(recents.map((c) => c.name));
  const others = commands.filter((c) => !isRecent.has(c.name));
  const own = others.filter((c) => c.source === "user");
  const builtin = others.filter((c) => c.source !== "user");
  let rows: Row[];
  if (hasSelection) {
    const all = [...recents, ...own, ...builtin];
    rows = KIND_ORDER_SELECTION.flatMap((kind) => all.filter((c) => c.kind === kind).map((command) => ({ command, section: kind })));
  } else {
    rows = [
      ...recents.map((command) => ({ command, section: "recent" as const })),
      ...own.map((command) => ({ command, section: "own" as const })),
      ...KIND_ORDER.flatMap((kind) => builtin.filter((c) => c.kind === kind).map((command) => ({ command, section: kind }))),
    ];
  }
  if (!query) return rows;
  return rows
    .map((row, i) => ({ row, i, score: scoreCommand(query, row.command) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.row);
}

// --- menuens tilstand ------------------------------------------------------------------------------------

/** `slash`: »/« står på `pos` i teksten. `palette`: åbnet med genvejen, det skrevne står kun her. */
export type MenuState = { mode: "slash"; pos: number } | { mode: "palette"; query: string } | null;

export const setMenu = StateEffect.define<MenuState>();

/** Syntaks, hvor »/« er tekst og ikke en kommando: kode, links, billedstier og HTML. */
const BLOCKED_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "CodeInfo",
  "InlineCode",
  "Link",
  "Image",
  "URL",
  "Autolink",
  "LinkReference",
  "LinkLabel",
  "LinkTitle",
  "HTMLBlock",
  "HTMLTag",
  "Comment",
  "CommentBlock",
  "ProcessingInstruction",
  "ProcessingInstructionBlock",
]);

/** Hvor langt tilbage der ledes efter en åben note. */
const NOTE_REACH = 4000;

function inBlockedSyntax(state: EditorState, pos: number): boolean {
  const tree = ensureSyntaxTree(state, pos + 1, 20) ?? syntaxTree(state);
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) {
    if (BLOCKED_NODES.has(n.name)) return true;
  }
  return false;
}

/** Det skrevne efter skråstregen på `pos`, eller null, når menuen ikke længere gælder. */
function queryAt(state: EditorState, pos: number): string | null {
  const sel = state.selection.main;
  if (!sel.empty || sel.head <= pos || sel.head - pos > 25 || state.sliceDoc(pos, pos + 1) !== "/") return null;
  const query = state.sliceDoc(pos + 1, sel.head);
  return isQuery(query) ? query : null;
}

/** Tændes menuen af denne transaktion? Kun ét tastet »/«, aldrig indsat, trukket eller fortrudt tekst. */
function armedBy(tr: Transaction): MenuState {
  let at = -1;
  let changes = 0;
  tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
    changes++;
    if (inserted.length === 1 && inserted.sliceString(0) === "/") at = fromB;
  });
  if (changes !== 1 || at < 0) return null;
  const { state } = tr;
  const sel = state.selection.main;
  if (!sel.empty || sel.head !== at + 1) return null;
  const line = state.doc.lineAt(at);
  if (!opensMenu(line.text.slice(0, at - line.from), line.text.slice(at + 1 - line.from))) return null;
  if (insideNote(state.sliceDoc(Math.max(0, at - NOTE_REACH), at)) || inBlockedSyntax(state, at)) return null;
  return { mode: "slash", pos: at };
}

/** Menuens tilstand efter en transaktion. */
export function nextMenu(value: MenuState, tr: Transaction): MenuState {
  for (const e of tr.effects) if (e.is(setMenu)) return e.value;
  // Genvejsmenuen lever kun, så længe hverken tekst eller markering ændres.
  if (value?.mode === "palette") return tr.docChanged || tr.selection ? null : value;
  if (!tr.docChanged) return value && tr.selection ? null : value;
  const typing = tr.isUserEvent("input.type");
  if (value && (typing || tr.isUserEvent("delete.backward"))) {
    // Der skrives videre på navnet. Slettes »/«, eller kommer der et mellemrum, er det slut.
    const pos = tr.changes.mapPos(value.pos, 1, MapMode.TrackAfter);
    if (pos !== null && queryAt(tr.state, pos) !== null) return { mode: "slash", pos };
    return null;
  }
  return typing ? armedBy(tr) : null;
}

export const menuField = StateField.define<MenuState>({
  create: () => null,
  update: nextMenu,
});

// --- listen ----------------------------------------------------------------------------------------------

const sectionName = (s: Section): string => {
  switch (s) {
    case "recent":
      return tr("Senest brugte", "Recently used");
    case "own":
      return tr("Egne", "Your own");
    case "template":
      return tr("Skabeloner", "Templates");
    case "transform":
      return tr("Omform", "Transform");
    case "check":
      return tr("Tjek", "Check");
    case "ai":
      return "AI";
  }
};

/** Det lille mærke for slagsen i højre side af rækken. */
export const kindMark = (kind: Kind): string => {
  switch (kind) {
    case "template":
      return tr("skabelon", "template");
    case "transform":
      return tr("omform", "transform");
    case "check":
      return tr("tjek", "check");
    case "ai":
      return "AI";
  }
};

type CommandCompletion = Completion & { command: Command };

/** Rækkerne for det, der er skrevet lige nu, eller null, når menuen skal være lukket. */
function resultFor(state: EditorState, hooks: CommandHooks): CompletionResult | null {
  const menu = state.field(menuField, false);
  if (!menu) return null;
  const sel = state.selection.main;
  const query = menu.mode === "slash" ? queryAt(state, menu.pos) : menu.query;
  if (query === null) return null;
  const rows = rankCommands(allCommands(), query, recentNames(), menu.mode === "palette" && !sel.empty);
  // Passer det skrevne ikke på noget, er det almindelig tekst.
  if (!rows.length) return null;
  const sections = new Map<string, { name: string; rank: number }>();
  const sectionFor = (row: Row) => {
    // Under søgning er der ingen grupper. I genvejsmenuen står det skrevne som overskrift i stedet.
    const name = query ? (menu.mode === "palette" ? `/${query}` : null) : sectionName(row.section);
    if (name === null) return undefined;
    if (!sections.has(name)) sections.set(name, { name, rank: sections.size });
    return sections.get(name);
  };
  const options: CommandCompletion[] = rows.map((row) => ({
    label: row.command.name,
    displayLabel: `/${row.command.name}`,
    detail: row.command.description,
    section: sectionFor(row),
    command: row.command,
    apply: (view: EditorView) => pick(view, row.command, hooks),
  }));
  return {
    from: menu.mode === "slash" ? menu.pos : sel.from,
    to: menu.mode === "slash" ? sel.head : sel.from,
    options,
    filter: false,
    // Mens der skrives videre, regnes listen om med det samme i stedet for at spørge kilden igen.
    update: (_current, _from, _to, context) => resultFor(context.state, hooks),
  };
}

/** Enter, Tab eller klik på en række: luk menuen og kør kommandoen. */
function pick(view: EditorView, command: Command, hooks: CommandHooks): void {
  const menu = view.state.field(menuField, false);
  const replace = menu?.mode === "slash" ? { from: menu.pos, to: view.state.selection.main.head } : undefined;
  view.dispatch({ effects: setMenu.of(null) });
  closeCompletion(view);
  if (runCommand(view, command, hooks, replace)) markUsed(command.name);
}

/** Esc: luk menuen. »/« og det skrevne bliver stående som tekst, og menuen åbner ikke igen dér. */
function dismiss(view: EditorView): boolean {
  const armed = !!view.state.field(menuField, false);
  if (!armed && completionStatus(view.state) !== "active") return false;
  if (armed) view.dispatch({ effects: setMenu.of(null) });
  closeCompletion(view);
  return true;
}

/** Genvejsmenuen: det skrevne ændres her og ikke i teksten, så markeringen bliver stående. */
function setPaletteQuery(view: EditorView, query: string): void {
  view.dispatch({ effects: setMenu.of({ mode: "palette", query }) });
  startCompletion(view);
}

/**
 * »/« med tekst markeret åbner menuen og lader markeringen stå (6/10: omformningerne virkede
 * ikke, fordi skråstregen erstattede det markerede, før menuen kom). Ikke i kode og links, og ikke
 * med flere markeringer, hvor »/« er almindelig tekst.
 */
function slashOnSelection(view: EditorView, text: string): boolean {
  const { selection } = view.state;
  if (text !== "/" || selection.ranges.length !== 1 || selection.main.empty) return false;
  if (inBlockedSyntax(view.state, selection.main.from)) return false;
  setPaletteQuery(view, "");
  return true;
}

/** I genvejsmenuen havner tastet tekst i søgningen. Et tegn, der ikke passer på noget, tæller ikke. */
const paletteTyping = EditorView.inputHandler.of((view, _from, _to, text) => {
  const menu = view.state.field(menuField, false);
  if (menu?.mode !== "palette") return slashOnSelection(view, text);
  if (/\s/.test(text)) return dismiss(view);
  const query = menu.query + text;
  const sel = view.state.selection.main;
  if (isQuery(query) && rankCommands(allCommands(), query, recentNames(), !sel.empty).length) setPaletteQuery(view, query);
  return true;
});

function paletteBackspace(view: EditorView): boolean {
  const menu = view.state.field(menuField, false);
  if (menu?.mode !== "palette") return false;
  if (!menu.query) return dismiss(view);
  setPaletteQuery(view, menu.query.slice(0, -1));
  return true;
}

/**
 * Holder listen og feltet i takt. Passer det skrevne ikke længere på nogen kommando, slukkes feltet,
 * så det skrevne er almindelig tekst, og menuen ikke kommer igen på samme skråstreg. Og er feltet
 * slukket af noget andet end et valg (mellemrum, markøren flyttet, »/« slettet), lukkes listen straks.
 */
const keepInStep = EditorView.updateListener.of((u) => {
  const menu = u.state.field(menuField, false);
  if (menu?.mode === "slash" && u.docChanged) {
    const query = queryAt(u.state, menu.pos);
    if (query === null || !rankCommands(allCommands(), query, recentNames(), false).length) {
      u.view.dispatch({ effects: setMenu.of(null) });
      return;
    }
  }
  if (u.startState.field(menuField, false) && !menu && completionStatus(u.state) !== null) closeCompletion(u.view);
});

const inPalette = (view: EditorView): boolean => view.state.field(menuField, false)?.mode === "palette";

/** Pilene vælger i listen. I genvejsmenuen flytter de aldrig markøren, heller ikke mens listen regnes om. */
const move = (forward: boolean, by: "option" | "page" = "option") => {
  const run = moveCompletionSelection(forward, by);
  return (view: EditorView): boolean => run(view) || inPalette(view);
};

/**
 * Enter og Tab kører den valgte række. I genvejsmenuen må tasten aldrig nå teksten (den ville
 * erstatte markeringen): er listen ved at blive regnet om, køres det bedste træf.
 */
function accept(hooks: CommandHooks): (view: EditorView) => boolean {
  return (view) => {
    if (acceptCompletion(view)) return true;
    const menu = view.state.field(menuField, false);
    if (menu?.mode !== "palette") return false;
    const top = rankCommands(allCommands(), menu.query, recentNames(), !view.state.selection.main.empty)[0];
    if (top) pick(view, top.command, hooks);
    return true;
  };
}

/** Slagsen og en eventuel genvejstast i højre side af rækken. */
function renderKind(completion: Completion): HTMLElement {
  const { command } = completion as CommandCompletion;
  const el = document.createElement("span");
  el.className = "gt-cmd-kind";
  el.textContent = command.shortcut ? `${kindMark(command.kind)} · ${command.shortcut}` : kindMark(command.kind);
  return el;
}

/** Højden på en række. Otte rækker er synlige, resten rulles. */
const ROW = 30;
const MENU = ".cm-tooltip.cm-tooltip-autocomplete.gt-cmd-menu";

const menuTheme = EditorView.baseTheme({
  [MENU]: {
    background: "var(--kort)",
    border: "1px solid var(--kant)",
    borderRadius: "8px",
    boxShadow: "var(--skygge, 0 8px 24px rgba(0,0,0,0.12))",
    overflow: "hidden",
    fontFamily: 'var(--ui, "Segoe UI", system-ui, sans-serif)',
    fontSize: "13px",
    letterSpacing: "0",
  },
  [`${MENU} > ul`]: {
    maxHeight: `${8 * ROW}px`,
    minWidth: "300px",
    maxWidth: "min(480px, 90vw)",
    fontFamily: "inherit",
  },
  [`${MENU} > ul > li`]: {
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
    padding: "5px 12px",
    lineHeight: "20px",
    color: "var(--blæk)",
    cursor: "default",
  },
  [`${MENU} > ul > li[aria-selected]`]: { background: "var(--valgt)", color: "var(--blæk)", boxShadow: "inset 3px 0 0 var(--accent)" },
  [`${MENU} > ul > completion-section`]: {
    display: "block",
    padding: "7px 12px 2px",
    lineHeight: "16px",
    fontSize: "11px",
    fontFamily: "var(--ui-lille)",
    color: "var(--svag)",
    borderBottom: "none",
    opacity: "1",
  },
  [`${MENU} .cm-completionLabel`]: { flex: "none", fontWeight: "600" },
  [`${MENU} .cm-completionDetail`]: {
    flex: "1",
    minWidth: "0",
    marginLeft: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontStyle: "normal",
    color: "var(--svag)",
  },
  [`${MENU} .gt-cmd-kind`]: { flex: "none", fontSize: "11px", fontFamily: "var(--ui-lille)", color: "var(--dæmpet)" },
});

/** F5, F6, F8 og F9 kører den kommando, der har tasten som `shortcut`. Uden en kommando slipper tasten igennem. */
function shortcutKeys(hooks: CommandHooks): Extension {
  return keymap.of(
    SHORTCUT_KEYS.map((key) => ({
      key,
      run: (view: EditorView) => {
        const command = allCommands().find((c) => c.shortcut === key);
        if (!command) return false;
        dismiss(view);
        if (runCommand(view, command, hooks)) markUsed(command.name);
        return true;
      },
    })),
  );
}

/**
 * »/«-menuen, markørstoppene og genvejstasterne samlet. Tasterne i menuen (pil op og ned, Enter,
 * Tab, Esc) ligger på Prec.highest og slipper igennem, når menuen er lukket. Autocompletes egne
 * genveje (Ctrl+Mellemrum med flere) er slået fra.
 */
export function slashCommands(hooks: CommandHooks): Extension {
  return [
    menuField,
    autocompletion({
      override: [(context) => resultFor(context.state, hooks)],
      activateOnTyping: true,
      activateOnTypingDelay: 0,
      defaultKeymap: false,
      icons: false,
      maxRenderedOptions: 80,
      tooltipClass: () => "gt-cmd-menu",
      addToOptions: [{ render: renderKind, position: 90 }],
    }),
    Prec.highest(
      keymap.of([
        { key: "ArrowDown", run: move(true) },
        { key: "ArrowUp", run: move(false) },
        { key: "PageDown", run: move(true, "page") },
        { key: "PageUp", run: move(false, "page") },
        { key: "Enter", run: accept(hooks) },
        { key: "Tab", run: accept(hooks) },
        { key: "Escape", run: dismiss },
        { key: "Backspace", run: paletteBackspace },
      ]),
    ),
    Prec.highest(paletteTyping),
    keepInStep,
    menuTheme,
    // Efter menuens taster: Tab vælger i menuen, før den går til næste markørstop.
    tabStops(),
    shortcutKeys(hooks),
  ];
}

/** Åbn menuen uden at skrive noget (Ctrl+Shift+P). Markeringen bliver stående, og med en markering står omformninger og AI først. */
export function openCommandMenu(view: EditorView): void {
  if (view.state.field(menuField, false) === undefined) return;
  view.focus();
  setPaletteQuery(view, "");
}
