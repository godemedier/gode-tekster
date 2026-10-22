// Fanen Kilder (ADR-0049): kildelisten sidst i filen som liste og formular. Filen er sandheden
// (ADR-0003): fanen læser blokken hver gang og skriver den om, når en kilde gemmes eller slettes.
// En DOI slås op i Rust (`lookup_doi`), og svaret er kun et forslag i formularen, til brugeren gemmer.

import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";

import {
  citationCounts,
  citationsIn,
  findCitations,
  findReferences,
  formatter,
  newReferenceId,
  referenceFromFootnote,
  removeReference,
  setReferences,
  type Lang,
  type Name,
  type Reference,
  type ReferenceChange,
} from "../editor/references.ts";
import { footnoteDefinition, footnoteEdit, footnoteRef, footnoteSources, type FootnoteSource } from "../editor/inline.ts";
import { errorText, showBanner } from "./banner.ts";
import { tr } from "../i18n.ts";
import { button, el } from "./dom.ts";

type Kind = { type: string; label: string; container: string | null; fields: string[] };

/** Typerne i formularen og de felter, hver af dem bruger. CSL-navnene står i `type`. */
const KINDS: Kind[] = [
  { type: "book", label: tr("Bog", "Book"), container: null, fields: ["publisher", "edition"] },
  { type: "article-journal", label: tr("Artikel i tidsskrift", "Journal article"), container: tr("Tidsskrift", "Journal"), fields: ["volume", "issue", "page"] },
  { type: "chapter", label: tr("Kapitel i bog", "Book chapter"), container: tr("Bogens titel", "Book title"), fields: ["editor", "page", "publisher"] },
  { type: "article-newspaper", label: tr("Avis eller magasin", "Newspaper or magazine"), container: tr("Avis eller magasin", "Newspaper or magazine"), fields: [] },
  { type: "webpage", label: tr("Webside", "Web page"), container: null, fields: ["publisher"] },
  { type: "report", label: tr("Rapport", "Report"), container: null, fields: ["publisher"] },
];

const LABELS: Record<string, string> = {
  publisher: tr("Udgiver", "Publisher"),
  edition: tr("Udgave", "Edition"),
  volume: tr("Årgang eller bind", "Volume"),
  issue: tr("Nummer", "Issue"),
  page: tr("Sider", "Pages"),
  editor: tr("Redaktører", "Editors"),
};

/** Litteraturlistens markdown (kursiv og escapes) som tekst og <em>, aldrig som HTML. */
function renderEntry(md: string): DocumentFragment {
  const out = document.createDocumentFragment();
  let buf = "";
  let em: HTMLElement | null = null;
  const flush = () => {
    if (!buf) return;
    (em ?? out).append(buf);
    buf = "";
  };
  for (let i = 0; i < md.length; i++) {
    const c = md[i];
    if (c === "\\" && i + 1 < md.length) buf += md[++i];
    else if (c === "*") {
      flush();
      if (em) {
        out.append(em);
        em = null;
      } else em = el("em");
    } else buf += c;
  }
  flush();
  if (em) out.append(em);
  return out;
}

/** »Hansen, Jens« → efternavn og fornavn. Uden komma er det en organisation, med ét ord et efternavn. */
export function parseNames(text: string): Name[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const comma = l.indexOf(",");
      if (comma > 0) return { family: l.slice(0, comma).trim(), given: l.slice(comma + 1).trim() || undefined };
      return /\s/.test(l) ? { literal: l } : { family: l };
    })
    .map((n) => Object.fromEntries(Object.entries(n).filter(([, v]) => v)) as Name);
}

export function formatNames(names: Name[] | undefined): string {
  return (names ?? []).map((n) => n.literal ?? [n.family, n.given].filter(Boolean).join(", ")).join("\n");
}

/** »2024« eller »2024-03-05« → CSL-dato. Andet gemmes som tekst. */
export function parseDate(text: string): Reference["issued"] | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(t);
  if (!m) return { literal: t };
  return { "date-parts": [[m[1], m[2], m[3]].filter(Boolean).map(Number)] };
}

export function formatDate(d: Reference["issued"]): string {
  const p = d?.["date-parts"]?.[0];
  if (!p?.length) return d?.literal ?? d?.raw ?? "";
  return p.map((n, i) => (i === 0 ? String(n) : String(n).padStart(2, "0"))).join("-");
}

/** Fodnotens tekst er kun henvisninger til kilder, der findes (»[@hansen2024, s. 4].«). */
function onlyKnownCitations(text: string, known: Set<string>): boolean {
  const cites = findCitations(text);
  if (!cites.length || !cites.every((c) => c.items.every((i) => known.has(i.id)))) return false;
  let rest = text;
  for (const c of [...cites].reverse()) rest = rest.slice(0, c.from) + rest.slice(c.to);
  return /^[\s.,;:–-]*$/.test(rest);
}

export class ReferencesPanel {
  private view: EditorView;
  private path: () => string | null;
  /** Kilden i formularen. `original` er dens id før redigering (null for en ny). */
  private form: { el: HTMLElement; original: string | null; path: string | null } | null = null;
  /** Fodnoten, kilden i formularen er lavet af (»Gør til kilde«). Den får henvisningen, når kilden gemmes. */
  private fromNote: string | null = null;
  private importing: HTMLElement | null = null;

  constructor(view: EditorView, path: () => string | null) {
    this.view = view;
    this.path = path;
  }

  /** Antallet af kilder (tallet på ikonet i højrespalten), fodnoterne med et link medregnet. */
  count(): number {
    const doc = this.view.state.doc.toString();
    return (findReferences(doc)?.refs.length ?? 0) + footnoteSources(doc).length;
  }

  private lang(): Lang {
    return document.documentElement.lang === "en" ? "en" : "da";
  }

  private apply(change: ReferenceChange | null): boolean {
    if (!change) {
      showBanner(tr("Kildelisten i filen kan ikke læses, så den bliver ikke ændret.", "The source list in the file cannot be read, so it is left unchanged."));
      return false;
    }
    this.view.dispatch({ changes: change, userEvent: "input.references" });
    return true;
  }

  render(body: HTMLElement): void {
    const doc = this.view.state.doc.toString();
    const block = findReferences(doc);
    const refs = block?.refs ?? [];
    if (this.form && this.form.path !== this.path()) this.form = null;

    const tools = el("div", "rp-row");
    const create = button(tr("Ny kilde", "New source"), () => this.openForm(null), "rp-btn");
    const zotero = button(tr("Importér fra Zotero", "Import from Zotero"), () => this.toggleImport(), "rp-btn");
    zotero.title = tr("Kildeliste i formatet CSL-JSON, for eksempel fra Zotero", "Source list in CSL-JSON format, for example from Zotero");
    tools.append(create, zotero);
    const parts: Node[] = [tools];
    if (block?.broken) {
      parts.push(el("p", "rp-empty", tr("Kildelisten sidst i filen er beskadiget og kan ikke læses. Programmet lader den være, så intet går tabt.", "The source list at the end of the file is damaged and cannot be read. It is left untouched, so nothing is lost.")));
      body.replaceChildren(...parts);
      return;
    }
    if (this.importing) parts.push(this.importing);
    if (this.form) parts.push(this.form.el);

    const counts = citationCounts(doc);
    const f = formatter(refs, this.lang());
    for (const r of f.sorted(refs)) parts.push(this.card(r, f.entry(r), counts.get(r.id) ?? 0));

    const unknown = [...counts.keys()].filter((id) => !refs.some((r) => r.id === id));
    if (unknown.length) {
      parts.push(el("h3", "rp-subhead", tr("Henvisninger uden kilde", "Citations without a source")));
      for (const id of unknown) {
        const row = el("div", "src-unknown");
        row.append(el("code", "", `@${id}`), button(tr("Opret kilde", "Create source"), () => this.openForm(null, id), "rp-link"));
        parts.push(row);
      }
    }
    // Fodnoterne, der er kilder (21/10): kun vist her. De står i teksten og rettes under Fodnoter.
    // En fodnote, der kun henviser til kilder på listen, står allerede ovenfor.
    const known = new Set(refs.map((r) => r.id));
    const notes = footnoteSources(doc).filter((s) => !onlyKnownCitations(s.text, known));
    if (notes.length) {
      parts.push(
        el("h3", "rp-subhead", tr("Fra fodnoterne", "From the footnotes")),
        el("p", "src-meta", tr("Fodnoter med et link eller en henvisning. Du retter dem under Fodnoter.", "Footnotes with a link or a citation. You edit them under Footnotes.")),
      );
      for (const s of notes) parts.push(this.noteCard(s));
    }
    // Tom fane (UX 20/10): én linje om hvad, og så knapperne, uden fagord.
    if (!refs.length && !this.form && !this.importing && !unknown.length && !notes.length) {
      create.classList.add("rp-btn-primary");
      parts.unshift(el("p", "rp-lead", tr(
        "Ingen kilder endnu. Opret en kilde, og tryk Indsæt der, hvor teksten skal henvise til den.",
        "No sources yet. Create one, and press Insert where the text should refer to it.",
      )));
    }
    body.replaceChildren(...parts);
  }

  private refresh(): void {
    const body = this.form?.el.closest<HTMLElement>(".rp-body") ?? document.querySelector<HTMLElement>('.rp-body[data-tab="kilder"]');
    if (body?.dataset.tab === "kilder") this.render(body);
  }

  private card(r: Reference, entry: string, uses: number): HTMLElement {
    const card = el("div", "rp-card src-card");
    const text = el("div", "src-entry");
    text.append(renderEntry(entry));
    const meta = el("div", "src-meta");
    const key = el("code", "", `@${r.id}`);
    const used = uses === 0 ? tr("ikke brugt endnu", "not used yet") : uses === 1 ? tr("brugt 1 gang", "used once") : tr(`brugt ${uses} gange`, `used ${uses} times`);
    meta.append(key, ` · ${used}`);
    // Altid synlige: »Indsæt« er det, man kommer for (UX 20/10). Fraklippenes hjørneikoner passer ikke her.
    const tools = el("div", "src-tools");
    tools.append(button(tr("Indsæt", "Insert"), () => this.insert(r.id), "rp-link"));
    if (uses) tools.append(button(tr("Find i teksten", "Find in text"), () => this.findNext(r.id), "rp-link"));
    tools.append(button(tr("Ret", "Edit"), () => this.openForm(r), "rp-link"));
    const del = button(tr("Slet", "Delete"), () => {
      if (uses && del.dataset.sure !== "1") {
        del.dataset.sure = "1";
        del.textContent = tr(`Slet alligevel? Den bruges ${uses} ${uses === 1 ? "sted" : "steder"}`, `Delete anyway? It is used ${uses} ${uses === 1 ? "time" : "times"}`);
        window.setTimeout(() => {
          del.dataset.sure = "";
          del.textContent = tr("Slet", "Delete");
        }, 4000);
        return;
      }
      this.apply(removeReference(this.view.state.doc.toString(), r.id));
    }, "rp-link");
    tools.append(del);
    card.append(text, meta, tools);
    return card;
  }

  /** En fodnote med et link: teksten med linkenes titler, aldrig som HTML. */
  private noteCard(s: FootnoteSource): HTMLElement {
    const card = el("div", "rp-card src-card");
    const text = el("div", "src-entry");
    text.append(renderEntry(s.text.replace(/\[([^\]]*)\]\((?:[^)\s]+)\)/g, "$1").replace(/<(https?:\/\/[^>\s]+)>/g, "$1")));
    const tools = el("div", "src-tools");
    tools.append(button(tr("Find i teksten", "Find in text"), () => this.findNote(s.label), "rp-link"));
    if (s.url) tools.append(button(tr("Gør til kilde", "Make a source"), () => this.openForm(null, "", referenceFromFootnote(s.text), s.label), "rp-link"));
    const url = s.url;
    if (url) tools.append(button(tr("Åbn linket", "Open the link"), () => void invoke("open_url", { url }).catch((e) => showBanner(errorText(e))), "rp-link"));
    card.append(text, el("div", "src-meta", tr(`Fodnote ${s.n}`, `Footnote ${s.n}`)), tools);
    return card;
  }

  private findNote(label: string): void {
    const ref = footnoteRef(this.view.state.doc.toString(), label);
    if (!ref) return;
    this.view.dispatch({ selection: { anchor: ref.to }, scrollIntoView: true });
    this.view.focus();
  }

  /** Henvisningen ved markøren. Står markøren lige efter en henvisning, kommer kilden med i den. */
  insert(id: string): void {
    const { state } = this.view;
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.from);
    const before = findCitations(line.text, line.from).find((c) => c.to === sel.from || (c.to - 1 === sel.from && sel.empty));
    let change: { from: number; to?: number; insert: string };
    let cursor: number;
    if (before && sel.empty) {
      change = { from: before.to - 1, insert: `; @${id}` };
      cursor = before.to + change.insert.length;
    } else {
      const prev = sel.from > line.from ? state.doc.sliceString(sel.from - 1, sel.from) : "";
      const insert = `${/[\p{L}\p{N}.,]/u.test(prev) ? " " : ""}[@${id}]`;
      change = { from: sel.from, to: sel.to, insert };
      cursor = sel.from + insert.length;
    }
    this.view.dispatch({ changes: change, selection: { anchor: cursor }, userEvent: "input.type", scrollIntoView: true });
    this.view.focus();
  }

  /** Næste sted, kilden bruges, efter markøren. Efter det sidste begynder den forfra. */
  private findNext(id: string): void {
    const doc = this.view.state.doc.toString();
    const at = this.view.state.selection.main.to;
    const hits = citationsIn(doc).filter((c) => c.items.some((i) => i.id === id));
    const next = hits.find((c) => c.from >= at) ?? hits[0];
    if (!next) return;
    this.view.dispatch({ selection: { anchor: next.to }, scrollIntoView: true });
    this.view.focus();
  }

  // --- formularen --------------------------------------------------------------------------------

  openForm(ref: Reference | null, id = "", prefill: Reference | null = null, note: string | null = null): void {
    this.importing = null;
    this.fromNote = note;
    this.form = { el: this.buildForm(ref, id, prefill), original: ref?.id ?? null, path: this.path() };
    this.refresh();
    this.form?.el.querySelector<HTMLElement>("select, input")?.focus();
  }

  private closeForm(): void {
    this.form = null;
    this.fromNote = null;
    this.refresh();
  }

  private buildForm(ref: Reference | null, presetId: string, prefill: Reference | null = null): HTMLElement {
    // Felterne udfyldes fra kilden, der rettes, eller fra fodnoten, en ny kilde laves af.
    const init = ref ?? prefill;
    const form = el("form", "src-form");
    form.setAttribute("aria-label", ref ? tr("Ret kilde", "Edit source") : tr("Ny kilde", "New source"));
    const fields = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
    const rows = new Map<string, HTMLElement>();
    const add = (key: string, label: string, input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, hint = "") => {
      const row = el("label", "src-row");
      row.append(el("span", "src-label", label), input);
      if (hint) row.append(el("small", "src-hint", hint));
      fields.set(key, input);
      rows.set(key, row);
      form.append(row);
      return input;
    };
    const input = (value = "") => {
      const i = el("input");
      i.type = "text";
      i.value = value;
      return i;
    };
    const area = (value = "") => {
      const a = el("textarea", "rp-edit");
      a.rows = 2;
      a.value = value;
      return a;
    };

    // DOI først: et opslag udfylder resten.
    const doiRow = el("div", "src-doi");
    const doi = input(init?.DOI ?? "");
    doi.placeholder = "10.1038/nature12373";
    doi.setAttribute("aria-label", "DOI");
    const fetchBtn = button(tr("Hent", "Fetch"), () => void lookup(), "rp-btn");
    doiRow.append(el("span", "src-label", "DOI"), doi, fetchBtn);
    form.append(doiRow);
    fields.set("DOI", doi);

    const kind = el("select");
    for (const k of KINDS) kind.add(new Option(k.label, k.type));
    if (init && !KINDS.some((k) => k.type === init.type)) kind.add(new Option(init.type, init.type));
    kind.value = init?.type ?? "book";
    add("type", tr("Type", "Type"), kind);
    add("author", tr("Forfattere", "Authors"), area(formatNames(init?.author)), tr("Én pr. linje: Efternavn, Fornavn. En organisation skrives uden komma.", "One per line: Surname, Given name. Write an organisation without a comma."));
    add("issued", tr("År eller dato", "Year or date"), input(formatDate(init?.issued)), tr("2024 eller 2024-03-05", "2024 or 2024-03-05"));
    add("title", tr("Titel", "Title"), area(init?.title ?? ""));
    add("container-title", "", input(init?.["container-title"] ?? ""));
    add("editor", LABELS.editor, area(formatNames(init?.editor)), tr("Én pr. linje, som forfatterne.", "One per line, like the authors."));
    for (const key of ["publisher", "edition", "volume", "issue", "page"]) add(key, LABELS[key], input(String(init?.[key] ?? "")));
    add("URL", tr("Webadresse", "Web address"), input(init?.URL ?? ""));
    const idInput = add("id", tr("Nøgle", "Key"), input(ref?.id ?? presetId), tr("Står i teksten som [@nøgle]. Tom: dannes af efternavn og år.", "Appears in the text as [@key]. Empty: made from surname and year."));

    const showFields = () => {
      const k = KINDS.find((x) => x.type === kind.value) ?? KINDS[0];
      const container = rows.get("container-title");
      if (container) {
        container.hidden = !k.container;
        (container.firstChild as HTMLElement).textContent = k.container ?? "";
      }
      for (const key of ["publisher", "edition", "volume", "issue", "page", "editor"]) {
        const row = rows.get(key);
        // Et felt med indhold vises altid, så intet skjules, der står i filen.
        if (row) row.hidden = !k.fields.includes(key) && !(fields.get(key)?.value ?? "").trim();
      }
    };
    kind.addEventListener("change", showFields);
    showFields();

    const status = el("p", "src-status");
    status.setAttribute("role", "status");
    const lookup = async () => {
      fetchBtn.disabled = true;
      status.textContent = tr("Slår op …", "Looking up …");
      try {
        const found = await invoke<Reference>("lookup_doi", { doi: doi.value });
        kind.value = KINDS.some((k) => k.type === found.type) ? found.type : "book";
        const set = (key: string, value: string) => {
          const f = fields.get(key);
          if (f && value) f.value = value;
        };
        set("author", formatNames(found.author));
        set("editor", formatNames(found.editor));
        set("issued", formatDate(found.issued));
        for (const key of ["title", "container-title", "publisher", "edition", "volume", "issue", "page", "URL", "DOI"]) set(key, String(found[key] ?? ""));
        showFields();
        status.textContent = tr("Udfyldt fra DOI'en. Tjek felterne, og gem.", "Filled in from the DOI. Check the fields and save.");
      } catch (e) {
        status.textContent = errorText(e);
      } finally {
        fetchBtn.disabled = false;
      }
    };
    doi.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void lookup();
      }
    });

    const save = () => {
      const value = (key: string) => (fields.get(key)?.value ?? "").trim();
      const draft: Reference = { ...(ref ?? {}), id: "", type: kind.value };
      for (const key of ["author", "editor"]) {
        const names = parseNames(value(key));
        if (names.length) draft[key] = names;
        else delete draft[key];
      }
      const issued = parseDate(value("issued"));
      if (issued) draft.issued = issued;
      else delete draft.issued;
      for (const key of ["title", "container-title", "publisher", "edition", "volume", "issue", "page", "DOI", "URL"]) {
        if (value(key) && !rows.get(key)?.hidden) draft[key] = value(key);
        else if (key === "DOI" && value(key)) draft[key] = value(key);
        else delete draft[key];
      }
      if (!draft.title && !draft.author) {
        status.textContent = tr("Skriv mindst en titel eller en forfatter.", "Enter at least a title or an author.");
        return;
      }
      const doc = this.view.state.doc.toString();
      const others = (findReferences(doc)?.refs ?? []).filter((r) => r.id !== ref?.id).map((r) => r.id);
      const wanted = value("id").replace(/^@/, "");
      if (wanted && !findCitations(`[@${wanted}]`).some((c) => c.items[0].id === wanted)) {
        status.textContent = tr("Nøglen må kun have bogstaver, tal og tegn som : . - _ og ikke slutte med tegnsætning.", "The key may only contain letters, digits and : . - _ and must not end with punctuation.");
        return;
      }
      if (wanted && others.includes(wanted)) {
        status.textContent = tr(`Nøglen @${wanted} bruges allerede af en anden kilde.`, `The key @${wanted} is already used by another source.`);
        return;
      }
      draft.id = wanted || newReferenceId(draft, others);
      let refs = findReferences(doc)?.refs ?? [];
      refs = ref ? refs.map((r) => (r.id === ref.id ? draft : r)) : [...refs, draft];
      if (!this.apply(setReferences(doc, refs))) return;
      // Fodnoten, kilden kom fra, henviser nu til den. Den står, hvor den stod, og printes efter valget i Indhold.
      const note = this.fromNote;
      if (note) {
        const now = this.view.state.doc.toString();
        if (footnoteDefinition(now, note)) this.view.dispatch({ changes: footnoteEdit(now, note, `[@${draft.id}]`, now.length), userEvent: "input.references" });
      }
      // En ny nøgle på en kilde, der er brugt, rettes også i henvisningerne.
      if (ref && ref.id !== draft.id) this.renameCitations(ref.id, draft.id);
      this.closeForm();
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      save();
    });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.closeForm();
      }
    });
    const actions = el("div", "rp-row");
    const submit = button(tr("Gem kilde", "Save source"), () => undefined, "rp-btn rp-btn-primary");
    submit.type = "submit";
    actions.append(submit, button(tr("Annullér", "Cancel"), () => this.closeForm(), "rp-btn"));
    form.append(status, actions);
    idInput.addEventListener("input", () => (status.textContent = ""));
    return form;
  }

  /** Omdøb en kilde i alle henvisninger, i én ændring. */
  private renameCitations(from: string, to: string): void {
    const doc = this.view.state.doc.toString();
    const changes: { from: number; to: number; insert: string }[] = [];
    for (const c of citationsIn(doc)) {
      const raw = doc.slice(c.from, c.to);
      if (!c.items.some((i) => i.id === from)) continue;
      const renamed = raw.replace(new RegExp(`(^|[\\s\\[;-])@${from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\p{L}\\p{N}_]|[:.#$%&+?~/-][\\p{L}\\p{N}_])`, "gu"), `$1@${to}`);
      if (renamed !== raw) changes.push({ from: c.from, to: c.to, insert: renamed });
    }
    if (changes.length) this.view.dispatch({ changes, userEvent: "input.references" });
  }

  // --- import ------------------------------------------------------------------------------------

  private toggleImport(): void {
    if (this.importing) {
      this.importing = null;
      this.refresh();
      return;
    }
    this.form = null;
    const box = el("div", "src-form");
    const area = el("textarea", "rp-edit");
    area.rows = 6;
    area.placeholder = tr("Eksportér fra Zotero med Filer, Eksportér bibliotek, CSL JSON. Indsæt så filens indhold her.", "Export from Zotero with File, Export Library, CSL JSON. Then paste the file's contents here.");
    area.setAttribute("aria-label", tr("Kildeliste fra Zotero", "Source list from Zotero"));
    const status = el("p", "src-status");
    status.setAttribute("role", "status");
    const actions = el("div", "rp-row");
    actions.append(
      button(tr("Tilføj kilderne", "Add the sources"), () => {
        const result = this.importJson(area.value);
        status.textContent = result.message;
        if (result.ok) {
          this.importing = null;
          this.refresh();
          showBanner(result.message);
        }
      }, "rp-btn rp-btn-primary"),
      button(tr("Annullér", "Cancel"), () => this.toggleImport(), "rp-btn"),
    );
    box.append(area, status, actions);
    this.importing = box;
    this.refresh();
    area.focus();
  }

  private importJson(text: string): { ok: boolean; message: string } {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, message: tr("Teksten er ikke gyldig JSON.", "The text is not valid JSON.") };
    }
    const list = (Array.isArray(data) ? data : [data]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
    const doc = this.view.state.doc.toString();
    const refs = [...(findReferences(doc)?.refs ?? [])];
    let added = 0;
    let renamed = 0;
    for (const raw of list) {
      if (typeof raw.title !== "string" && !Array.isArray(raw.author)) continue;
      const r = { ...raw, type: typeof raw.type === "string" ? raw.type : "book" } as Reference;
      const ids = refs.map((x) => x.id);
      const id = typeof raw.id === "string" ? raw.id : "";
      const valid = id && findCitations(`[@${id}]`).some((c) => c.items[0].id === id);
      r.id = valid && !ids.includes(id) ? id : newReferenceId(r, ids);
      if (valid && r.id !== id) renamed++;
      refs.push(r);
      added++;
    }
    if (!added) return { ok: false, message: tr("Der var ingen kilder med titel eller forfatter i teksten.", "There were no sources with a title or author in the text.") };
    if (!this.apply(setReferences(doc, refs))) return { ok: false, message: "" };
    const msg = added === 1 ? tr("1 kilde tilføjet.", "1 source added.") : tr(`${added} kilder tilføjet.`, `${added} sources added.`);
    return { ok: true, message: renamed ? `${msg} ${tr(`${renamed} fik en ny nøgle, fordi nøglen var i brug.`, `${renamed} got a new key because the key was taken.`)}` : msg };
  }
}

