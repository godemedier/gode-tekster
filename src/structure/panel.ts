import type { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { invoke } from "@tauri-apps/api/core";
import { addStructurePart, editStructurePart, removeStructurePart, setStructureModel, structureParts, structurePlan, structureContext, type StructureChange, type StructurePart } from "../editor/structure.ts";
import { withoutParked } from "../editor/parked.ts";
import { bodyEnd } from "../editor/outline.ts";
import { MODEL_GROUPS, NARRATIVE_MODELS, narrativeModel } from "./models.ts";
import { applyStructure, groupSelection, headingGroups, movePart, movePartTo, structureCandidates } from "./edit.ts";
import { errorText, showBanner } from "../ui/banner.ts";
import { locale, tr } from "../i18n.ts";

// Panelet og dialogerne bygges med createElement og tekstnoder. Titler, noter og modellens svar er
// data udefra og må aldrig kunne blive til HTML.

/** Et element med klasse og børn. Strenge bliver tekstnoder, aldrig markup. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...children);
  return e;
}

function button(cls: string, text = "", id = ""): HTMLButtonElement {
  const b = text ? el("button", cls, text) : el("button", cls);
  b.type = "button";
  if (id) b.id = id;
  return b;
}

/** Et tegn, skærmlæseren skal springe over: knappen har sin egen tekst eller aria-label. */
const decoration = (text: string) => {
  const span = el("span", "", text);
  span.setAttribute("aria-hidden", "true");
  return span;
};

/** Krydset i dialogens top. `data-close` står der stadig, så knappen kan findes som før. */
const closeCross = (dialog: HTMLDialogElement) => {
  const b = button("", "×");
  b.dataset.close = "";
  b.setAttribute("aria-label", tr("Luk", "Close"));
  b.addEventListener("click", () => dialog.close());
  return b;
};

function choice(title: string, description: string, id = ""): HTMLButtonElement {
  const b = button("choice", "", id);
  b.append(el("strong", "", title), el("small", "", description));
  return b;
}

const excerpt = (text: string) => {
  const visible = withoutParked(text).trim();
  return visible ? visible.slice(0, 160) + (visible.length > 160 ? "…" : "") : tr("Planlagt del", "Planned part");
};

const words = (text: string) => {
  const visible = withoutParked(text).trim();
  return visible ? visible.split(/\s+/u).length : 0;
};

/** »3 dele« i værktøjsrækken. Ingen dele: intet tal, den tomme tilstand siger det. */
const partCount = (n: number) => n ? `${n} ${n === 1 ? tr("del", "part") : tr("dele", "parts")}` : "";

type Suggestion = { model: string; reason: string; parts: { id: string; role: string; note: string }[] };

export class StructurePanel {
  private view: EditorView;
  private allowed: () => Promise<boolean>;
  private busy = false;
  private documentGeneration = 0;
  private selected: string | null = null;
  private editing = false;
  private category = 0;
  private chosenModel = "";
  private proposal: { doc: string; value: Suggestion; candidates: { id: string; title: string; from: number; to: number }[] } | null = null;
  private body: HTMLElement | null = null;
  private renderKey = "";
  private dragged: string | null = null;
  /** Opdelingen, dialogen »Opdel fra overskrifter« viser, og teksten, den blev lavet ud fra. */
  private headingProposal: { doc: string; candidates: ReturnType<typeof headingGroups> } | null = null;

  // Dialogerne bygges én gang og genbruges
  private boardDialog: HTMLDialogElement | null = null;
  private methodsDialog: HTMLDialogElement | null = null;
  private proposalDialog: HTMLDialogElement | null = null;
  private addDialog: HTMLDialogElement | null = null;
  private headingDialog: HTMLDialogElement | null = null;

  constructor(view: EditorView, allowed: () => Promise<boolean> = async () => true) {
    this.view = view;
    this.allowed = allowed;
    this.initDialogs();
  }

  docOpened(): void {
    this.documentGeneration++;
    // Dialoger med positioner fra den forrige tekst må ikke kunne bruges på den nye.
    for (const d of [this.headingDialog, this.proposalDialog, this.addDialog]) d?.close();
    this.proposal = null;
    this.selected = null;
    this.editing = false;
    this.renderKey = "";
  }

  group(): void {
    if (!groupSelection(this.view)) {
      showBanner(tr("Markér hele afsnit uden eksisterende dele eller skjulte noter.", "Select paragraphs without existing parts or hidden notes."));
    }
  }

  render(body: HTMLElement): void {
    this.body = body;
    body.classList.add("structure-panel");
    const doc = this.view.state.doc.toString();
    const parts = structureParts(doc);
    const plan = structurePlan(doc);
    const model = narrativeModel(plan?.model ?? "");

    if (!this.selected || !parts.some(p => p.id === this.selected)) {
      this.selected = parts[0]?.id ?? null;
      this.editing = false;
    }

    const key = JSON.stringify([
      this.documentGeneration,
      this.busy,
      this.view.state.readOnly,
      locale(),
      plan?.model,
      this.selected,
      this.editing,
      Boolean(this.proposal),
      parts.map(p => [p.id, p.role, p.title, p.note, p.contentFrom, p.contentTo]),
    ]);

    // Intet i nøglen er ændret: ret kun tallene i de elementer, der står, så panelet ikke bygges om
    // for ingenting.
    const listEl = body.querySelector<HTMLElement>("#parts");
    if (!this.proposal && key === this.renderKey && listEl) {
      this.updateInPlace(doc, parts);
      return;
    }
    this.renderKey = key;

    body.replaceChildren();

    // Fanen ruller som én flade med resten af spalten (UX-gennemgang 20/10). Spaltens overskrift siger
    // allerede »Struktur«, så fanen starter med sine værktøjer, og den valgte del folder sine detaljer
    // ud lige under sig i listen. Ingen fast fod: Ctrl+Z fortryder, og ordene står på hver del.

    // 1. Værktøjsrækken
    const tools = el("div", "structure-bar");
    const addBtn = button("rp-btn", "", "add");
    addBtn.append(decoration("+ "), tr("Ny del", "New part"));
    addBtn.addEventListener("click", () => this.addDialog?.showModal());
    const openBoardBtn = button("rp-btn", "", "open-board");
    openBoardBtn.append(`${tr("Stort overblik", "Wide overview")} `, decoration("↗"));
    openBoardBtn.addEventListener("click", () => {
      this.renderBoard();
      this.boardDialog?.showModal();
    });
    const count = el("span", "part-count", partCount(parts.length));
    count.id = "part-count";
    tools.append(addBtn, openBoardBtn, count);

    // 2. Metodelinje
    const methodName = el("span", "", model?.name ?? tr("Fri opbygning", "Free structure"));
    methodName.id = "method-name";
    const methodBtn = button("", "", "open-method");
    methodBtn.append(el("span", "", el("small", "", tr("Fortællemetode", "Narrative method")), methodName), decoration("⌄"));
    methodBtn.addEventListener("click", () => {
      this.chosenModel = plan?.model ?? "";
      this.renderMethods();
      this.methodsDialog?.showModal();
    });
    const methodDiv = el("div", "method", methodBtn);

    // 3. Liste over dele. Den valgte dels detaljer står lige efter dens knap.
    const nav = el("nav", "list");
    nav.id = "parts";
    nav.setAttribute("aria-label", tr("Tekstens rækkefølge", "Document order"));

    if (!parts.length) {
      const emptyHeadings = button("rp-btn rp-btn-primary", tr("Fra overskrifter …", "From headings …"), "empty-headings");
      emptyHeadings.addEventListener("click", () => this.headings());
      const emptyBlank = button("rp-btn", tr("Ny, tom del", "New empty part"), "empty-blank");
      emptyBlank.addEventListener("click", () => this.addBlank());
      nav.append(el("div", "empty",
        el("h3", "", tr("Giv teksten en opbygning", "Give the text structure")),
        el("p", "", tr("Start med tekstens overskrifter, eller planlæg en del, du endnu ikke har skrevet.", "Start with headings, or plan a part not yet written.")),
        emptyHeadings,
        emptyBlank,
      ));
    }

    parts.forEach((p, i) => {
      const isSelected = p.id === this.selected;
      const btn = button(`part structure-card ${isSelected ? "selected" : ""}`);
      btn.dataset.part = p.id;
      btn.dataset.select = p.id;
      btn.setAttribute("aria-current", isSelected ? "true" : "false");

      const role = model?.roles.find(r => r.id === p.role)?.name ?? p.role;
      const partText = doc.slice(p.contentFrom, p.contentTo).trim();
      const sub = el("small", "", `${role || tr("Ingen rolle", "No role")}${!partText ? " · " + tr("Planlagt", "Planned") : ""}`);
      if (p.note) {
        const noteDot = el("span", "note-dot", " ▤");
        noteDot.setAttribute("aria-label", tr("Har arbejdsnote", "Has working note"));
        noteDot.title = tr("Har arbejdsnote", "Has working note");
        sub.append(noteDot);
      }
      btn.append(
        el("span", "number", String(i + 1).padStart(2, "0")),
        el("span", "", el("strong", "", p.title || tr("Uden titel", "Untitled")), sub),
        el("span", "words", `${words(partText)} ${tr("ord", "words")}`),
      );
      btn.addEventListener("click", () => {
        this.selected = p.id;
        this.editing = false;
        this.render(body);
      });
      nav.append(btn);
      if (isSelected) nav.append(this.details(body, p, i, parts.length, model));
    });

    body.append(tools, methodDiv, nav);

    if (this.view.state.readOnly) {
      body.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("button,input,textarea,select").forEach(el => {
        el.disabled = true;
      });
      const roNote = document.createElement("p");
      roNote.textContent = tr("Gå tilbage til nu for at ændre strukturen.", "Return to current version to edit structure.");
      body.append(roNote);
    }
  }

  /** Detaljerne for den valgte del: arbejdsnoten, eller felterne når delen redigeres, og handlingerne. */
  private details(body: HTMLElement, part: StructurePart, idx: number, total: number, model: ReturnType<typeof narrativeModel>): HTMLElement {
    const details = el("section", "details");
    details.id = "details";
    details.setAttribute("aria-label", tr("Valgt del", "Selected part"));

    if (this.editing) {
      const titleInput = el("input");
      titleInput.id = "edit-title";
      titleInput.maxLength = 240;
      titleInput.value = part.title;
      titleInput.dataset.field = "title";
      titleInput.addEventListener("input", () => {
        const change = editStructurePart(this.view.state.doc.toString(), part.id, { title: titleInput.value });
        if (change) applyStructure(this.view, change);
      });

      let roleField: HTMLInputElement | HTMLSelectElement;
      if (model) {
        const roleSelect = el("select");
        roleSelect.add(new Option(tr("Ingen rolle", "No role"), ""));
        for (const r of model.roles) roleSelect.add(new Option(r.name, r.id));
        if (part.role && !model.roles.some(r => r.id === part.role)) {
          roleSelect.add(new Option(part.role, part.role));
        }
        roleSelect.value = part.role;
        roleSelect.addEventListener("change", () => {
          const change = editStructurePart(this.view.state.doc.toString(), part.id, { role: roleSelect.value });
          if (change) applyStructure(this.view, change);
        });
        roleField = roleSelect;
      } else {
        const roleInput = el("input");
        roleInput.maxLength = 80;
        roleInput.value = part.role;
        roleInput.addEventListener("input", () => {
          const change = editStructurePart(this.view.state.doc.toString(), part.id, { role: roleInput.value });
          if (change) applyStructure(this.view, change);
        });
        roleField = roleInput;
      }
      roleField.id = "edit-role";

      const noteArea = el("textarea");
      noteArea.id = "edit-note";
      noteArea.maxLength = 10000;
      noteArea.value = part.note;
      noteArea.dataset.field = "note";
      noteArea.addEventListener("input", () => {
        const change = editStructurePart(this.view.state.doc.toString(), part.id, { note: noteArea.value });
        if (change) applyStructure(this.view, change);
      });

      const dissolveBtn = button("rp-btn", tr("Opløs del", "Ungroup"), "dissolve");
      dissolveBtn.addEventListener("click", () => {
        applyStructure(this.view, removeStructurePart(this.view.state.doc.toString(), part.id));
        this.refresh();
      });

      details.append(el("div", "edit-form",
        el("label", "field", tr("Arbejdsnavn", "Working title"), titleInput),
        el("label", "field", tr("Rolle", "Role"), roleField),
        el("label", "field", tr("Arbejdsnote", "Working note"), noteArea),
        el("span", "hidden-note", tr("Arbejdsnoten er kun til dig.", "Working note is for you only.")),
        dissolveBtn,
      ));
    } else {
      details.append(el("p", "", part.note || tr("Ingen arbejdsnote endnu.", "No working note yet.")));
    }

    const goBtn = button("rp-btn", tr("Gå til teksten", "Go to text"), "go-text");
    goBtn.addEventListener("click", () => this.goText(part.id));

    const editToggle = button("rp-btn", this.editing ? tr("Luk", "Close") : tr("Redigér", "Edit"), "edit-toggle");
    editToggle.setAttribute("aria-label", this.editing ? tr("Luk redigering", "Close editing") : tr("Redigér del", "Edit part"));
    editToggle.setAttribute("aria-expanded", String(this.editing));
    editToggle.addEventListener("click", () => {
      this.editing = !this.editing;
      this.render(body);
      body.querySelector<HTMLElement>(this.editing ? "#edit-title" : "#edit-toggle")?.focus();
    });

    const moveUp = button("rp-btn move", "↑", "move-up");
    moveUp.setAttribute("aria-label", tr("Flyt del op", "Move part up"));
    moveUp.disabled = idx === 0;
    moveUp.addEventListener("click", () => this.move(part.id, -1));

    const moveDown = button("rp-btn move", "↓", "move-down");
    moveDown.setAttribute("aria-label", tr("Flyt del ned", "Move part down"));
    moveDown.disabled = idx === total - 1;
    moveDown.addEventListener("click", () => this.move(part.id, 1));

    details.append(el("div", "row detail-actions", goBtn, editToggle, moveUp, moveDown));
    return details;
  }

  private updateInPlace(doc: string, parts: StructurePart[]): void {
    if (!this.body) return;
    const countEl = this.body.querySelector<HTMLElement>("#part-count");
    if (countEl) countEl.textContent = partCount(parts.length);

    for (const part of parts) {
      const btn = this.body.querySelector<HTMLElement>(`[data-select="${part.id}"]`);
      if (btn) {
        const text = doc.slice(part.contentFrom, part.contentTo).trim();
        const wordEl = btn.querySelector<HTMLElement>(".words");
        const wCount = `${words(text)} ${tr("ord", "words")}`;
        if (wordEl && wordEl.textContent !== wCount) wordEl.textContent = wCount;
        const strong = btn.querySelector<HTMLElement>("strong");
        if (strong && strong.textContent !== part.title) strong.textContent = part.title || tr("Uden titel", "Untitled");
      }
    }

    const activePart = parts.find(p => p.id === this.selected);
    if (activePart) {
      if (!this.editing) {
        const p = this.body.querySelector<HTMLElement>(".details p");
        const expected = activePart.note || tr("Ingen arbejdsnote endnu.", "No working note yet.");
        if (p && p.textContent !== expected) p.textContent = expected;
      }
    }

    if (this.boardDialog?.open) this.renderBoard();
  }

  private move(id: string, direction: -1 | 1): void {
    if (movePart(this.view, id, direction)) {
      this.selected = id;
      this.refresh();
      if (this.boardDialog?.open) this.renderBoard();
    } else {
      showBanner(tr("Gruppér teksten mellem delene, før du flytter dem.", "Group the text between these parts before moving them."));
    }
  }

  private goText(id: string): void {
    if (this.boardDialog?.open) this.boardDialog.close();
    const doc = this.view.state.doc.toString();
    const current = structureParts(doc).find(p => p.id === id);
    if (!current) return;
    if (current.contentFrom === current.contentTo) {
      applyStructure(this.view, { from: current.contentFrom, insert: "\n" });
    }
    this.view.dispatch({ selection: { anchor: current.contentFrom }, scrollIntoView: true });
    this.view.focus();
  }

  private addBlank(): void {
    const text = this.view.state.doc.toString();
    // Før fraklip, kilder og fodnoter sidst i filen: ellers står delen uden for selve teksten.
    const at = bodyEnd(text);
    const changes = addStructurePart(text, at, at, tr("Ny del", "New part"));
    if (changes) {
      applyStructure(this.view, changes);
      const parts = structureParts(this.view.state.doc.toString());
      const last = parts.at(-1);
      if (last) {
        this.selected = last.id;
        this.editing = true;
      }
      this.addDialog?.close();
      this.refresh();
      this.body?.querySelector<HTMLInputElement>("#edit-title")?.select();
    }
  }

  private headings(): void {
    const doc = this.view.state.doc.toString();
    const candidates = headingGroups(doc);
    if (!candidates.length || candidates.some(c => !c.changes)) {
      showBanner(tr("Ingen hele, ugrupperede overskriftsafsnit at opdele.", "No complete ungrouped sections to split."));
      return;
    }
    this.addDialog?.close();
    this.headingProposal = { doc, candidates };
    this.headingDialog?.querySelector<HTMLElement>("#heading-preview")?.replaceChildren(...candidates.map(c => el("li", "", c.title)));
    const useBtn = this.headingDialog?.querySelector<HTMLButtonElement>("#use-headings");
    if (useBtn) useBtn.textContent = tr(`Opret ${candidates.length} dele`, `Create ${candidates.length} parts`);
    this.headingDialog?.showModal();
  }

  private useHeadings(): void {
    const proposal = this.headingProposal;
    if (!proposal) return;
    if (this.view.state.doc.toString() !== proposal.doc) {
      showBanner(tr("Teksten er ændret, mens vinduet var åbent. Prøv igen.", "The text changed while the window was open. Try again."));
      this.headingDialog?.close();
      return;
    }
    applyStructure(this.view, proposal.candidates.flatMap(c => c.changes!));
    this.headingDialog?.close();
    this.refresh();
  }

  private initDialogs(): void {
    if (typeof document === "undefined") return;

    // 1. Tilføj dele
    const addD = el("dialog", "structure-dialog small-dialog");
    addD.id = "add-dialog";
    const addBlank = choice(tr("Ny, tom del", "New empty part"), tr("Giv en kommende del en plads i teksten.", "Reserve a place in the text for an upcoming section."), "add-blank");
    addBlank.addEventListener("click", () => this.addBlank());
    const fromHeadings = choice(tr("Fra tekstens overskrifter", "From document headings"), tr("Se opdelingen, før du bruger den.", "Preview the split before applying it."), "from-headings");
    fromHeadings.addEventListener("click", () => this.headings());
    addD.append(
      el("header", "", el("h2", "", tr("Tilføj dele", "Add parts")), closeCross(addD)),
      el("div", "modal-body", addBlank, fromHeadings, el("p", "", tr("Gruppér markering ligger i skrivefladens markeringsmenu.", "Group selection is in the editor selection menu."))),
    );
    document.body.append(addD);
    this.addDialog = addD;

    // 2. Opdel fra overskrifter
    const headD = el("dialog", "structure-dialog small-dialog");
    headD.id = "heading-dialog";
    const preview = el("ol");
    preview.id = "heading-preview";
    const cancelHeadings = button("outline", tr("Annullér", "Cancel"));
    cancelHeadings.dataset.close = "";
    cancelHeadings.addEventListener("click", () => headD.close());
    const useHeadings = button("primary", tr("Opret dele", "Create parts"), "use-headings");
    useHeadings.addEventListener("click", () => this.useHeadings());
    headD.append(
      el("header", "", el("h2", "", tr("Opdel fra overskrifter", "Split from headings")), closeCross(headD)),
      el("div", "modal-body", el("p", "", tr("Overskriftsafsnittene bliver til dele. Brødteksten beholder sin rækkefølge.", "Heading sections become parts. Text order is preserved.")), preview),
      el("footer", "", cancelHeadings, useHeadings),
    );
    document.body.append(headD);
    this.headingDialog = headD;

    // 3. Stort overblik
    const board = el("dialog", "structure-dialog");
    board.id = "board";
    const boardTitle = el("h2");
    boardTitle.id = "board-title";
    const boardSummary = el("p");
    boardSummary.id = "board-summary";
    const readToggle = button("", tr("Vis teksten", "Show text"), "board-read-toggle");
    readToggle.setAttribute("aria-controls", "board-detail");
    readToggle.setAttribute("aria-expanded", "false");
    const boardUndo = button("outline", tr("Fortryd", "Undo"), "board-undo");
    const boardClose = button("outline", `${tr("Luk", "Close")} `);
    boardClose.dataset.close = "";
    boardClose.setAttribute("aria-label", tr("Luk", "Close"));
    boardClose.append(decoration("×"));
    const grid = el("nav", "board-grid");
    grid.id = "board-grid";
    grid.setAttribute("aria-label", tr("Flytbare dele", "Movable parts"));
    const boardDetail = el("section", "board-detail");
    boardDetail.id = "board-detail";
    boardDetail.setAttribute("aria-label", tr("Læs den valgte del", "Read selected part"));
    const boardGo = button("primary", tr("Gå til teksten", "Go to text"), "board-go");
    // Mellemrummene mellem knapperne står med vilje: rækken er ikke flex, så de giver luften.
    board.append(
      el("header", "", el("div", "", boardTitle, boardSummary), el("div", "row", readToggle, " ", boardUndo, " ", boardClose)),
      el("div", "board-body", grid, boardDetail),
      el("footer", "", el("span", "muted grow board-hint", tr("Træk et kort, eller brug Flyt op og Flyt ned ved den valgte del.", "Drag a card or use Move up/Move down on selected part.")), boardGo),
    );
    const closeBoard = () => {
      board.close();
      this.body?.querySelector<HTMLElement>("#open-board")?.focus();
    };
    boardClose.addEventListener("click", closeBoard);
    board.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeBoard();
      }
    });
    boardUndo.addEventListener("click", () => {
      undo(this.view);
      this.refresh();
      this.renderBoard();
    });
    readToggle.addEventListener("click", () => {
      const reading = board.classList.toggle("reading");
      readToggle.textContent = reading ? tr("Vis kortene", "Show cards") : tr("Vis teksten", "Show text");
      readToggle.setAttribute("aria-expanded", String(reading));
    });
    boardGo.addEventListener("click", () => {
      if (this.selected) this.goText(this.selected);
    });

    grid.addEventListener("dragstart", e => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-select]");
      this.dragged = target?.dataset.select ?? null;
      if (e.dataTransfer && this.dragged) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", this.dragged);
      }
    });
    grid.addEventListener("dragover", e => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-select]");
      if (target) {
        e.preventDefault();
        grid.querySelectorAll(".drag-over").forEach(c => c.classList.remove("drag-over"));
        target.classList.add("drag-over");
      }
    });
    grid.addEventListener("drop", e => {
      e.preventDefault();
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-select]");
      const targetId = target?.dataset.select;
      grid.querySelectorAll(".drag-over").forEach(c => c.classList.remove("drag-over"));
      if (!targetId || !this.dragged || targetId === this.dragged) return;

      const doc = this.view.state.doc.toString();
      const parts = structureParts(doc);
      const fromIdx = parts.findIndex(p => p.id === this.dragged);
      const toIdx = parts.findIndex(p => p.id === targetId);
      if (fromIdx !== -1 && toIdx !== -1) {
        // Hele trækket som én ændring, så Fortryd tager det hele tilbage.
        if (!movePartTo(this.view, this.dragged, toIdx)) {
          showBanner(tr("Delen kan ikke flyttes dertil, fordi der står tekst uden for delene imellem.", "The part cannot be moved there because there is text outside the parts in between."));
        }
        this.selected = this.dragged;
        this.refresh();
        this.renderBoard();
      }
    });
    grid.addEventListener("dragend", () => {
      grid.querySelectorAll(".drag-over").forEach(c => c.classList.remove("drag-over"));
      this.dragged = null;
    });

    document.body.append(board);
    this.boardDialog = board;

    // 4. Fortællemetode
    const methodsD = el("dialog", "structure-dialog");
    methodsD.id = "methods";
    const categories = el("nav", "categories");
    categories.id = "categories";
    categories.setAttribute("aria-label", tr("Teksttype", "Text type"));
    const methodChoices = el("div", "method-choices");
    methodChoices.id = "method-choices";
    const modelDescription = el("div");
    modelDescription.id = "model-description";
    const chosenLabel = el("span");
    chosenLabel.id = "chosen-label";
    const recommend = button("outline", tr("Bed AI om et forslag", "Ask AI for suggestion"), "recommend");
    recommend.addEventListener("click", () => {
      methodsD.close();
      void this.analyse(this.chosenModel);
    });
    const useMethod = button("primary", tr("Brug metoden", "Use method"), "use-method");
    useMethod.addEventListener("click", () => {
      applyStructure(this.view, setStructureModel(this.view.state.doc.toString(), this.chosenModel));
      methodsD.close();
      this.refresh();
    });
    methodsD.append(
      el("header", "",
        el("div", "", el("h2", "", tr("Find en form, der passer", "Find a suitable form")), el("p", "", tr("Metoden giver delene roller. Du bestemmer rækkefølgen.", "The method gives parts roles. You decide the order."))),
        closeCross(methodsD),
      ),
      el("div", "modal-body", categories, methodChoices, modelDescription),
      el("footer", "", chosenLabel, recommend, useMethod),
    );
    document.body.append(methodsD);
    this.methodsDialog = methodsD;

    // 5. AI-forslaget
    const propD = el("dialog", "structure-dialog small-dialog");
    propD.id = "proposal";
    const proposalTitle = el("h2");
    proposalTitle.id = "proposal-title";
    const proposalReason = el("p");
    proposalReason.id = "proposal-reason";
    const proposalList = el("ul", "proposal-list");
    proposalList.id = "proposal-list";
    const dismiss = button("outline", tr("Læg væk", "Dismiss"));
    dismiss.dataset.close = "";
    dismiss.addEventListener("click", () => propD.close());
    const accept = button("primary", tr("Brug roller og noter", "Use roles and notes"), "accept-proposal");
    propD.append(
      el("header", "", el("div", "", el("div", "proposal-role proposal-eyebrow", tr("AI-forslag", "AI Suggestion")), proposalTitle), closeCross(propD)),
      el("div", "modal-body",
        proposalReason,
        proposalList,
        el("p", "proposal-footnote", tr("Forslaget sætter roller og arbejdsnoter. Det flytter eller ændrer ingen brødtekst.", "Suggestion sets roles and notes. It does not move or modify text.")),
      ),
      el("footer", "", dismiss, accept),
    );
    accept.addEventListener("click", () => {
      if (!this.proposal) return;
      if (this.view.state.doc.toString() !== this.proposal.doc) {
        showBanner(tr("Teksten er ændret. Bed om et nyt forslag.", "Text has changed. Ask for a new suggestion."));
        propD.close();
        return;
      }
      const changes: StructureChange[] = [];
      const context = structureContext(this.proposal.doc);
      const parts = structureParts(this.proposal.doc);
      // I tekstens rækkefølge, ikke AI'ens: to dele, der støder op til hinanden, får ellers deres
      // markører i forkert orden på samme sted.
      const candidates = this.proposal.candidates;
      const order = (id: string) => { const i = candidates.findIndex(c => c.id === id); return i < 0 ? Infinity : i; };
      for (const p of [...this.proposal.value.parts].sort((a, b) => order(a.id) - order(b.id))) {
        const candidate = candidates.find(c => c.id === p.id);
        if (candidate) {
          const c = addStructurePart(this.proposal.doc, candidate.from, candidate.to, candidate.title, p.role, p.note, context);
          if (c) changes.push(...c);
        } else {
          const c = editStructurePart(this.proposal.doc, p.id, { role: p.role, note: p.note }, parts);
          if (c) changes.push(c);
        }
      }
      changes.push(setStructureModel(this.proposal.doc, this.proposal.value.model));
      this.proposal = null;
      applyStructure(this.view, changes);
      propD.close();
      this.refresh();
    });
    document.body.append(propD);
    this.proposalDialog = propD;
  }

  private renderBoard(): void {
    if (!this.boardDialog) return;
    const doc = this.view.state.doc.toString();
    const parts = structureParts(doc);
    const plan = structurePlan(doc);
    const model = narrativeModel(plan?.model ?? "");
    const activePart = parts.find(p => p.id === this.selected) ?? parts[0];
    const totalWords = parts.reduce((acc, p) => acc + words(doc.slice(p.contentFrom, p.contentTo)), 0);

    const titleEl = this.boardDialog.querySelector<HTMLElement>("#board-title");
    if (titleEl) {
      const firstLine = withoutParked(doc).trim().split("\n")[0] || tr("Dokument", "Document");
      titleEl.textContent = firstLine.replace(/^#+\s*/, "");
    }
    const sumEl = this.boardDialog.querySelector<HTMLElement>("#board-summary");
    if (sumEl) {
      sumEl.textContent = `${parts.length} ${tr("dele", "parts")} · ${totalWords} ${tr("ord", "words")} · ${model?.name ?? tr("Fri opbygning", "Free structure")}`;
    }

    const grid = this.boardDialog.querySelector<HTMLElement>("#board-grid");
    if (grid) {
      grid.replaceChildren(...parts.map((p, i) => {
        const text = doc.slice(p.contentFrom, p.contentTo).trim();
        const role = model?.roles.find(r => r.id === p.role)?.name ?? p.role;
        // Mellemrummet mellem nummer og rolle står med vilje: rækken er ikke flex.
        const card = el("button", `board-card ${p.id === this.selected ? "selected" : ""}`,
          el("div", "row spread", el("span", "number", String(i + 1).padStart(2, "0")), " ", el("small", "", role || tr("Ingen rolle", "No role"))),
          el("h3", "", p.title || tr("Uden titel", "Untitled")),
          el("p", "", excerpt(text)),
          el("div", "row spread", el("span", "", `${words(text)} ${tr("ord", "words")}`), el("span", "", p.note ? tr("Arbejdsnote", "Working note") : "")),
        );
        card.type = "button";
        card.draggable = true;
        card.dataset.select = p.id;
        card.setAttribute("aria-pressed", String(p.id === this.selected));
        card.addEventListener("click", () => {
          this.selected = p.id;
          this.renderBoard();
          this.refresh();
        });
        return card;
      }));
    }

    const detail = this.boardDialog.querySelector<HTMLElement>("#board-detail");
    if (detail) {
      if (activePart) {
        const text = doc.slice(activePart.contentFrom, activePart.contentTo).trim();
        const role = model?.roles.find(r => r.id === activePart.role)?.name ?? activePart.role;
        const idx = parts.indexOf(activePart);
        detail.replaceChildren(
          el("small", "", `${tr("DEL", "PART")} ${idx + 1} · ${role || tr("Ingen rolle", "No role")}`),
          el("h3", "", activePart.title || tr("Uden titel", "Untitled")),
        );
        if (text) detail.append(...text.split("\n\n").map(t => el("p", "", t)));
        else detail.append(el("p", "muted", tr("Denne del er endnu ikke skrevet.", "This part is not yet written.")));
        if (activePart.note) detail.append(el("div", "note", el("strong", "", tr("Arbejdsnote", "Working note")), activePart.note));
        const up = button("outline", tr("Flyt op", "Move up"), "board-up");
        up.disabled = idx === 0;
        up.addEventListener("click", () => this.move(activePart.id, -1));
        const down = button("outline", tr("Flyt ned", "Move down"), "board-down");
        down.disabled = idx === parts.length - 1;
        down.addEventListener("click", () => this.move(activePart.id, 1));
        detail.append(el("div", "row board-moves", up, " ", down));
      } else {
        detail.replaceChildren(el("p", "", tr("Tilføj en del for at se den her.", "Add a part to view it here.")));
      }
    }
  }

  private renderMethods(): void {
    if (!this.methodsDialog) return;
    const catNav = this.methodsDialog.querySelector<HTMLElement>("#categories");
    catNav?.replaceChildren(...MODEL_GROUPS.map((g, i) => {
      const b = button("", g);
      b.setAttribute("aria-pressed", String(i === this.category));
      b.dataset.category = String(i);
      b.addEventListener("click", () => {
        this.category = i;
        this.renderMethods();
      });
      return b;
    }));

    const choices = this.methodsDialog.querySelector<HTMLElement>("#method-choices");
    if (choices) {
      const currentGroup = MODEL_GROUPS[this.category];
      const options = [
        { id: "", name: tr("Fri opbygning", "Free structure"), description: tr("Arbejd med egne roller og din egen rækkefølge.", "Work with your own roles and order.") },
        ...NARRATIVE_MODELS.filter(m => m.groups.includes(currentGroup)),
      ];
      choices.replaceChildren(...options.map(o => {
        const b = choice(o.name, o.description);
        if (this.chosenModel === o.id) b.classList.add("selected");
        b.dataset.model = o.id;
        b.addEventListener("click", () => {
          this.chosenModel = o.id;
          this.renderMethods();
        });
        return b;
      }));
    }

    const m = narrativeModel(this.chosenModel);
    const chosenLabel = this.methodsDialog.querySelector<HTMLElement>("#chosen-label");
    if (chosenLabel) chosenLabel.textContent = `${tr("Valgt", "Selected")}: ${m?.name ?? tr("Fri opbygning", "Free structure")}`;

    const desc = this.methodsDialog.querySelector<HTMLElement>("#model-description");
    desc?.replaceChildren(...(m ? [el("p", "", el("strong", "", m.name), el("br"), el("span", "model-roles", m.roles.map(r => r.name).join(" → ")))] : []));
  }

  private refresh(): void {
    // Kun når Struktur stadig er fanen: et AI-svar kan komme, efter brugeren har skiftet fane.
    if (this.body?.dataset.tab === "struktur") {
      this.render(this.body);
    }
  }

  private async analyse(model: string): Promise<void> {
    if (this.busy || this.view.state.readOnly) return;
    this.busy = true;
    try {
      if (!await this.allowed()) return;
      const generation = this.documentGeneration;
      const doc = this.view.state.doc.toString();
      this.proposal = null;
      this.refresh();

      const parts = structureParts(doc).map(p => ({
        id: p.id,
        title: p.title,
        text: withoutParked(doc.slice(p.contentFrom, p.contentTo)),
      }));

      const candidates: { id: string; title: string; from: number; to: number }[] = [];
      if (model && !parts.length) {
        const parsed = structureCandidates(this.view.state);
        if (!parsed) {
          showBanner(tr("Teksten er stadig ved at blive læst. Prøv igen om et øjeblik.", "The text is still being parsed. Try again in a moment."));
          return;
        }
        candidates.push(...parsed);
        for (const candidate of candidates) {
          parts.push({ id: candidate.id, title: candidate.title, text: withoutParked(doc.slice(candidate.from, candidate.to)) });
        }
      }

      const value = await invoke<Suggestion>("structure_suggest", { text: withoutParked(doc), parts, model });
      if (generation === this.documentGeneration) {
        this.proposal = { doc, value, candidates };
        this.showProposalDialog();
      }
    } catch (e) {
      showBanner(errorText(e));
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private showProposalDialog(): void {
    if (!this.proposal || !this.proposalDialog) return;
    const { value, doc, candidates } = this.proposal;
    const parts = structureParts(doc);
    const m = narrativeModel(value.model);

    const titleEl = this.proposalDialog.querySelector<HTMLElement>("#proposal-title");
    if (titleEl) titleEl.textContent = `${tr("Prøv", "Try")} ${m?.name ?? value.model}`;
    const reasonEl = this.proposalDialog.querySelector<HTMLElement>("#proposal-reason");
    if (reasonEl) reasonEl.textContent = value.reason;

    // Modellens svar er data: roller og noter vises som tekst, aldrig som HTML.
    this.proposalDialog.querySelector<HTMLElement>("#proposal-list")?.replaceChildren(...value.parts.map(p => {
      const title = parts.find(x => x.id === p.id)?.title ?? candidates.find(x => x.id === p.id)?.title ?? p.id;
      const role = m?.roles.find(r => r.id === p.role)?.name ?? p.role;
      const li = el("li", "", el("strong", "", title), el("div", "proposal-role", role));
      if (p.note) li.append(el("p", "", p.note));
      return li;
    }));
    this.proposalDialog.showModal();
  }
}
