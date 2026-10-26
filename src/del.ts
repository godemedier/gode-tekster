// Gæstens side til en delt tekst (ADR-0060). Siden ligger på synkserveren under /del/<link> og taler
// kun med /v1/gaest/<link> på samme adresse. Gæsten ser delen i den samme skriveflade som i
// programmet, uden markdown-tegn. Alt, gæsten skriver og sletter, bliver forslag, og kommentarer
// bliver noter. Gemmes af sig selv 1,5 s efter sidste tastetryk, med compare-and-swap.
// Rettelserne vises roligt som en streg i margenen, til gæsten trykker »Vis rettelser«.

import { StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";

import { createState, useGuestSurface, useTouchSurface } from "./editor/setup.ts";
import { setMarkMode } from "./editor/livePreview.ts";
import { setNoteDisplay, setShowRevisions } from "./editor/revisionsView.ts";
import { addComment, editComment, setSuggesting } from "./editor/suggest.ts";
import { findNotes, findRevisions } from "./editor/critic.ts";
import { guestSelectionToolbar } from "./editor/selectionToolbar.ts";
import { ICON } from "./ui/icons.ts";
import { showBanner } from "./ui/banner.ts";
import { tr } from "./i18n.ts";

type GuestCopy = { title: string; name: string; text: string; rev: number; expires: number; from?: string };

const SAVE_MS = 1500;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const token = location.pathname.split("/").filter(Boolean).pop() ?? "";
const api = `/v1/gaest/${encodeURIComponent(token)}`;
const draftKey = `gt-del-${token.slice(0, 16)}`;

/**
 * Linket virker ikke længere: serverens eget svar (JSON). En 404 fra proxyen, mens serveren genstartes,
 * er tekst og betyder ikke, at delingen er stoppet (evaluering 20/10).
 */
const linkGone = (r: Response) => r.status === 404 && (r.headers.get("content-type") ?? "").includes("json");
const showKey = "gt-del-vis-rettelser";
const introKey = `gt-del-hilsen-${token.slice(0, 16)}`;

const touch = matchMedia("(pointer: coarse)").matches;
if (touch) useTouchSurface();
useGuestSurface();
// Mørkt tema efter systemet, som programmet selv kan (21/10). Før var siden altid lys.
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
const followDark = () => document.body.classList.toggle("dark", darkScheme.matches);
followDark();
darkScheme.addEventListener("change", followDark);
// Sans som på telefonen: en læser skal ikke se programmets halvmono (ADR-0055).
document.documentElement.style.setProperty("--skrift", '"Schibsted Grotesk"');
const view = new EditorView({ parent: $("editor") });

let rev = 0;
let saved = "";
let timer: number | undefined;
let saving: Promise<void> | null = null;
/** Linket virker ikke længere: intet gemmes, men teksten bliver stående, så den kan kopieres. */
let dead = false;
let showAll = readShowAll();

function readShowAll(): boolean {
  try {
    return localStorage.getItem(showKey) === "1";
  } catch {
    return false;
  }
}

function setShowAll(on: boolean): void {
  showAll = on;
  try {
    localStorage.setItem(showKey, on ? "1" : "0");
  } catch {
    // Valget huskes bare ikke til næste gang.
  }
  const button = $("g-vis");
  button.textContent = on ? tr("Skjul rettelser", "Hide changes") : tr("Vis rettelser", "Show changes");
  button.setAttribute("aria-pressed", String(on));
  view.dispatch({ effects: setShowRevisions.of(on) });
}

// --- Kommentarer -------------------------------------------------------------------------------
// På en bred skærm står hilsenen, kommentarerne og kommentarfeltet som kort i margenen til højre, ud
// for det sted i teksten, de hører til, og teksten viser kun et lille tal (21/10). Smallere står
// kommentaren som en mærkat i teksten. Markdown-tegnene kommer aldrig frem.

const wide = matchMedia("(min-width: 1100px) and (pointer: fine)");
/** Hvor kommentarfeltet står i margenen, og hvilken kommentar der rettes (`null`: en ny). */
let formAt: number | null = null;
let editing: number | null = null;

const noteDisplay = () => setNoteDisplay.of(wide.matches ? "number" : "label");

function showForm(note: number | null, text: string, at: number): void {
  editing = note;
  formAt = at;
  $("g-form-label").textContent = note === null ? tr("Din kommentar", "Your comment") : tr("Ret kommentar", "Edit comment");
  $("g-tilfoej").textContent = note === null ? tr("Tilføj kommentar", "Add comment") : tr("Gem", "Save");
  $("g-slet").hidden = note === null;
  $("g-form").hidden = false;
  const field = $("g-tekst") as HTMLTextAreaElement;
  field.value = text;
  field.focus();
  arrange();
}

function openComment(): void {
  if (dead) return;
  // Markeringen lægges sammen ved dens slutning: der sættes kommentaren alligevel, og værktøjslinjen
  // blev ellers hængende over feltet (designgennemgang 21/10).
  const sel = view.state.selection.main;
  if (!sel.empty) view.dispatch({ selection: { anchor: sel.to } });
  showForm(null, "", sel.to);
}

/** Ret kommentaren ved `at`: fra kortet i margenen eller et klik på den i teksten. */
function openEdit(at: number): void {
  if (dead) return;
  const n = findNotes(view.state.doc.toString()).find((x) => at >= x.from - 1 && at <= x.to);
  if (n) showForm(n.from, n.text, n.from);
}

function closeComment(): void {
  $("g-form").hidden = true;
  editing = formAt = null;
  arrange();
  view.focus();
}

function deleteComment(at: number): void {
  if (dead) return;
  editComment(view, at, "");
  view.focus();
}

function smallButton(label: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", run);
  return b;
}

function noteCard(from: number, text: string, nr: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "g-note";
  const num = document.createElement("span");
  num.className = "g-note-nr";
  num.textContent = String(nr);
  const body = document.createElement("p");
  body.textContent = text;
  card.append(num, body);
  if (!dead) {
    const actions = document.createElement("div");
    actions.className = "g-note-knapper";
    actions.append(smallButton(tr("Ret", "Edit"), () => openEdit(from)), smallButton(tr("Slet", "Delete"), () => deleteComment(from)));
    card.append(actions);
  }
  return card;
}

/**
 * Kommentarerne med deres tal i teksten. En kommentar inde i et forslag får intet kort: den står
 * i slettet tekst, og tallet vises ikke (revisionsView.ts).
 */
function notesInMargin(doc: string): { from: number; text: string; nr: number }[] {
  const revisions = findRevisions(doc);
  return findNotes(doc)
    .map((n, i) => ({ from: n.from, to: n.to, text: n.text || tr("Tom kommentar", "Empty comment"), nr: i + 1 }))
    .filter((n) => !revisions.some((r) => n.from >= r.from && n.to <= r.to))
    .map(({ from, text, nr }) => ({ from, text, nr }));
}

/** Hilsen, kort og feltet i margenen: hver ud for sin linje, skubbet ned, så de aldrig dækker hinanden. */
function arrange(): void {
  if (!wide.matches) return;
  view.requestMeasure({
    key: "g-margen",
    read: (v) => {
      const off = v.documentTop - $("editor").getBoundingClientRect().top;
      const y = (pos: number) => v.lineBlockAt(Math.min(pos, v.state.doc.length)).top + off;
      return {
        notes: notesInMargin(v.state.doc.toString()).map((n) => ({ ...n, y: y(n.from) })),
        form: formAt === null ? 0 : y(formAt),
      };
    },
    write: ({ notes, form }) => {
      // Kortet for den kommentar, der rettes, står ikke, mens feltet står på dens plads.
      const spots = notes.filter((n) => n.from !== editing).map((n) => ({ ...n, el: noteCard(n.from, n.text, n.nr) }));
      $("g-noter").replaceChildren(...spots.map((c) => c.el));
      if (!$("g-form").hidden) spots.push({ from: -1, text: "", nr: 0, y: form, el: $("g-form") });
      spots.sort((a, b) => a.y - b.y);
      let next = $("g-intro").hidden ? 0 : $("g-intro").offsetHeight + 16;
      for (const s of spots) {
        const top = Math.max(s.y, next);
        s.el.style.top = `${top}px`;
        next = top + s.el.offsetHeight + 10;
      }
      // Mange kommentarer nederst skubber kortene ud over teksten: siden bliver lang nok til dem,
      // så de ikke lægger sig over foden.
      $("editor").style.minHeight = `${next + 24}px`;
    },
  });
}

/** Bred eller smal: hilsenen og feltet flyttes ind i margenen eller tilbage over teksten. */
function placeSide(): void {
  const side = wide.matches;
  $("g-margen").hidden = !side;
  if (side) $("g-margen").prepend($("g-intro"), $("g-form"));
  else {
    $("g-doed").before($("g-form"), $("g-intro"));
    $("g-form").style.top = "";
    $("editor").style.minHeight = "";
  }
  view.dispatch({ effects: noteDisplay() });
  arrange();
}

const marginWatch = ViewPlugin.define(() => ({
  update: (u) => {
    if (u.docChanged || u.geometryChanged || u.viewportChanged) arrange();
  },
}));

const guestExtensions = [
  ...(touch ? [] : [guestSelectionToolbar(openComment)]),
  marginWatch,
  // Som i Word.
  keymap.of([{ key: "Mod-Alt-m", run: () => (openComment(), true) }]),
];

function status(text: string): void {
  $("g-gemt").textContent = text;
}

/** Så længe et link højst lever. Ældre kladder i browseren slettes (kodegennemgang 20/10). */
const DRAFT_MS = 30 * 24 * 3600 * 1000;

/** En kopi i browseren, så intet går tabt, hvis nettet er væk, når fanen lukkes. */
function keepDraft(text: string): void {
  try {
    if (text === saved) localStorage.removeItem(draftKey);
    else localStorage.setItem(draftKey, JSON.stringify({ rev, text, at: Date.now() }));
  } catch {
    // Privat vindue eller blokeret lager: siden virker stadig, bare uden kladde.
  }
}

function readDraft(): { rev: number; text: string } | null {
  try {
    const raw = localStorage.getItem(draftKey);
    const draft = raw ? (JSON.parse(raw) as { rev: number; text: string; at?: number }) : null;
    if (draft && Date.now() - (draft.at ?? 0) > DRAFT_MS) {
      dropDraft();
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

/** Linket virker ikke længere: kladden må ikke blive liggende på en computer, flere bruger. */
function dropDraft(): void {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Intet at rydde.
  }
}

function changed(): void {
  if (dead) return;
  window.clearTimeout(timer);
  const text = view.state.doc.toString();
  keepDraft(text);
  if (text === saved) return;
  status(tr("Ikke gemt endnu", "Not saved yet"));
  timer = window.setTimeout(() => void save(), SAVE_MS);
}

async function save(): Promise<void> {
  if (saving) await saving;
  const text = view.state.doc.toString();
  if (text === saved) return;
  saving = (async () => {
    status(tr("Gemmer …", "Saving …"));
    try {
      const r = await fetch(api, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_rev: rev, text }),
        keepalive: true,
      });
      if (r.ok) {
        rev = ((await r.json()) as { rev: number }).rev;
        saved = text;
        keepDraft(view.state.doc.toString());
        status(view.state.doc.toString() === saved ? tr("Gemt", "Saved") : tr("Ikke gemt endnu", "Not saved yet"));
        return;
      }
      if (r.status === 409) {
        conflict((await r.json()) as { rev: number; text: string });
        return;
      }
      if (linkGone(r)) {
        stopped();
        return;
      }
      throw new Error(String(r.status));
    } catch {
      status(tr("Ikke gemt", "Not saved"));
      // Nettet er væk et øjeblik: prøv igen. Kladden ligger i browseren imens.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void save(), 10_000);
    }
  })().finally(() => {
    saving = null;
  });
  return saving;
}

/** Teksten er gemt fra en anden fane eller et andet vindue med samme link. */
function conflict(current: { rev: number; text: string }): void {
  status(tr("Ikke gemt", "Not saved"));
  showBanner(
    tr(
      "Teksten er også rettet i et andet vindue med det samme link. Vælg, hvilken udgave der skal gælde.",
      "The text was also changed in another window with the same link. Choose which version to keep.",
    ),
    [
      {
        label: tr("Behold denne", "Keep this one"),
        run: () => {
          rev = current.rev;
          void save();
        },
      },
      {
        label: tr("Hent den anden", "Load the other"),
        run: () => load({ rev: current.rev, text: current.text }),
      },
    ],
  );
}

function stopped(): void {
  dead = true;
  dropDraft();
  window.clearTimeout(timer);
  $("g-kommentar").hidden = true;
  $("g-form").hidden = true;
  status("");
  showBanner(
    tr(
      "Linket virker ikke længere. Det kan være udløbet, eller delingen er stoppet. Det, du har skrevet, ligger stadig her på siden, så du kan kopiere det.",
      "The link no longer works. It may have expired, or the sharing was stopped. What you wrote is still on this page, so you can copy it.",
    ),
  );
}

function load(copy: { rev: number; text: string }): void {
  rev = copy.rev;
  saved = copy.text;
  view.setState(createState(copy.text, { authors: [], me: { kind: "human", name: "", identifier: null }, pasted: [], external: [] }, 0, changed));
  view.dispatch({ effects: [setSuggesting.of(true), setShowRevisions.of(showAll), noteDisplay(), StateEffect.appendConfig.of(guestExtensions)] });
  setMarkMode(view, "skjul");
  status(tr("Gemt", "Saved"));
}

/** Siden kan ikke vise teksten: en rigtig side med overskrift i stedet for et banner over en tom flade. */
function deadPage(title: string, text: string): void {
  $("g-titel").textContent = tr("Delt tekst", "Shared text");
  $("g-doed-titel").textContent = title;
  $("g-doed-tekst").textContent = text;
  $("g-doed").hidden = false;
  $("editor").hidden = true;
}

async function start(): Promise<void> {
  $("g-fod-tekst").textContent = tr(
    "Delt fra Gode Tekster, et gratis skriveprogram til Windows fra",
    "Shared from Gode Tekster, a free writing app for Windows by",
  );
  $("g-privatliv").textContent = tr("Privatliv", "Privacy");
  const r = await fetch(api).catch(() => null);
  if (!r || !r.ok) {
    if (r && linkGone(r)) dropDraft();
    if (r?.status === 429) {
      deadPage(tr("For mange forsøg", "Too many attempts"), tr("Vent et par minutter, og prøv igen.", "Wait a few minutes and try again."));
    } else if (r) {
      deadPage(
        tr("Linket virker ikke længere", "The link no longer works"),
        tr(
          "Det kan være udløbet, eller delingen er stoppet. Spørg den, der sendte dig linket, om et nyt.",
          "It may have expired, or the sharing was stopped. Ask the person who sent you the link for a new one.",
        ),
      );
    } else {
      deadPage(
        tr("Teksten kunne ikke hentes", "The text could not be loaded"),
        tr("Tjek nettet, og prøv igen.", "Check your connection and try again."),
      );
    }
    return;
  }
  const copy = (await r.json()) as GuestCopy;
  document.title = copy.title || "Gode Tekster";
  $("g-titel").textContent = copy.title || tr("Delt tekst", "Shared text");
  // Hvem teksten er fra (»Dit navn« i afsenderens program). Ældre delinger har intet navn.
  const from = copy.from?.trim() ?? "";
  const first = from.split(/\s+/)[0] ?? "";
  if (from) {
    $("g-afsender").textContent = tr(`Fra ${from}`, `From ${from}`);
    $("g-afsender").hidden = false;
  }
  $("g-hej").textContent = tr(`Hej ${copy.name}`, `Hi ${copy.name}`);
  $("g-hilsen").textContent = from
    ? tr(
        `${from} har delt teksten med dig. Ret direkte i den. Det, du skriver og sletter, bliver forslag, som ${first} kan tage med eller lade være. Vil du skrive en bemærkning, så markér et sted og tryk på Kommentér. Alt gemmes af sig selv.`,
        `${from} has shared the text with you. Edit it directly. What you type and delete becomes suggestions ${first} can accept or not. To add a remark, select a passage and press Comment. Everything is saved automatically.`,
      )
    : tr(
        "Teksten er delt med dig. Ret direkte i den. Det, du skriver og sletter, bliver forslag, som forfatteren kan tage med eller lade være. Vil du skrive en bemærkning, så markér et sted og tryk på Kommentér. Alt gemmes af sig selv.",
        "The text has been shared with you. Edit it directly. What you type and delete becomes suggestions the author can accept or not. To add a remark, select a passage and press Comment. Everything is saved automatically.",
      );
  $("g-intro").hidden = introClosed();
  const comment = $("g-kommentar");
  comment.textContent = tr("Kommentér", "Comment");
  comment.hidden = false;
  comment.addEventListener("mousedown", (e) => e.preventDefault());
  comment.addEventListener("click", openComment);
  const show = $("g-vis");
  show.hidden = false;
  show.addEventListener("mousedown", (e) => e.preventDefault());
  show.addEventListener("click", () => setShowAll(!showAll));
  load(copy);
  setShowAll(showAll);
  placeSide();
  wide.addEventListener("change", placeSide);
  // En kladde fra sidst, der ikke nåede serveren: læg den ind igen, hvis serveren ikke har fået nyt siden.
  const draft = readDraft();
  if (draft && draft.rev === copy.rev && draft.text !== copy.text) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draft.text }, userEvent: "input.external" });
    changed();
  }
  view.focus();
}

function introClosed(): boolean {
  try {
    return localStorage.getItem(introKey) === "1";
  } catch {
    return false;
  }
}

/** Hilsenen kan lukkes, og den bliver væk næste gang, samme link åbnes. */
function closeIntro(): void {
  $("g-intro").hidden = true;
  try {
    localStorage.setItem(introKey, "1");
  } catch {
    // Den kommer bare igen næste gang.
  }
  arrange();
  view.focus();
}

const closeButton = $("g-luk");
closeButton.innerHTML = ICON.close;
closeButton.title = tr("Luk", "Close");
closeButton.setAttribute("aria-label", tr("Luk hilsenen", "Close the greeting"));
closeButton.addEventListener("click", closeIntro);

$("g-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = ($("g-tekst") as HTMLTextAreaElement).value.trim();
  const note = editing;
  $("g-form").hidden = true;
  editing = formAt = null;
  if (note !== null) editComment(view, note, text);
  else if (text) addComment(view, text);
  arrange();
  view.focus();
});
$("g-annuller").addEventListener("click", closeComment);
$("g-slet").addEventListener("click", () => {
  const note = editing;
  closeComment();
  if (note !== null) deleteComment(note);
});
$("editor").addEventListener("gt-note-open", (e) => openEdit((e as CustomEvent<number>).detail));
$("g-tekst").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeComment();
  // Enter tilføjer, Shift+Enter giver en ny linje i feltet.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    ($("g-form") as HTMLFormElement).requestSubmit();
  }
});

window.addEventListener("pagehide", () => {
  if (view.state.doc.toString() !== saved) void save();
});

void start();
