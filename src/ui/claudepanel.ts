// Fanen Input (id »claude«) i højre spalte (plan 2-9 del F): skær lidt eller meget, faktatjek og research på
// brugerens abonnement (ADR-0004, -0010). Kun når brugeren beder om det. Er noget markeret, gælder det
// kun markeringen. »Skær« dæmper selv alt det foreslåede (2/10: at godkende hvert sted tog for
// lang tid); det fortrydes med Ctrl+Z, og dæmpet tekst kan klikkes væk (dimBubble.ts).
//
// Efter personatjekket 2/10: faktatjek og research gemmes som skjulte blokke i selve filen
// (claudeBlocks.ts), så de er der igen, når teksten åbnes. Kald står i kø i stedet for at stoppe
// hinanden, og et svar til en tekst, der ikke er åben længere, lægges ind, når den åbnes igen.

import { invoke, Channel } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";

import { parkChanges, withoutParked } from "../editor/parked.ts";
import { protectedRanges } from "../editor/hidden.ts";
import { insertFootnote } from "../editor/editing.ts";
import { cutChanges, dimmedInBody, parkDimmedChanges } from "../editor/dimming.ts";
import { clippingText, footnoteText, fragmentUrl, type Source } from "../editor/sources.ts";
import { findClaudeBlocks, saveChanges, setHandled, type ClaudeKind, type Handled, type HandledMap } from "../editor/claudeBlocks.ts";
import { errorText, hideBanner, notify, showBanner } from "./banner.ts";
import { isEnglish, tr } from "../i18n.ts";
import { shortDate, todayIso } from "../editor/dates.ts";
import type { AiCommandAnswer, Command, CommandResult } from "../commands/types.ts";
import { clearCommandResults, commandResultBlocks, hasCommandResults, onCommandResults, placeExcerpts, showCommandResult } from "./commandResults.ts";

type Cut = { quote: string; reason: string };
type Claim = { quote: string; verdict: string; explanation: string; sources: Source[] };
type Finding = { summary: string; source: Source };
type Progress = { kind: "step"; text: string } | { kind: "usage"; fiveHour: number; sevenDay: number };

type AiState = { chosen: string | null; providers: { id: string; name: string; ready: boolean; detail: string; web: boolean }[] };

type Status = { kind: "idle" } | { kind: "running"; label: string; step: string } | { kind: "error"; message: string };

const VERDICT: Record<string, string> = {
  korrekt: tr("Korrekt", "Correct"),
  forkert: tr("Forkert", "Wrong"),
  upræcis: tr("Upræcis", "Imprecise"),
  "kan ikke afgøres": tr("Kan ikke afgøres", "Can't be determined"),
};

const CHECK: Record<string, string> = {
  fundet: tr("Citatet står på siden", "The quote is on the page"),
  ikke_fundet: tr("Citatet blev ikke fundet på siden", "The quote was not found on the page"),
  ikke_tjekket: tr("Citatet er ikke tjekket her", "The quote was not checked here"),
  kunne_ikke_hentes: tr("Siden kunne ikke hentes", "The page could not be loaded"),
};

export class ClaudePanel {
  private view: EditorView;
  private path: () => string | null;
  private status: Status = { kind: "idle" };
  /** Korrekte påstande, brugeren har foldet ud (citatet er nøglen). */
  private unfolded = new Set<string>();
  /** Segl, Rust har tjekket (seal.rs, fund 3). Nøglen er segl og tekst. */
  private trust = new Map<string, boolean | "venter">();
  /** Faktatjek, hvor gruppen »Håndteret« er foldet ud (blokkens id). Kun visning, gemmes ikke. */
  private openHandled = new Set<string>();
  /** Blokken, hvis næste åbne påstand skal have fokus efter tegningen (Tab og Mellemrum ned ad listen). */
  private focusNext: string | null = null;
  /** Hvornår det igangværende kald startede, og uret, der viser det. */
  private runningSince = 0;
  private ticker = 0;
  /** AI-hjælpens udbydere (ai.rs). Navnet på den valgte bruges i teksterne. */
  private ai: AiState | null = null;
  private get aiName(): string {
    return this.ai?.providers.find((p) => p.id === this.ai?.chosen)?.name ?? tr("AI-hjælpen", "AI help");
  }
  private body: HTMLElement | null = null;
  private question = "";
  /** Vises kun, når forbruget nærmer sig loftet (ingen småtekster ellers, ADR-0015). */
  private usage = "";
  /** Kaldene kører ét ad gangen; resten venter her. Stop tømmer køen (ny generation). */
  private chain: Promise<void> = Promise.resolve();
  private waiting = 0;
  private generation = 0;
  /** Svar til tekster, der ikke er åbne lige nu. Lægges ind, når teksten åbnes igen. */
  private pending = new Map<string, { kind: ClaudeKind; data: unknown }[]>();
  private onShow: () => void;
  /** Spørgsmålet, før teksten første gang sendes til en udbyder. Står i fanen, til det er besvaret. */
  private consent: { name: string; answer: (ok: boolean) => void } | null = null;
  /** En AI-kommandos instruks, vist før første kørsel og efter hver ændring (research 3.5). */
  /** Den åbne tekst. Kommandoresultater forsvinder, når en anden åbnes. */
  private lastDoc: string | null = null;

  constructor(view: EditorView, path: () => string | null, onShow: () => void) {
    this.view = view;
    this.path = path;
    this.onShow = onShow;
    // Resultater fra tjek og AI-kommandoer (commandResults.ts) står i denne fane. Et nyt får fanen frem.
    onCommandResults((isNew) => {
      if (isNew) this.onShow();
      else this.rerender();
    });
  }

  /** Hent udbydernes tilstand (login-tjek tager sekunder, så Rust gemmer svaret et minut). */
  async refreshAi(refresh = false): Promise<void> {
    this.ai = await invoke<AiState>("ai_status", { refresh });
    this.rerender();
  }

  /**
   * Før et kald: er en udbyder klar, og har brugeren sagt ja til at sende teksten til den?
   * Spørgsmålet stilles én gang pr. udbyder (delbar udgave 3/10: teksten sendes ud af huset).
   */
  private async allowed(): Promise<boolean> {
    // Et tidligere afslag må ikke overleve installation eller login i samme session.
    // Positive svar bruger Rusts korte cache; negative svar kontrolleres på ny.
    const previouslyReady = this.ai?.providers.some((p) => p.id === this.ai?.chosen && p.ready);
    await this.refreshAi(this.ai !== null && !previouslyReady);
    const chosen = this.ai?.providers.find((p) => p.id === this.ai?.chosen);
    if (!chosen?.ready) {
      showBanner(chosen ? `${chosen.name}: ${chosen.detail}` : tr(
            "AI-hjælpen er ikke sat op. Den kan bruge dit eget Claude-, ChatGPT- eller Gemini-abonnement.",
            "AI help isn't set up. It can use your own Claude, ChatGPT or Gemini subscription.",
          ), [
        { label: tr("Indstillinger", "Settings"), run: () => void window.dispatchEvent(new CustomEvent("gt-open-settings", { detail: "ai" })) },
      ]);
      return false;
    }
    const key = `gt-ai-ok-${chosen.id}`;
    try {
      if (localStorage.getItem(key)) return true;
    } catch {
      return true;
    }
    // Spørgsmålet står i fanen under knapperne, ikke i beskedlinjen øverst (5/10).
    return new Promise((resolve) => {
      this.consent?.answer(false); // et ældre, ubesvaret spørgsmål afløses
      this.consent = {
        name: chosen.name,
        answer: (ok) => {
          this.consent = null;
          if (ok) {
            try {
              localStorage.setItem(key, "1");
            } catch {
              // Lagringen kan være spærret; så spørges der igen næste gang.
            }
          }
          this.rerender();
          resolve(ok);
        },
      };
      this.onShow();
      this.rerender();
    });
  }

  private consentBlock(): HTMLElement[] {
    const c = this.consent;
    if (!c) return [];
    const box = document.createElement("div");
    box.className = "cl-message";
    box.setAttribute("role", "status");
    box.append(
      note(
        tr(
          `Teksten, eller det du har markeret, sendes til ${c.name} via din egen konto. Gode Medier ser den ikke.`,
          `The text, or what you have selected, is sent to ${c.name} through your own account. Gode Medier doesn't see it.`,
        ),
        "",
      ),
      tools([[tr("Send", "Send"), () => c.answer(true)], [tr("Annullér", "Cancel"), () => c.answer(false)]]),
    );
    return [box];
  }

  /** En anden tekst er åbnet. Kørende kald fortsætter; deres svar finder vej til deres egen tekst. */
  reset(): void {
    this.rerender();
  }

  /** En tekst er åbnet: læg svar ind, der kom, mens den var lukket. */
  docOpened(path: string): void {
    if (this.lastDoc !== path.toLowerCase()) clearCommandResults();
    this.lastDoc = path.toLowerCase();
    const waiting = this.pending.get(path.toLowerCase());
    if (!waiting) return;
    this.pending.delete(path.toLowerCase());
    for (const w of waiting) this.store(path, w.kind, w.data);
    notify(
      waiting.length === 1
        ? tr("Et svar fra AI-hjælpen fra før er lagt ind i fanen Input.", "An earlier answer from AI help has been added to the Input tab.")
        : tr(`${waiting.length} svar fra AI-hjælpen fra før er lagt ind i fanen Input.`, `${waiting.length} earlier answers from AI help have been added to the Input tab.`),
    );
  }

  /** Stop det kørende kald og tøm køen. */
  stop(): void {
    this.generation++;
    this.waiting = 0;
    if (this.status.kind === "running") void invoke("claude_cancel");
    this.status = { kind: "idle" };
    this.rerender();
  }

  render(body: HTMLElement): void {
    this.body = body;
    const head = document.createElement("div");
    head.className = "cl-actions";
    // Én knap til at skære (2/10): et klik skærer lidt, et dobbeltklik skærer meget. Klikket
    // venter et øjeblik for at se, om der kommer et til.
    const cut = this.button(tr("Skær", "Trim"), () => {});
    cut.title = tr("Klik: skær lidt. Dobbeltklik: skær meget", "Click: trim a little. Double-click: trim a lot");
    let timer: number | undefined;
    cut.addEventListener("click", (e) => {
      window.clearTimeout(timer);
      if (e.detail >= 2) return;
      timer = window.setTimeout(() => void this.cut(false), 300);
    });
    cut.addEventListener("dblclick", () => {
      window.clearTimeout(timer);
      void this.cut(true);
    });
    const clean = this.button(tr("Renskriv", "Clean up"), () => void this.clean());
    clean.title = tr(
      "Ret tastefejl, tegnsætning og afsnit i teksten. Den gamle tekst lægges i Fraklip (markér et stykke for kun at renskrive det)",
      "Fix typos, punctuation and paragraphs in the text. The old text goes to Clippings (select a passage to clean up only that)",
    );
    head.append(cut, this.button(tr("Faktatjek", "Fact-check"), () => void this.factcheck()), clean);
    const ask = document.createElement("form");
    ask.className = "cl-ask";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Research … (Enter)";
    input.value = this.question;
    input.setAttribute("aria-label", tr("Spørgsmål til research", "Research question"));
    input.addEventListener("input", () => (this.question = input.value));
    ask.append(input);
    ask.addEventListener("submit", (e) => {
      e.preventDefault();
      if (input.value.trim()) {
        void this.research(input.value.trim());
        this.question = "";
      }
    });
    const saved = this.saved();
    const results = commandResultBlocks();
    body.replaceChildren(head, ...this.consentBlock(), ask, ...this.statusBlock(), ...results, ...saved, ...(this.usage ? [note(this.usage)] : []));
    // Faktatjek og research har brug for plads (4/10): spalten bliver bredere, så længe der står
    // svar i fanen. RightPanel fjerner klassen igen, når en anden fane vises.
    document.body.classList.toggle("rp-wide", saved.length > 0 || results.length > 0 || this.status.kind === "running");
    // Efter et flueben: fokus til næste åbne påstands cirkel, så man kan gå ned ad listen med Mellemrum.
    if (this.focusNext) {
      const id = this.focusNext;
      this.focusNext = null;
      const ticks = [...body.querySelectorAll<HTMLButtonElement>(".cl-tick")].filter((t) => t.dataset.block === id);
      (ticks.find((t) => !t.classList.contains("cl-ticked")) ?? body.querySelector<HTMLButtonElement>(".cl-done-head"))?.focus();
    }
  }

  private rerender(): void {
    // Kun når fanen Input er den, der vises. Kroppen deles med Fraklip og Noter (perf-review 2/10).
    if (this.body?.isConnected && this.body.dataset.tab === "claude" && this.body.getClientRects().length) this.render(this.body);
  }

  private button(label: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", run);
    return b;
  }

  /**
   * Markeringen, ellers hele teksten uden fraklip og gemte resultater. Siger også hvad, til statuslinjen.
   * `what` er altid dansk, fordi faktatjekket gemmer det i filen; skærmen viser det med `shownWhat`.
   */
  private scope(): { text: string; what: string } {
    const { from, to } = this.view.state.selection.main;
    if (to > from) {
      const text = this.view.state.sliceDoc(from, to);
      const words = text.split(/\s+/).filter(Boolean).length;
      return { text, what: `markeringen (${words} ord)` };
    }
    return { text: withoutParked(this.view.state.doc.toString()), what: "hele teksten" };
  }

  private docName(path: string): string {
    return path.slice(path.lastIndexOf("\\") + 1);
  }

  /** Kør et kald, når de forrige er færdige. Svaret går til `done` med tekstens sti fra starten. */
  private enqueue<T>(label: string, command: string, args: Record<string, unknown>, done: (answer: T, path: string) => void, show = true): void {
    const gen = this.generation;
    const path = this.path();
    if (!path) return;
    this.waiting++;
    if (show) this.onShow();
    this.rerender();
    this.chain = this.chain.then(async () => {
      if (gen !== this.generation) return;
      this.waiting--;
      const answer = await this.call<T>(tr(`${label} i ${this.docName(path)}`, `${label} in ${this.docName(path)}`), command, args, gen);
      if (answer !== null && gen === this.generation) done(answer, path);
    });
  }

  private async call<T>(label: string, command: string, args: Record<string, unknown>, gen: number): Promise<T | null> {
    const progress = new Channel<Progress>();
    progress.onmessage = (p) => {
      if (gen !== this.generation) return;
      if (p.kind === "usage") {
        const pct = (n: number) => Math.round(n * 100);
        this.usage =
          p.sevenDay >= 0.75
            ? tr(`Du har brugt ${pct(p.sevenDay)} procent af ugens Claude-forbrug.`, `You have used ${pct(p.sevenDay)} percent of this week's Claude usage.`)
            : p.fiveHour >= 0.75
              ? tr(
                  `Du har brugt ${pct(p.fiveHour)} procent af Claude-forbruget for de seneste fem timer.`,
                  `You have used ${pct(p.fiveHour)} percent of your Claude usage for the last five hours.`,
                )
              : "";
        return;
      }
      if (this.status.kind === "running") {
        this.status = { ...this.status, step: p.text };
        this.rerender();
      }
    };
    this.status = { kind: "running", label, step: tr(`Spørger ${this.aiName}`, `Asking ${this.aiName}`) };
    this.runningSince = Date.now();
    this.rerender();
    try {
      const answer = await invoke<T>(command, { ...args, progress });
      if (gen !== this.generation) return null;
      this.status = { kind: "idle" };
      return answer;
    } catch (e) {
      if (gen === this.generation) this.status = { kind: "error", message: errorText(e) };
      return null;
    } finally {
      this.rerender();
    }
  }

  /** Gem et resultat i sin tekst: nu, hvis den er åben, ellers når den åbnes igen. */
  private store(path: string, kind: ClaudeKind, data: unknown): void {
    const open = this.path();
    if (open && open.toLowerCase() === path.toLowerCase()) {
      this.view.dispatch({ changes: saveChanges(this.view.state.doc.toString(), kind, data), userEvent: "input.ai" });
      this.onShow();
    } else {
      const key = path.toLowerCase();
      this.pending.set(key, [...(this.pending.get(key) ?? []), { kind, data }]);
      notify(
        tr(
          `${this.aiName} er færdig med ${this.docName(path)}. Svaret ligger der, når du åbner teksten igen.`,
          `${this.aiName} is done with ${this.docName(path)}. The answer will be there when you open the text again.`,
        ),
      );
    }
    this.rerender();
  }

  /**
   * Forsegl modellens del (seal.rs, fund 3) og gem. Kan seglet ikke laves, gemmes svaret alligevel
   * og vises som ikke tjekket her.
   */
  private async sealed(path: string, kind: ClaudeKind, data: Record<string, unknown>, part: unknown): Promise<void> {
    let seal: string | null = null;
    try {
      seal = await invoke<string>("seal_text", { text: JSON.stringify(part) });
    } catch {
      // Uden segl: blokken står som »Fra filen, ikke tjekket her«.
    }
    this.store(path, kind, seal ? { ...data, seal } : data);
  }

  /** Er blokken lavet på denne pc? »venter«, mens Rust svarer. Første gang spørges Rust, og der tegnes igen. */
  private trusted(part: unknown, seal: unknown): boolean | "venter" {
    if (typeof seal !== "string") return false;
    const key = `${seal}|${JSON.stringify(part ?? null)}`;
    const known = this.trust.get(key);
    if (known !== undefined) return known;
    this.trust.set(key, "venter");
    invoke<boolean>("seal_check", { text: JSON.stringify(part ?? null), seal })
      .catch(() => false)
      .then((ok) => {
        this.trust.set(key, ok);
        this.rerender();
      });
    return "venter";
  }

  /**
   * Kryds påstand nr. `index` af, eller åbn den igen (variant A, 9/10). »Rettet« eller »Står« sætter
   * programmet selv: står citatet ikke længere i teksten, er det rettet.
   */
  private handle(id: string, index: number, quote: string, on: boolean): void {
    const doc = this.view.state.doc.toString();
    const value: Handled | null = on ? { how: withoutParked(doc).includes(quote) ? "står" : "rettet", date: todayIso() } : null;
    const change = setHandled(doc, id, index, value);
    if (!change) return;
    // Skribentens handling, ikke AI's: samme slags ændring som at fjerne en blok.
    this.view.dispatch({ changes: change, userEvent: "input.claude" });
    this.focusNext = on ? id : null;
    this.rerender();
    if (!on) return;
    const block = findClaudeBlocks(this.view.state.doc.toString()).find((b) => b.id === id);
    const d = (block?.data ?? {}) as { claims?: Claim[]; seal?: unknown; handled?: HandledMap };
    const trusted = this.trusted(d.claims ?? [], d.seal) === true;
    const left = (d.claims ?? []).filter((cl, i) => status(cl, trusted) !== "korrekt" && !d.handled?.[String(i)]).length;
    const banner =
      left === 0
        ? showBanner(tr("Alle påstande er håndteret. Fjern faktatjekket fra teksten?", "All claims are handled. Remove the fact-check from the text?"), [{ label: tr("Fjern", "Remove"), run: () => this.removeBlock(id) }], { closable: true })
        : showBanner(tr("Påstanden er håndteret.", "The claim is handled."), [{ label: tr("Fortryd", "Undo"), run: () => this.handle(id, index, quote, false) }], { closable: true });
    window.setTimeout(() => hideBanner(banner), 8000);
  }

  private removeBlock(id: string): void {
    const b = findClaudeBlocks(this.view.state.doc.toString()).find((x) => x.id === id);
    if (b) this.view.dispatch({ changes: { from: b.from, to: b.to, insert: "" }, userEvent: "delete.claude" });
  }

  // --- skær --------------------------------------------------------------------------------------

  /**
   * Skær: Claude finder det, der kan undværes, og det hele dæmpes på én gang (2/10). Status i
   * beskedlinjen, ikke i spalten. Ctrl+Z fortryder hele skæringen; »Til fraklip« flytter alt dæmpet ud.
   */
  async cut(much: boolean): Promise<void> {
    if (!(await this.allowed())) return;
    const { text, what } = this.scope();
    const label = much ? tr("Skærer meget", "Trimming a lot") : tr("Skærer lidt", "Trimming a little");
    const running = showBanner(tr(`${label} i ${what} …`, `${label} in ${shownWhat(what)} …`), [{ label: tr("Stop", "Stop"), run: () => this.stop() }]);
    this.enqueue<Cut[]>(
      label,
      "claude_cut",
      { text, much },
      (cuts, path) => {
        // Uddragene giver kun mening i den tekst, de kom fra.
        if (this.path()?.toLowerCase() !== path.toLowerCase()) return;
        const r = cutChanges(this.view.state.doc.toString(), cuts);
        hideBanner(running);
        if (r.count === 0) {
          notify(tr(`${this.aiName} fandt intet, der kunne skæres.`, `${this.aiName} found nothing to trim.`));
          return;
        }
        this.view.dispatch({ changes: r.changes, userEvent: "input.dim" });
        // Kvitteringen hører til teksten: den kan lukkes, og den forsvinder, når en anden tekst åbnes
        // (5/10: den kunne ikke fjernes og fulgte med over i den næste artikel).
        showBanner(tr(
          `Dæmpet ${r.count} ${r.count === 1 ? "sted" : "steder"}, ${r.words} ord. Klik i dæmpet tekst for at fjerne dæmpningen.`,
          `Dimmed ${r.count} ${r.count === 1 ? "place" : "places"}, ${r.words} ${r.words === 1 ? "word" : "words"}. Click dimmed text to undim it.`,
        ), [
          { label: tr("Fortryd", "Undo"), run: () => void import("@codemirror/commands").then((m) => m.undo(this.view)) },
          {
            label: tr("Flyt dæmpet til fraklip", "Move dimmed text to Clippings"),
            run: () => {
              const doc = this.view.state.doc.toString();
              this.view.dispatch({ changes: parkDimmedChanges(doc, dimmedInBody(doc)), userEvent: "delete.park" });
              window.dispatchEvent(new Event("gt-parked"));
            },
          },
        ], { closable: true, perText: true });
      },
      false,
    );
    // Fejl eller Stop: beskedlinjen må ikke blive ved med at sige, at der skæres.
    void this.chain.then(() => {
      hideBanner(running);
      if (this.status.kind === "error") showBanner(this.status.message);
    });
  }

  // --- renskriv --------------------------------------------------------------------------------

  /**
   * Det, Renskriv retter: markeringen, ellers teksten frem til de skjulte blokke i bunden (fraklip,
   * fodnotedefinitioner, gemte svar). De sendes aldrig med og røres aldrig.
   */
  private cleanRange(): { from: number; to: number; text: string; what: string } {
    const state = this.view.state;
    const { from, to } = state.selection.main;
    if (to > from) {
      const text = state.sliceDoc(from, to);
      return { from, to, text, what: `markeringen (${text.split(/\s+/).filter(Boolean).length} ord)` };
    }
    const hidden = protectedRanges(state);
    const end = hidden.length ? hidden[0] : state.doc.length;
    const text = state.sliceDoc(0, end).trimEnd();
    return { from: 0, to: text.length, text, what: "hele teksten" };
  }

  /**
   * Renskriv (3/10, lavet om 6/10, clean.rs): teksten renskrives, hvor den står, og den gamle
   * tekst lægges i fraklip i samme handling, så ét Ctrl+Z bringer den tilbage. Er teksten ændret,
   * mens Claude arbejdede, røres den ikke: så lægges renskriften i fraklip i stedet.
   */
  async clean(): Promise<void> {
    if (!(await this.allowed())) return;
    const range = this.cleanRange();
    if (!range.text.trim()) return notify(tr("Der er ingen tekst at renskrive.", "There is no text to clean up."));
    const running = showBanner(tr(`Renskriver ${range.what} …`, `Cleaning up ${shownWhat(range.what)} …`), [{ label: tr("Stop", "Stop"), run: () => this.stop() }]);
    this.enqueue<string>(
      tr("Renskriver", "Cleaning up"),
      "claude_clean",
      { text: range.text },
      (cleaned, path) => {
        hideBanner(running);
        if (this.path()?.toLowerCase() !== path.toLowerCase()) {
          return notify(tr("Teksten blev lukket, før renskriften var færdig. Intet er ændret.", "The text was closed before the clean-up was done. Nothing has changed."));
        }
        const doc = this.view.state.doc.toString();
        if (doc.slice(range.from, range.to) !== range.text) {
          this.view.dispatch({ changes: parkChanges(doc, [cleaned]), userEvent: "input.ai" });
          window.dispatchEvent(new Event("gt-parked"));
          return notify(tr("Teksten blev ændret undervejs, så den er ikke rørt. Renskriften ligger i Fraklip.", "The text changed in the meantime, so it was left alone. The clean-up is in Clippings."));
        }
        this.view.dispatch({
          changes: [{ from: range.from, to: range.to, insert: cleaned }, ...parkChanges(doc, [range.text])],
          selection: { anchor: range.from },
          userEvent: "input.ai",
          scrollIntoView: true,
        });
        window.dispatchEvent(new Event("gt-parked"));
        const unclear = (cleaned.match(/^\[\?\d+\] /gm) ?? []).length;
        notify(
          tr(
            `Renskrevet. Den gamle tekst ligger i Fraklip${unclear ? `, og ${unclear} uklare steder står i en kommentar nederst` : ""}. Ctrl+Z fortryder.`,
            `Cleaned up. The old text is in Clippings${unclear ? `, and ${unclear} unclear ${unclear === 1 ? "spot is" : "spots are"} listed in a comment at the bottom` : ""}. Ctrl+Z undoes it.`,
          ),
        );
      },
      false,
    );
    void this.chain.then(() => {
      hideBanner(running);
      if (this.status.kind === "error") showBanner(this.status.message);
    });
  }

  // --- faktatjek og research ---------------------------------------------------------------------

  async factcheck(): Promise<void> {
    if (!(await this.allowed())) return;
    const { text, what } = this.scope();
    this.enqueue<Claim[]>(tr(`Faktatjekker ${what}`, `Fact-checking ${shownWhat(what)}`), "claude_factcheck", { text }, (claims, path) => void this.sealed(path, "faktatjek", { what, claims }, claims));
  }

  async research(question: string): Promise<void> {
    if (!(await this.allowed())) return;
    const text = withoutParked(this.view.state.doc.toString());
    this.enqueue<Finding[]>(tr("Researcher", "Researching"), "claude_research", { question, text }, (findings, path) => void this.sealed(path, "research", { question, findings }, findings));
  }

  // --- egne AI-kommandoer (plan 2026-10-05) -------------------------------------------------------

  /**
   * Kør en AI-kommando på `text`. `offset` er tekstens plads i dokumentet, så fund kan springes til.
   * Samtykket er det samme som resten af AI-hjælpen. Svaret er fund eller spørgsmål og skriver
   * intet i teksten.
   */
  async runCommandAi(command: Command, text: string, offset: number): Promise<void> {
    if (!text.trim()) return notify(tr("Der er ingen tekst at sende.", "There is no text to send."));
    // Køres med det samme (6/10: »ikke trykkes ok på først«). Kun lov til at sende til
    // udbyderen spørges der om, og kun første gang (allowed).
    if (!(await this.allowed())) return;
    this.enqueue<AiCommandAnswer>(
      `/${command.name}`,
      "ai_command",
      { instruction: command.body, output: command.output ?? "findings", text, builtin: command.source === "builtin" },
      (answer, path) => {
        // Fundene peger ind i den tekst, de kom fra.
        if (this.path()?.toLowerCase() !== path.toLowerCase()) return;
        const from = (empty: boolean, nothing: string) => tr(`Svar fra ${answer.provider}.`, `Answer from ${answer.provider}.`) + (empty ? ` ${nothing}` : "");
        const findings = placeExcerpts(text, answer.findings);
        const result: CommandResult =
          command.output === "questions"
            ? { kind: "questions", title: `/${command.name}`, questions: answer.questions, note: from(!answer.questions.length, tr("Ingen spørgsmål.", "No questions.")) }
            : { kind: "findings", title: `/${command.name}`, findings, note: from(!findings.length, tr("Ingen fund.", "No findings.")) };
        showCommandResult(this.view, result, offset);
      },
    );
  }

  /**
   * Det gemte i filen: seneste faktatjek og al research, nyeste først. Som en rolig liste uden
   * kasser (variant A, 7/10: »svære at afkode, rodede«): en lille etiket med dato, spørgsmålet på
   * højst to linjer, og hvert fund med kildens navn forrest.
   */
  private saved(): HTMLElement[] {
    const blocks = findClaudeBlocks(this.view.state.doc.toString()).reverse();
    const out: HTMLElement[] = [];
    for (const b of blocks) {
      const remove = () => this.removeBlock(b.id);
      if (b.kind === "faktatjek") {
        const d = b.data as { what?: string; claims?: Claim[]; seal?: unknown; handled?: HandledMap };
        const what = d.what ? (isEnglish() ? shownWhat(d.what) : d.what) : tr("teksten", "the text");
        const claims = d.claims ?? [];
        const trust = this.trusted(claims, d.seal);
        const handled = d.handled ?? {};
        out.push(resultHead(tr(`Faktatjek af ${what}`, `Fact-check of ${what}`), b.date, null, remove));
        if (trust === false) out.push(foreign(tr("Kør faktatjekket igen for at få kilderne efterprøvet.", "Run the fact-check again to have the sources verified.")));
        if (claims.length) out.push(tally(claims, trust === true, handled));
        out.push(this.claimList(b.id, claims, trust === true, handled));
      } else {
        const d = b.data as { question?: string; findings?: Finding[]; seal?: unknown };
        const trust = this.trusted(d.findings ?? [], d.seal);
        out.push(resultHead("Research", b.date, d.question ?? "", remove));
        if (trust === false) out.push(foreign(tr("Citaterne er ikke efterprøvet på kilderne.", "The quotes are not verified against the sources.")));
        out.push(this.findingList(d.findings ?? [], trust === true));
      }
    }
    return out;
  }

  /**
   * Påstandene. De åbne står først, det, der kræver noget, øverst. Hver åben påstand, der ikke er
   * korrekt, har en cirkel til højre, der krydser den af (variant A, 9/10). De afkrydsede står grå og
   * foldet sammen i gruppen »Håndteret« nederst.
   */
  private claimList(id: string, claims: Claim[], trusted: boolean, handled: HandledMap): HTMLElement {
    const list = document.createElement("div");
    list.className = "cl-list";
    if (claims.length === 0) {
      list.append(note(tr(`${this.aiName} fandt ingen påstande, der kunne tjekkes.`, `${this.aiName} found no claims to check.`)));
      return list;
    }
    const body = withoutParked(this.view.state.doc.toString());
    const all = claims.map((cl, i) => ({ cl, i, st: status(cl, trusted) }));
    // De påstande, der kræver noget af én, står først (4/10).
    const open = all.filter((x) => !handled[String(x.i)]).sort((a, b) => RANK[a.st] - RANK[b.st]);
    const done = all.filter((x) => handled[String(x.i)]);
    for (const { cl, i, st } of open) {
      const row = document.createElement("div");
      row.className = "cl-claim";
      const main = document.createElement("div");
      const gone = !body.includes(cl.quote);
      main.append(this.claimText(cl.quote, gone));
      const word = document.createElement("span");
      word.className = `cl-w cl-w-${slug(st)}`;
      // En vurdering uden en kilde, programmet selv har fundet citatet på, er kun modellens ord
      // (personatjek 2/10): den står som »Ikke efterprøvet«, ikke med modellens vurdering.
      word.textContent = st === "ikke efterprøvet" ? tr("Ikke efterprøvet", "Not verified") : (VERDICT[st] ?? st);
      const meta = document.createElement("p");
      meta.className = "cl-why";
      meta.append(word);
      main.append(meta);
      // Teksten er ændret, men påstanden lukkes ikke af sig selv (GitHubs »outdated«).
      if (gone) main.append(note(tr("Teksten er ændret her.", "The text has changed here."), "cl-why cl-gone"));
      // Korrekt og efterprøvet: én linje. Kilden kommer frem ved klik. Kun det, der kræver noget, fylder.
      if (st === "korrekt" && !this.unfolded.has(cl.quote)) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "cl-more";
        more.textContent = tr("vis kilden", "show the source");
        more.addEventListener("click", () => {
          this.unfolded.add(cl.quote);
          this.rerender();
        });
        meta.append(" · ", more);
      } else {
        meta.append(` · ${cl.explanation}`);
        if (st === "ikke efterprøvet") {
          const said = VERDICT[cl.verdict] ?? cl.verdict;
          main.append(
            note(
              trusted
                ? tr(`Vurderingen fra ${this.aiName} var »${said}«, men ingen kilde blev fundet på siden.`, `The verdict from ${this.aiName} was "${said}", but no source was found on the page.`)
                : tr(`Vurderingen i filen er »${said}«, men den er ikke tjekket her.`, `The verdict in the file is "${said}", but it was not checked here.`),
              "cl-why",
            ),
          );
        }
        main.append(...cl.sources.map((s) => this.sourceLine(s, cl.quote, "", trusted)));
      }
      const tick = st === "korrekt" ? document.createElement("span") : this.tick(id, i, cl.quote, false);
      row.append(dot(`cl-s-${slug(st)}`, word.textContent), main, tick);
      list.append(row);
    }
    if (done.length) {
      // En fremmed fils flueben står foldet ud: den kan have krydset »Forkert« af (fund 3).
      const unfolded = !trusted || this.openHandled.has(id);
      const head = document.createElement("button");
      head.type = "button";
      head.className = "cl-done-head";
      head.setAttribute("aria-expanded", String(unfolded));
      head.textContent = tr(`Håndteret (${done.length})`, `Handled (${done.length})`);
      head.addEventListener("click", () => {
        if (this.openHandled.has(id)) this.openHandled.delete(id);
        else this.openHandled.add(id);
        this.rerender();
      });
      list.append(head);
      if (unfolded) {
        for (const { cl, i } of done) {
          const h = handled[String(i)];
          const row = document.createElement("div");
          row.className = "cl-claim cl-done";
          const main = document.createElement("div");
          main.append(this.claimText(cl.quote, !body.includes(cl.quote)));
          const d = new Date(`${h.date}T12:00:00`);
          const how = h.how === "rettet" ? tr("Rettet", "Fixed") : tr("Står", "Kept");
          main.append(note(`${how} · ${Number.isNaN(d.getTime()) ? h.date : shortDate(d)}`, "cl-why"));
          row.append(dot("cl-s-done", how), main, this.tick(id, i, cl.quote, true));
          list.append(row);
        }
      }
    }
    return list;
  }

  /** Citatet. Kan klikkes for at springe til det, så længe det står i teksten. */
  private claimText(quote: string, gone: boolean): HTMLElement {
    if (gone) {
      const span = document.createElement("span");
      span.className = "cl-claim-text cl-claim-gone";
      span.textContent = excerpt(quote);
      return span;
    }
    const text = document.createElement("button");
    text.type = "button";
    text.className = "cl-claim-text";
    text.textContent = excerpt(quote);
    text.title = tr("Vis i teksten", "Show in the text");
    text.addEventListener("click", () => this.jumpTo(quote));
    return text;
  }

  /** Cirklen, der krydser en påstand af, eller fluebenet, der åbner den igen. */
  private tick(id: string, index: number, quote: string, done: boolean): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = done ? "cl-tick cl-ticked" : "cl-tick";
    b.dataset.block = id;
    const label = done ? tr("Åbn påstanden igen", "Reopen the claim") : tr("Markér som håndteret", "Mark as handled");
    b.title = label;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", String(done));
    b.addEventListener("click", () => this.handle(id, index, quote, !done));
    return b;
  }

  private findingList(findings: Finding[], trusted: boolean): HTMLElement {
    const list = document.createElement("div");
    list.className = "cl-list";
    if (findings.length === 0) {
      list.append(note(tr(`${this.aiName} fandt ingen kilder.`, `${this.aiName} found no sources.`)));
      return list;
    }
    for (const f of findings) {
      const item = document.createElement("article");
      item.className = "cl-item";
      const sum = document.createElement("p");
      sum.className = "cl-sum";
      sum.textContent = f.summary;
      item.append(sum, this.sourceLine(f.source, null, f.summary, trusted));
      list.append(item);
    }
    return list;
  }

  // --- kilder ------------------------------------------------------------------------------------

  /**
   * En kilde: citatet (kun hvis det står på siden), og en linje med en prik for citatet, kildens
   * navn forrest, titlen og datoen. Fodnote, fraklip og åbn er små knapper til højre, der kommer
   * frem, når man peger på fundet eller går til det med Tab.
   */
  private sourceLine(s: Source, claimQuote: string | null, summary = "", trusted = true): HTMLElement {
    const box = document.createElement("div");
    box.className = "cl-srcbox";
    // Fra en fremmed fil (fund 3): citatet og »står på siden« er filens ord, ikke programmets.
    if (!trusted) s = { ...s, check: "ikke_tjekket" };
    if (s.check === "fundet") {
      const q = document.createElement("blockquote");
      q.className = "cl-cite";
      q.textContent = tr(`»${s.quote.trim()}«`, `“${s.quote.trim()}”`);
      box.append(q);
    }
    const line = document.createElement("div");
    line.className = "cl-src";
    const text = document.createElement("span");
    text.className = "cl-src-text";
    const name = document.createElement("span");
    name.className = "cl-src-name";
    name.textContent = s.publisher || host(s.url);
    // Et link, ikke en knap: en knap er altid en blok i Chromium, så titlen hoppede ned under
    // kildens navn i stedet for at flyde med i linjen. Rust åbner siden, WebView'et navigerer aldrig.
    const title = document.createElement("a");
    title.className = "cl-src-title";
    title.href = s.url;
    title.textContent = s.title || s.url;
    title.title = s.url;
    title.addEventListener("click", (e) => {
      e.preventDefault();
      void this.open(s);
    });
    // Midterklik åbner ellers et nyt WebView-vindue med siden.
    title.addEventListener("auxclick", (e) => e.preventDefault());
    title.draggable = false;
    text.append(name, " · ", title);
    if (s.date) text.append(` · ${s.date}`);
    // Værtsnavnet står i forklaringen: »står på siden« betyder kun noget, når man ved, hvis side det er.
    const checked = s.check === "fundet" ? tr(`Citatet står på ${host(s.url)}`, `The quote is on ${host(s.url)}`) : (CHECK[s.check] ?? s.check);
    line.append(
      dot(`cl-c-${s.check}`, checked),
      text,
      icons([
        ["¹", tr("Indsæt som fodnote", "Insert as footnote"), () => this.insertNote(s, claimQuote)],
        ["⤓", tr("Læg i fraklip", "Add to Clippings"), () => this.clip(s, summary)],
        ["↗", tr("Åbn siden", "Open the page"), () => void this.open(s)],
      ]),
    );
    box.append(line);
    return box;
  }

  private async open(s: Source): Promise<void> {
    try {
      await invoke("open_url", { url: s.check === "fundet" ? fragmentUrl(s.url, s.quote) : s.url });
    } catch (e) {
      showBanner(errorText(e));
    }
  }

  /** Fodnote efter påstanden (faktatjek) eller ved markøren (research). Tilskrives AI (ADR-0017). */
  private insertNote(s: Source, claimQuote: string | null): void {
    const doc = this.view.state.doc.toString();
    let pos = this.view.state.selection.main.head;
    if (claimQuote) {
      const at = doc.indexOf(claimQuote);
      if (at !== -1) pos = at + claimQuote.length;
    }
    const { changes } = insertFootnote(doc, pos, footnoteText(s));
    this.view.dispatch({ changes, userEvent: "input.ai", scrollIntoView: true });
    notify(tr("Fodnoten er sat ind. Den står som AI-tekst, til du har rettet i den.", "The footnote is inserted. It shows as AI text until you edit it."));
  }

  private clip(s: Source, summary = ""): void {
    this.view.dispatch({
      changes: parkChanges(this.view.state.doc.toString(), [clippingText(s, summary)]),
      userEvent: "input.ai",
    });
    window.dispatchEvent(new Event("gt-parked"));
  }

  private jump(from: number, to: number): void {
    this.view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    this.view.focus();
  }

  private jumpTo(quote: string): void {
    // Kun i selve teksten: blokken sidst i filen rummer også citatet.
    if (!withoutParked(this.view.state.doc.toString()).includes(quote)) return;
    const at = this.view.state.doc.toString().indexOf(quote);
    if (at !== -1) this.jump(at, at + quote.length);
  }

  // --- resultaterne ------------------------------------------------------------------------------

  /** Hvad der kører, hvad der venter, og en fejl fra seneste kald. */
  private statusBlock(): HTMLElement[] {
    const st = this.status;
    const queued = this.waiting > 0 ? [note(this.waiting === 1 ? tr("Ét kald venter i kø.", "One request is waiting in line.") : tr(`${this.waiting} kald venter i kø.`, `${this.waiting} requests are waiting in line.`))] : [];
    if (st.kind === "running") {
      // Roligt og til at se (4/10): en tynd, glidende streg, overskrift, hvad der sker lige nu,
      // og hvor længe det har varet. Stop som et lille link.
      const box = document.createElement("div");
      box.className = "cl-running";
      const line = document.createElement("div");
      line.className = "cl-progress";
      line.setAttribute("aria-hidden", "true");
      const top = document.createElement("div");
      top.className = "cl-running-top";
      const label = document.createElement("strong");
      label.textContent = st.label;
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "settings-link";
      stop.textContent = tr("Stop", "Stop");
      stop.addEventListener("click", () => this.stop());
      top.append(label, stop);
      const step = document.createElement("span");
      step.className = "cl-step";
      step.textContent = st.step;
      const time = document.createElement("span");
      time.className = "cl-elapsed";
      const tick = () => {
        if (!time.isConnected && this.runningSince) return;
        const s = Math.round((Date.now() - this.runningSince) / 1000);
        time.textContent = s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
      };
      tick();
      window.clearInterval(this.ticker);
      this.ticker = window.setInterval(() => (time.isConnected ? tick() : window.clearInterval(this.ticker)), 1000);
      box.setAttribute("role", "status");
      box.append(line, top, step, time);
      return [box, ...queued];
    }
    if (st.kind === "error") return [note(st.message, "cl-message cl-error"), ...queued];
    const empty = findClaudeBlocks(this.view.state.doc.toString()).length === 0 && !hasCommandResults();
    if (this.ai && !this.ai.providers.some((p) => p.ready)) {
      const setup = document.createElement("button");
      setup.type = "button";
      setup.textContent = tr("Sæt AI-hjælpen op", "Set up AI help");
      setup.addEventListener("click", () => window.dispatchEvent(new Event("gt-open-settings")));
      return [note(
          tr(
            "AI-hjælpen bruger dit eget Claude-, ChatGPT- eller Gemini-abonnement. Den er ikke sat op endnu.",
            "AI help uses your own Claude, ChatGPT or Gemini subscription. It isn't set up yet.",
          ), "cl-message"), setup, ...queued];
    }
    return empty
      ? [
          note(
            tr(
              `${this.aiName} læser kun med, når du beder om det. Har du markeret noget, gælder det kun markeringen. Teksten sendes til ${this.aiName} via din egen konto.`,
              `${this.aiName} only reads along when you ask. If you have selected something, only the selection is used. The text is sent to ${this.aiName} through your own account.`,
            ),
          ),
          ...queued,
        ]
      : queued;
  }

}

function note(text: string, cls = "cl-note"): HTMLElement {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}

function tools(items: [string, () => void][]): HTMLElement {
  const t = document.createElement("div");
  t.className = "cl-tools";
  for (const [label, run] of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", run);
    t.append(b);
  }
  return t;
}

/** Overskriften på et gemt resultat: etiket med dato, eventuelt spørgsmålet, og »Fjern«. */
function resultHead(label: string, date: string, question: string | null, remove: () => void): HTMLElement {
  const head = document.createElement("div");
  head.className = "cl-head";
  const left = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.className = "cl-eyebrow";
  const d = new Date(`${date}T12:00:00`);
  eyebrow.textContent = [label, Number.isNaN(d.getTime()) ? date : shortDate(d)].filter(Boolean).join(" · ");
  left.append(eyebrow);
  if (question) {
    const q = document.createElement("p");
    q.className = "cl-q";
    q.textContent = question;
    q.title = question;
    left.append(q);
  }
  const x = document.createElement("button");
  x.type = "button";
  x.className = "cl-x";
  x.textContent = tr("Fjern", "Remove");
  x.addEventListener("click", remove);
  head.append(left, x);
  return head;
}

/**
 * Fordelingen som en tynd stribe, og tallene i ord under den (»3 påstande: 2 korrekte …«). Med
 * »1 af 3 håndteret« for dem, der kræver noget (de korrekte kræver intet).
 */
function tally(claims: Claim[], trusted: boolean, handled: HandledMap): HTMLElement {
  const box = document.createElement("div");
  box.className = "cl-summary";
  const bar = document.createElement("div");
  bar.className = "cl-bar";
  bar.setAttribute("aria-hidden", "true");
  const count = new Map<ClaimStatus, number>();
  for (const cl of claims) count.set(status(cl, trusted), (count.get(status(cl, trusted)) ?? 0) + 1);
  for (const k of Object.keys(RANK) as ClaimStatus[]) {
    const n = count.get(k);
    if (!n) continue;
    const seg = document.createElement("i");
    seg.className = `cl-s-${slug(k)}`;
    seg.style.flexGrow = String(n);
    bar.append(seg);
  }
  const needs = claims.map((cl, i) => ({ st: status(cl, trusted), i })).filter((x) => x.st !== "korrekt");
  const done = needs.filter((x) => handled[String(x.i)]).length;
  const line = overview(claims, trusted) + (needs.length ? tr(` ${done} af ${needs.length} håndteret.`, ` ${done} of ${needs.length} handled.`) : "");
  box.append(bar, note(line, "cl-tally"));
  return box;
}

/** »Fra filen, ikke tjekket her«: blokken har intet gyldigt segl fra denne pc (fund 3). */
function foreign(what: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "cl-foreign";
  const strong = document.createElement("strong");
  strong.textContent = tr("Fra filen, ikke tjekket her.", "From the file, not checked here.");
  p.append(strong, ` ${what}`);
  return p;
}

/** Prikken foran en påstand eller en kilde. Forklaringen står ved musen og for skærmlæsere. */
function dot(cls: string, label: string): HTMLElement {
  const d = document.createElement("span");
  d.className = `cl-dot ${cls}`;
  d.setAttribute("role", "img");
  d.setAttribute("aria-label", label);
  d.title = label;
  return d;
}

/** Små knapper med et tegn og en forklaring ved musen. */
function icons(items: [string, string, () => void][]): HTMLElement {
  const t = document.createElement("span");
  t.className = "cl-icons";
  for (const [sign, label, run] of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cl-icon";
    b.textContent = sign;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", run);
    t.append(b);
  }
  return t;
}

/** »kan ikke afgøres« → »kan-ikke-afgøres« til CSS-klasser. */
const slug = (s: string) => s.replace(/\s+/g, "-");

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www./, "");
  } catch {
    return url;
  }
}

type ClaimStatus = "forkert" | "upræcis" | "ikke efterprøvet" | "kan ikke afgøres" | "korrekt";
const RANK: Record<ClaimStatus, number> = { forkert: 0, upræcis: 1, "ikke efterprøvet": 2, "kan ikke afgøres": 3, korrekt: 4 };

/**
 * Påstandens status, som kortet viser den: uden en fundet kilde er den ikke efterprøvet. Fra en
 * fremmed fil (uden gyldigt segl) er intet efterprøvet her (fund 3).
 */
function status(cl: Claim, trusted = true): ClaimStatus {
  if (!trusted) return "ikke efterprøvet";
  const verified = cl.sources.some((s) => s.check === "fundet");
  if (!verified && cl.verdict !== "kan ikke afgøres") return "ikke efterprøvet";
  return (cl.verdict in RANK ? cl.verdict : "kan ikke afgøres") as ClaimStatus;
}

/** »6 påstande: 1 forkert, 1 ikke efterprøvet, 4 korrekte.« */
export function overview(claims: Claim[], trusted = true): string {
  const count = new Map<ClaimStatus, number>();
  for (const cl of claims) count.set(status(cl, trusted), (count.get(status(cl, trusted)) ?? 0) + 1);
  const plural: Record<ClaimStatus, [string, string]> = isEnglish()
    ? {
        forkert: ["wrong", "wrong"],
        upræcis: ["imprecise", "imprecise"],
        "ikke efterprøvet": ["not verified", "not verified"],
        "kan ikke afgøres": ["can't be determined", "can't be determined"],
        korrekt: ["correct", "correct"],
      }
    : {
        forkert: ["forkert", "forkerte"],
        upræcis: ["upræcis", "upræcise"],
        "ikke efterprøvet": ["ikke efterprøvet", "ikke efterprøvede"],
        "kan ikke afgøres": ["kan ikke afgøres", "kan ikke afgøres"],
        korrekt: ["korrekt", "korrekte"],
      };
  const parts = (Object.keys(RANK) as ClaimStatus[])
    .filter((k) => count.get(k))
    .map((k) => `${count.get(k)} ${plural[k][count.get(k) === 1 ? 0 : 1]}`);
  const and = tr("og", "and");
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} ${and} ${parts[parts.length - 1]}` : parts[0];
  return tr(
    `${claims.length} ${claims.length === 1 ? "påstand" : "påstande"}: ${list}.`,
    `${claims.length} ${claims.length === 1 ? "claim" : "claims"}: ${list}.`,
  );
}

/**
 * Hvad et kald gælder, til skærmen. `what` er dansk, fordi det gemmes i filen (faktatjek), så på
 * engelsk oversættes de to former, scope() laver. Alt andet vises, som det står.
 */
function shownWhat(what: string): string {
  if (!isEnglish()) return what;
  if (what === "hele teksten") return "the whole text";
  const m = /^markeringen \((\d+) ord\)$/.exec(what);
  if (m) return `the selection (${m[1]} ${m[1] === "1" ? "word" : "words"})`;
  return what;
}

function excerpt(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}
