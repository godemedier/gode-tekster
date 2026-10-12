import type { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { invoke } from "@tauri-apps/api/core";
import { addStructurePart, editStructurePart, removeStructurePart, setStructureModel, structureParts, structurePlan, structureContext, type StructureChange } from "../editor/structure.ts";
import { withoutParked } from "../editor/parked.ts";
import { bodyEnd } from "../editor/outline.ts";
import { MODEL_GROUPS, NARRATIVE_MODELS, narrativeModel } from "./models.ts";
import { applyStructure, groupSelection, headingGroups, movePart, movePartTo, structureCandidates } from "./edit.ts";
import { errorText, showBanner } from "../ui/banner.ts";
import { locale, tr } from "../i18n.ts";

const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));

const excerpt = (text: string) => {
  const visible = withoutParked(text).trim();
  return visible ? visible.slice(0, 160) + (visible.length > 160 ? "…" : "") : tr("Planlagt del", "Planned part");
};

const words = (text: string) => {
  const visible = withoutParked(text).trim();
  return visible ? visible.split(/\s+/u).length : 0;
};

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

  // Dialog-elementer
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

    // DOM-genbrug under skrivning
    const listEl = body.querySelector<HTMLElement>("#parts");
    if (!this.proposal && key === this.renderKey && listEl) {
      this.updateInPlace(doc, parts);
      return;
    }
    this.renderKey = key;

    const totalWords = parts.reduce((acc, p) => acc + words(doc.slice(p.contentFrom, p.contentTo)), 0);

    body.replaceChildren();

    // 1. Heading
    const heading = document.createElement("div");
    heading.className = "heading";
    const headRow = document.createElement("div");
    headRow.className = "row";
    const h2 = document.createElement("h2");
    h2.textContent = tr("Tekstens dele", "Document parts");
    const countSmall = document.createElement("small");
    countSmall.id = "part-count";
    countSmall.textContent = parts.length ? ` · ${parts.length}` : "";
    h2.append(countSmall);

    const addBtn = document.createElement("button");
    addBtn.id = "add";
    addBtn.className = "icon";
    addBtn.type = "button";
    addBtn.setAttribute("aria-label", tr("Tilføj del", "Add part"));
    addBtn.title = tr("Tilføj del", "Add part");
    addBtn.textContent = "+";
    addBtn.onclick = () => this.addDialog?.showModal();
    headRow.append(h2, addBtn);

    const openBoardBtn = document.createElement("button");
    openBoardBtn.id = "open-board";
    openBoardBtn.className = "overview";
    openBoardBtn.type = "button";
    openBoardBtn.innerHTML = `${tr("Stort overblik", "Wide overview")} <span aria-hidden="true">↗</span>`;
    openBoardBtn.onclick = () => {
      this.renderBoard();
      this.boardDialog?.showModal();
    };

    heading.append(headRow, openBoardBtn);

    // 2. Metodelinje
    const methodDiv = document.createElement("div");
    methodDiv.className = "method";
    const methodBtn = document.createElement("button");
    methodBtn.id = "open-method";
    methodBtn.type = "button";
    const methodSpan = document.createElement("span");
    const methodSmall = document.createElement("small");
    methodSmall.textContent = tr("Fortællemetode", "Narrative method");
    const methodName = document.createElement("span");
    methodName.id = "method-name";
    methodName.textContent = model?.name ?? tr("Fri opbygning", "Free structure");
    methodSpan.append(methodSmall, methodName);
    const chevron = document.createElement("span");
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "⌄";
    methodBtn.append(methodSpan, chevron);
    methodBtn.onclick = () => {
      this.chosenModel = plan?.model ?? "";
      this.renderMethods();
      this.methodsDialog?.showModal();
    };
    methodDiv.append(methodBtn);

    // 3. Liste over dele
    const nav = document.createElement("nav");
    nav.id = "parts";
    nav.className = "list";
    nav.setAttribute("aria-label", tr("Tekstens rækkefølge", "Document order"));

    if (!parts.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      const eh3 = document.createElement("h3");
      eh3.textContent = tr("Giv teksten en opbygning", "Give the text structure");
      const ep = document.createElement("p");
      ep.textContent = tr("Start med tekstens overskrifter, eller planlæg en del, du endnu ikke har skrevet.", "Start with headings, or plan a part not yet written.");
      const emptyHeadings = document.createElement("button");
      emptyHeadings.id = "empty-headings";
      emptyHeadings.className = "primary";
      emptyHeadings.type = "button";
      emptyHeadings.textContent = tr("Fra overskrifter …", "From headings …");
      emptyHeadings.onclick = () => this.headings();
      const emptyBlank = document.createElement("button");
      emptyBlank.id = "empty-blank";
      emptyBlank.className = "outline";
      emptyBlank.type = "button";
      emptyBlank.textContent = tr("Ny, tom del", "New empty part");
      emptyBlank.onclick = () => this.addBlank();
      empty.append(eh3, ep, emptyHeadings, emptyBlank);
      nav.append(empty);
    } else {
      parts.forEach((p, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `part structure-card ${p.id === this.selected ? "selected" : ""}`;
        btn.dataset.part = p.id;
        btn.dataset.select = p.id;
        btn.setAttribute("aria-current", p.id === this.selected ? "true" : "false");

        const num = document.createElement("span");
        num.className = "number";
        num.textContent = String(i + 1).padStart(2, "0");

        const content = document.createElement("span");
        const titleEl = document.createElement("strong");
        titleEl.textContent = p.title || tr("Uden titel", "Untitled");
        const sub = document.createElement("small");
        const role = model?.roles.find(r => r.id === p.role)?.name ?? p.role;
        const partText = doc.slice(p.contentFrom, p.contentTo).trim();
        sub.textContent = `${role || tr("Ingen rolle", "No role")}${!partText ? " · " + tr("Planlagt", "Planned") : ""}`;
        if (p.note) {
          const noteDot = document.createElement("span");
          noteDot.className = "note-dot";
          noteDot.setAttribute("aria-label", tr("Har arbejdsnote", "Has working note"));
          noteDot.title = tr("Har arbejdsnote", "Has working note");
          noteDot.textContent = " ▤";
          sub.append(noteDot);
        }
        content.append(titleEl, sub);

        const wordEl = document.createElement("span");
        wordEl.className = "words";
        wordEl.textContent = `${words(partText)} ${tr("ord", "words")}`;

        btn.append(num, content, wordEl);
        btn.onclick = () => {
          this.selected = p.id;
          this.editing = false;
          this.render(body);
        };
        nav.append(btn);
      });
    }

    // 4. Detaljesektion for valgt del
    const details = document.createElement("section");
    details.id = "details";
    details.className = "details";
    details.setAttribute("aria-label", tr("Valgt del", "Selected part"));

    const activePart = parts.find(p => p.id === this.selected);
    if (activePart) {
      const idx = parts.indexOf(activePart);
      const row = document.createElement("div");
      row.className = "row spread";
      const eyebrow = document.createElement("span");
      eyebrow.className = "eyebrow";
      eyebrow.textContent = `${tr("Del", "Part")} ${idx + 1} ${tr("af", "of")} ${parts.length}`;

      const editToggle = document.createElement("button");
      editToggle.id = "edit-toggle";
      editToggle.className = "icon";
      editToggle.type = "button";
      editToggle.setAttribute("aria-label", this.editing ? tr("Luk redigering", "Close editing") : tr("Redigér del", "Edit part"));
      editToggle.setAttribute("aria-expanded", String(this.editing));
      editToggle.textContent = this.editing ? "×" : "···";
      editToggle.onclick = () => {
        this.editing = !this.editing;
        this.render(body);
        if (this.editing) {
          body.querySelector<HTMLInputElement>("#edit-title")?.focus();
        } else {
          body.querySelector<HTMLElement>("#edit-toggle")?.focus();
        }
      };
      row.append(eyebrow, editToggle);

      const dTitle = document.createElement("div");
      dTitle.className = "detail-title";
      dTitle.textContent = activePart.title || tr("Uden titel", "Untitled");

      details.append(row, dTitle);

      if (this.editing) {
        const form = document.createElement("div");
        form.className = "edit-form";

        const titleLabel = document.createElement("label");
        titleLabel.className = "field";
        titleLabel.textContent = tr("Arbejdsnavn", "Working title");
        const titleInput = document.createElement("input");
        titleInput.id = "edit-title";
        titleInput.maxLength = 240;
        titleInput.value = activePart.title;
        titleInput.dataset.field = "title";
        titleInput.oninput = () => {
          const change = editStructurePart(this.view.state.doc.toString(), activePart.id, { title: titleInput.value });
          if (change) applyStructure(this.view, change);
        };
        titleLabel.append(titleInput);

        const roleLabel = document.createElement("label");
        roleLabel.className = "field";
        roleLabel.textContent = tr("Rolle", "Role");
        if (model) {
          const roleSelect = document.createElement("select");
          roleSelect.id = "edit-role";
          roleSelect.add(new Option(tr("Ingen rolle", "No role"), ""));
          for (const r of model.roles) roleSelect.add(new Option(r.name, r.id));
          if (activePart.role && !model.roles.some(r => r.id === activePart.role)) {
            roleSelect.add(new Option(activePart.role, activePart.role));
          }
          roleSelect.value = activePart.role;
          roleSelect.onchange = () => {
            const change = editStructurePart(this.view.state.doc.toString(), activePart.id, { role: roleSelect.value });
            if (change) applyStructure(this.view, change);
          };
          roleLabel.append(roleSelect);
        } else {
          const roleInput = document.createElement("input");
          roleInput.id = "edit-role";
          roleInput.maxLength = 80;
          roleInput.value = activePart.role;
          roleInput.oninput = () => {
            const change = editStructurePart(this.view.state.doc.toString(), activePart.id, { role: roleInput.value });
            if (change) applyStructure(this.view, change);
          };
          roleLabel.append(roleInput);
        }

        const noteLabel = document.createElement("label");
        noteLabel.className = "field";
        noteLabel.textContent = tr("Arbejdsnote", "Working note");
        const noteArea = document.createElement("textarea");
        noteArea.id = "edit-note";
        noteArea.maxLength = 10000;
        noteArea.value = activePart.note;
        noteArea.dataset.field = "note";
        noteArea.oninput = () => {
          const change = editStructurePart(this.view.state.doc.toString(), activePart.id, { note: noteArea.value });
          if (change) applyStructure(this.view, change);
        };
        noteLabel.append(noteArea);

        const hiddenNote = document.createElement("span");
        hiddenNote.className = "hidden-note";
        hiddenNote.textContent = tr("Arbejdsnoten er kun til dig.", "Working note is for you only.");

        const dissolveBtn = document.createElement("button");
        dissolveBtn.id = "dissolve";
        dissolveBtn.className = "outline";
        dissolveBtn.type = "button";
        dissolveBtn.textContent = tr("Opløs del", "Ungroup");
        dissolveBtn.onclick = () => {
          applyStructure(this.view, removeStructurePart(this.view.state.doc.toString(), activePart.id));
          this.refresh();
        };

        form.append(titleLabel, roleLabel, noteLabel, hiddenNote, dissolveBtn);
        details.append(form);
      } else {
        const noteP = document.createElement("p");
        noteP.textContent = activePart.note || tr("Ingen arbejdsnote endnu.", "No working note yet.");
        details.append(noteP);
      }

      const actions = document.createElement("div");
      actions.className = "row detail-actions";
      const goBtn = document.createElement("button");
      goBtn.id = "go-text";
      goBtn.className = "outline";
      goBtn.type = "button";
      goBtn.textContent = tr("Gå til teksten", "Go to text");
      goBtn.onclick = () => this.goText(activePart.id);

      const moveUp = document.createElement("button");
      moveUp.id = "move-up";
      moveUp.type = "button";
      moveUp.setAttribute("aria-label", tr("Flyt del op", "Move part up"));
      moveUp.textContent = "↑";
      moveUp.disabled = idx === 0;
      moveUp.onclick = () => this.move(activePart.id, -1);

      const moveDown = document.createElement("button");
      moveDown.id = "move-down";
      moveDown.type = "button";
      moveDown.setAttribute("aria-label", tr("Flyt del ned", "Move part down"));
      moveDown.textContent = "↓";
      moveDown.disabled = idx === parts.length - 1;
      moveDown.onclick = () => this.move(activePart.id, 1);

      actions.append(goBtn, moveUp, moveDown);
      details.append(actions);
    } else {
      details.hidden = true;
    }

    // 5. Foot
    const foot = document.createElement("footer");
    foot.className = "foot";
    const footCount = document.createElement("span");
    footCount.id = "foot-count";
    footCount.textContent = `${parts.length} ${tr("dele", "parts")} · ${totalWords} ${tr("ord", "words")}`;

    const undoBtn = document.createElement("button");
    undoBtn.id = "undo";
    undoBtn.type = "button";
    undoBtn.textContent = tr("Fortryd", "Undo");
    undoBtn.onclick = () => {
      undo(this.view);
      this.refresh();
    };

    foot.append(footCount, undoBtn);

    body.append(heading, methodDiv, nav, details, foot);

    if (this.view.state.readOnly) {
      body.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("button,input,textarea,select").forEach(el => {
        el.disabled = true;
      });
      const roNote = document.createElement("p");
      roNote.textContent = tr("Gå tilbage til nu for at ændre strukturen.", "Return to current version to edit structure.");
      body.append(roNote);
    }
  }

  private updateInPlace(doc: string, parts: import("../editor/structure.ts").StructurePart[]): void {
    if (!this.body) return;
    const countSmall = this.body.querySelector<HTMLElement>("#part-count");
    if (countSmall) countSmall.textContent = parts.length ? ` · ${parts.length}` : "";
    const totalWords = parts.reduce((acc, p) => acc + words(doc.slice(p.contentFrom, p.contentTo)), 0);
    const footCount = this.body.querySelector<HTMLElement>("#foot-count");
    if (footCount) footCount.textContent = `${parts.length} ${tr("dele", "parts")} · ${totalWords} ${tr("ord", "words")}`;

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
      const dTitle = this.body.querySelector<HTMLElement>(".detail-title");
      if (dTitle && dTitle.textContent !== activePart.title) dTitle.textContent = activePart.title || tr("Uden titel", "Untitled");
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
    const list = this.headingDialog?.querySelector<HTMLElement>("#heading-preview");
    if (list) {
      list.innerHTML = candidates.map(c => `<li>${esc(c.title)}</li>`).join("");
    }
    const useBtn = this.headingDialog?.querySelector<HTMLButtonElement>("#use-headings");
    if (useBtn) {
      useBtn.textContent = tr(`Opret ${candidates.length} dele`, `Create ${candidates.length} parts`);
      useBtn.onclick = () => {
        if (this.view.state.doc.toString() !== doc) {
          showBanner(tr("Teksten er ændret, mens vinduet var åbent. Prøv igen.", "The text changed while the window was open. Try again."));
          this.headingDialog?.close();
          return;
        }
        applyStructure(this.view, candidates.flatMap(c => c.changes!));
        this.headingDialog?.close();
        this.refresh();
      };
    }
    this.headingDialog?.showModal();
  }

  private initDialogs(): void {
    if (typeof document === "undefined") return;

    // 1. Add Dialog
    const addD = document.createElement("dialog");
    addD.id = "add-dialog";
    addD.className = "structure-dialog small-dialog";
    addD.innerHTML = `
      <header>
        <h2>${tr("Tilføj dele", "Add parts")}</h2>
        <button type="button" data-close aria-label="${tr("Luk", "Close")}">×</button>
      </header>
      <div class="modal-body">
        <button type="button" class="choice" id="add-blank">
          <strong>${tr("Ny, tom del", "New empty part")}</strong>
          <small>${tr("Giv en kommende del en plads i teksten.", "Reserve a place in the text for an upcoming section.")}</small>
        </button>
        <button type="button" class="choice" id="from-headings">
          <strong>${tr("Fra tekstens overskrifter", "From document headings")}</strong>
          <small>${tr("Se opdelingen, før du bruger den.", "Preview the split before applying it.")}</small>
        </button>
        <p>${tr("Gruppér markering ligger i skrivefladens markeringsmenu.", "Group selection is in the editor selection menu.")}</p>
      </div>
    `;
    addD.querySelector("#add-blank")?.addEventListener("click", () => this.addBlank());
    addD.querySelector("#from-headings")?.addEventListener("click", () => this.headings());
    addD.querySelector("[data-close]")?.addEventListener("click", () => addD.close());
    document.body.append(addD);
    this.addDialog = addD;

    // 2. Heading Dialog
    const headD = document.createElement("dialog");
    headD.id = "heading-dialog";
    headD.className = "structure-dialog small-dialog";
    headD.innerHTML = `
      <header>
        <h2>${tr("Opdel fra overskrifter", "Split from headings")}</h2>
        <button type="button" data-close aria-label="${tr("Luk", "Close")}">×</button>
      </header>
      <div class="modal-body">
        <p>${tr("Overskriftsafsnittene bliver til dele. Brødteksten beholder sin rækkefølge.", "Heading sections become parts. Text order is preserved.")}</p>
        <ol id="heading-preview"></ol>
      </div>
      <footer>
        <button type="button" class="outline" data-close>${tr("Annuller", "Cancel")}</button>
        <button type="button" class="primary" id="use-headings">${tr("Opret dele", "Create parts")}</button>
      </footer>
    `;
    headD.querySelectorAll("[data-close]").forEach(el => el.addEventListener("click", () => headD.close()));
    document.body.append(headD);
    this.headingDialog = headD;

    // 3. Stort overblik (Board)
    const board = document.createElement("dialog");
    board.id = "board";
    board.className = "structure-dialog";
    board.innerHTML = `
      <header>
        <div>
          <h2 id="board-title"></h2>
          <p id="board-summary"></p>
        </div>
        <div class="row">
          <button type="button" id="board-read-toggle" aria-controls="board-detail" aria-expanded="false">${tr("Vis teksten", "Show text")}</button>
          <button type="button" class="outline" id="board-undo">${tr("Fortryd", "Undo")}</button>
          <button type="button" class="outline" data-close aria-label="${tr("Luk", "Close")}">${tr("Luk", "Close")} <span aria-hidden="true">×</span></button>
        </div>
      </header>
      <div class="board-body">
        <nav class="board-grid" id="board-grid" aria-label="${tr("Flytbare dele", "Movable parts")}"></nav>
        <section class="board-detail" id="board-detail" aria-label="${tr("Læs den valgte del", "Read selected part")}"></section>
      </div>
      <footer>
        <span class="muted grow" style="font-size:12px">${tr("Træk et kort, eller brug Flyt op og Flyt ned ved den valgte del.", "Drag a card or use Move up/Move down on selected part.")}</span>
        <button type="button" class="primary" id="board-go">${tr("Gå til teksten", "Go to text")}</button>
      </footer>
    `;
    board.querySelector("[data-close]")?.addEventListener("click", () => {
      board.close();
      this.body?.querySelector<HTMLElement>("#open-board")?.focus();
    });
    board.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.preventDefault();
        board.close();
        this.body?.querySelector<HTMLElement>("#open-board")?.focus();
      }
    });
    board.querySelector("#board-undo")?.addEventListener("click", () => {
      undo(this.view);
      this.refresh();
      this.renderBoard();
    });
    board.querySelector("#board-read-toggle")?.addEventListener("click", () => {
      const reading = board.classList.toggle("reading");
      const btn = board.querySelector<HTMLButtonElement>("#board-read-toggle");
      if (btn) {
        btn.textContent = reading ? tr("Vis kortene", "Show cards") : tr("Vis teksten", "Show text");
        btn.setAttribute("aria-expanded", String(reading));
      }
    });
    board.querySelector("#board-go")?.addEventListener("click", () => {
      if (this.selected) this.goText(this.selected);
    });

    const grid = board.querySelector<HTMLElement>("#board-grid");
    grid?.addEventListener("dragstart", e => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-select]");
      this.dragged = target?.dataset.select ?? null;
      if (e.dataTransfer && this.dragged) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", this.dragged);
      }
    });
    grid?.addEventListener("dragover", e => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-select]");
      if (target) {
        e.preventDefault();
        grid.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
        target.classList.add("drag-over");
      }
    });
    grid?.addEventListener("drop", e => {
      e.preventDefault();
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-select]");
      const targetId = target?.dataset.select;
      grid.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
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
    grid?.addEventListener("dragend", () => {
      grid.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
      this.dragged = null;
    });

    document.body.append(board);
    this.boardDialog = board;

    // 4. Methods Dialog
    const methodsD = document.createElement("dialog");
    methodsD.id = "methods";
    methodsD.className = "structure-dialog";
    methodsD.innerHTML = `
      <header>
        <div>
          <h2>${tr("Find en form, der passer", "Find a suitable form")}</h2>
          <p>${tr("Metoden giver delene roller. Du bestemmer rækkefølgen.", "The method gives parts roles. You decide the order.")}</p>
        </div>
        <button type="button" data-close aria-label="${tr("Luk", "Close")}">×</button>
      </header>
      <div class="modal-body">
        <nav id="categories" class="categories" aria-label="${tr("Teksttype", "Text type")}"></nav>
        <div id="method-choices" class="method-choices"></div>
        <div id="model-description" style="margin-top:16px"></div>
      </div>
      <footer>
        <span id="chosen-label" style="font-size:12px;margin-right:auto"></span>
        <button type="button" class="outline" id="recommend">${tr("Bed AI om et forslag", "Ask AI for suggestion")}</button>
        <button type="button" class="primary" id="use-method">${tr("Brug metoden", "Use method")}</button>
      </footer>
    `;
    methodsD.querySelector("[data-close]")?.addEventListener("click", () => methodsD.close());
    methodsD.querySelector("#recommend")?.addEventListener("click", () => {
      methodsD.close();
      void this.analyse(this.chosenModel);
    });
    methodsD.querySelector("#use-method")?.addEventListener("click", () => {
      applyStructure(this.view, setStructureModel(this.view.state.doc.toString(), this.chosenModel));
      methodsD.close();
      this.refresh();
    });
    document.body.append(methodsD);
    this.methodsDialog = methodsD;

    // 5. Proposal Dialog
    const propD = document.createElement("dialog");
    propD.id = "proposal";
    propD.className = "structure-dialog small-dialog";
    propD.innerHTML = `
      <header>
        <div>
          <div class="proposal-role" style="font-size:11px;font-weight:600;text-transform:uppercase">${tr("AI-forslag", "AI Suggestion")}</div>
          <h2 id="proposal-title"></h2>
        </div>
        <button type="button" data-close aria-label="${tr("Luk", "Close")}">×</button>
      </header>
      <div class="modal-body">
        <p id="proposal-reason" style="font-size:12px;color:var(--svag)"></p>
        <ul class="proposal-list" id="proposal-list"></ul>
        <p style="margin-top:14px;font-size:11px;color:var(--svag)">${tr("Forslaget sætter roller og arbejdsnoter. Det flytter eller ændrer ingen brødtekst.", "Suggestion sets roles and notes. It does not move or modify text.")}</p>
      </div>
      <footer>
        <button type="button" class="outline" data-close>${tr("Læg væk", "Dismiss")}</button>
        <button type="button" class="primary" id="accept-proposal">${tr("Brug roller og noter", "Use roles and notes")}</button>
      </footer>
    `;
    propD.querySelectorAll("[data-close]").forEach(el => el.addEventListener("click", () => propD.close()));
    propD.querySelector("#accept-proposal")?.addEventListener("click", () => {
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
      const firstLine = doc.trim().split("\n")[0] || tr("Dokument", "Document");
      titleEl.textContent = firstLine.replace(/^#+\s*/, "");
    }
    const sumEl = this.boardDialog.querySelector<HTMLElement>("#board-summary");
    if (sumEl) {
      sumEl.textContent = `${parts.length} ${tr("dele", "parts")} · ${totalWords} ${tr("ord", "words")} · ${model?.name ?? tr("Fri opbygning", "Free structure")}`;
    }

    const grid = this.boardDialog.querySelector<HTMLElement>("#board-grid");
    if (grid) {
      grid.innerHTML = parts.map((p, i) => {
        const text = doc.slice(p.contentFrom, p.contentTo).trim();
        const role = model?.roles.find(r => r.id === p.role)?.name ?? p.role;
        return `
          <button type="button" draggable="true" class="board-card ${p.id === this.selected ? "selected" : ""}" data-select="${p.id}" aria-pressed="${p.id === this.selected}">
            <div class="row spread">
              <span class="number">${String(i + 1).padStart(2, "0")}</span>
              <small>${esc(role || tr("Ingen rolle", "No role"))}</small>
            </div>
            <h3>${esc(p.title || tr("Uden titel", "Untitled"))}</h3>
            <p>${esc(excerpt(text))}</p>
            <div class="row spread">
              <span>${words(text)} ${tr("ord", "words")}</span>
              <span>${p.note ? tr("Arbejdsnote", "Working note") : ""}</span>
            </div>
          </button>
        `;
      }).join("");

      grid.querySelectorAll<HTMLElement>("[data-select]").forEach(card => {
        card.onclick = () => {
          this.selected = card.dataset.select ?? null;
          this.renderBoard();
          this.refresh();
        };
      });
    }

    const detail = this.boardDialog.querySelector<HTMLElement>("#board-detail");
    if (detail) {
      if (activePart) {
        const text = doc.slice(activePart.contentFrom, activePart.contentTo).trim();
        const role = model?.roles.find(r => r.id === activePart.role)?.name ?? activePart.role;
        const idx = parts.indexOf(activePart);
        detail.innerHTML = `
          <small>${tr("DEL", "PART")} ${idx + 1} · ${esc(role || tr("Ingen rolle", "No role"))}</small>
          <h3>${esc(activePart.title || tr("Uden titel", "Untitled"))}</h3>
          ${text ? text.split("\n\n").map(t => `<p>${esc(t)}</p>`).join("") : `<p class="muted">${tr("Denne del er endnu ikke skrevet.", "This part is not yet written.")}</p>`}
          ${activePart.note ? `<div class="note"><strong style="display:block;margin-bottom:4px">${tr("Arbejdsnote", "Working note")}</strong>${esc(activePart.note)}</div>` : ""}
          <div class="row" style="margin-top:16px;gap:6px">
            <button type="button" class="outline" id="board-up" ${idx === 0 ? "disabled" : ""}>${tr("Flyt op", "Move up")}</button>
            <button type="button" class="outline" id="board-down" ${idx === parts.length - 1 ? "disabled" : ""}>${tr("Flyt ned", "Move down")}</button>
          </div>
        `;
        detail.querySelector("#board-up")?.addEventListener("click", () => this.move(activePart.id, -1));
        detail.querySelector("#board-down")?.addEventListener("click", () => this.move(activePart.id, 1));
      } else {
        detail.innerHTML = `<p>${tr("Tilføj en del for at se den her.", "Add a part to view it here.")}</p>`;
      }
    }
  }

  private renderMethods(): void {
    if (!this.methodsDialog) return;
    const catNav = this.methodsDialog.querySelector<HTMLElement>("#categories");
    if (catNav) {
      catNav.innerHTML = MODEL_GROUPS.map((g, i) => `
        <button type="button" aria-pressed="${i === this.category}" data-category="${i}">${esc(g)}</button>
      `).join("");
      catNav.querySelectorAll<HTMLElement>("[data-category]").forEach(b => {
        b.onclick = () => {
          this.category = Number(b.dataset.category);
          this.renderMethods();
        };
      });
    }

    const choices = this.methodsDialog.querySelector<HTMLElement>("#method-choices");
    if (choices) {
      const freeBtn = `
        <button type="button" class="choice ${this.chosenModel === "" ? "selected" : ""}" data-model="">
          <strong>${tr("Fri opbygning", "Free structure")}</strong>
          <small>${tr("Arbejd med egne roller og din egen rækkefølge.", "Work with your own roles and order.")}</small>
        </button>
      `;
      const currentGroup = MODEL_GROUPS[this.category];
      const modelBtns = NARRATIVE_MODELS.filter(m => m.groups.includes(currentGroup)).map(m => `
        <button type="button" class="choice ${this.chosenModel === m.id ? "selected" : ""}" data-model="${m.id}">
          <strong>${esc(m.name)}</strong>
          <small>${esc(m.description)}</small>
        </button>
      `).join("");
      choices.innerHTML = freeBtn + modelBtns;

      choices.querySelectorAll<HTMLElement>("[data-model]").forEach(b => {
        b.onclick = () => {
          this.chosenModel = b.dataset.model ?? "";
          this.renderMethods();
        };
      });
    }

    const m = narrativeModel(this.chosenModel);
    const chosenLabel = this.methodsDialog.querySelector<HTMLElement>("#chosen-label");
    if (chosenLabel) chosenLabel.textContent = `${tr("Valgt", "Selected")}: ${m?.name ?? tr("Fri opbygning", "Free structure")}`;

    const desc = this.methodsDialog.querySelector<HTMLElement>("#model-description");
    if (desc) {
      desc.innerHTML = m ? `
        <p><strong>${esc(m.name)}</strong><br><span style="font-size:12px;color:var(--svag)">${m.roles.map(r => esc(r.name)).join(" → ")}</span></p>
      ` : "";
    }
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

    const list = this.proposalDialog.querySelector<HTMLElement>("#proposal-list");
    if (list) {
      list.innerHTML = value.parts.map(p => {
        const title = parts.find(x => x.id === p.id)?.title ?? candidates.find(x => x.id === p.id)?.title ?? p.id;
        const role = m?.roles.find(r => r.id === p.role)?.name ?? p.role;
        return `
          <li>
            <strong>${esc(title)}</strong>
            <div class="proposal-role">${esc(role)}</div>
            ${p.note ? `<p>${esc(p.note)}</p>` : ""}
          </li>
        `;
      }).join("");
    }
    this.proposalDialog.showModal();
  }
}
