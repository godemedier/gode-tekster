// Forhåndsvisning og udskrift (Ctrl+P, 9/10: én indgang) og eksport til PDF og Word (ADR-0011, -0018).
// Print-DOM'en tegnes på ny før hver udskrift, så den altid viser teksten, som den er nu.

import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";

import { authorshipField } from "../editor/authorship.ts";
import { imageUrl } from "../editor/images.ts";
import { findNotes, findRevisions } from "../editor/critic.ts";
import { citationsIn } from "../editor/references.ts";
import { chapterTexts, expandChapters } from "../editor/chapters.ts";
import { bulletChar, settings } from "../settings.ts";
import { errorText, notify, showBanner } from "../ui/banner.ts";
import { fontName } from "../ui/settingspanel.ts";
import type { Meta, PrintOptions, Template } from "./render.ts";
import { tr, currentLang } from "../i18n.ts";
import { showMenu } from "../ui/menu.ts";
import { cloneLayout, defaultLayout, layoutFrom, nativeFont, pageRows, templatesFrom, withTemplate, type Margins, type PageLayout, type Part, type Row, type SavedTemplate } from "./layout.ts";
import type { Designer } from "./designer.ts";

// Print-laget (markdown-it) hentes først, når der skal printes, så opstarten ikke betaler for det.
const load = () => import("./render.ts");

// Ny nøgle 9/10: forfatter, dato og tal er nu med som standard, også for den, der havde valgt dem fra.
const KEY = "gt-print-2";

// Side-designeren (9/10): de gemte skabeloner, den valgte og opsætningen, som den står nu.
const DESIGN_KEY = "gt-sidedesign-1";
type DesignStore = { templates: SavedTemplate[]; selected?: string; layout: PageLayout };

function storedDesign(t: Template): DesignStore {
  try {
    const o = JSON.parse(localStorage.getItem(DESIGN_KEY) ?? "{}") as { templates?: unknown; selected?: unknown; current?: unknown };
    const templates = templatesFrom(o.templates);
    const chosen = templates.find((x) => x.name === o.selected);
    // Den valgte skabelon bestemmer grundskabelonen. Passer de ikke sammen, gælder skabelonens standard.
    const selected = chosen && chosen.base === t ? chosen : undefined;
    const layout = o.current && (selected || !o.selected) ? layoutFrom(o.current, t) : selected ? cloneLayout(selected.layout) : defaultLayout(t);
    return { templates, selected: selected?.name, layout };
  } catch {
    return { templates: [], layout: defaultLayout(t) };
  }
}

function storedOptions(): PrintOptions {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<PrintOptions>;
    return {
      template: o.template === "laeseudgave" ? "laeseudgave" : "manuskript",
      includeDimmed: o.includeDimmed === true,
      wordMarkup: o.wordMarkup !== false,
      byline: o.byline !== false,
      counts: o.counts !== false,
      pageNumbers: o.pageNumbers !== false,
      images: o.images !== false,
      citations: o.citations === "fodnoter" ? "fodnoter" : "forfatter-aar",
    };
  } catch {
    return { template: "manuskript", includeDimmed: false, wordMarkup: true, byline: true, counts: true, pageNumbers: true, images: true };
  }
}

export class PrintPreview {
  private view: EditorView;
  private path: () => string | null;
  private root: HTMLElement;
  private paper: HTMLElement;
  private bar: HTMLElement;
  private pageStyle: HTMLStyleElement;
  private side: HTMLElement;
  private opts = storedOptions();
  private design = storedDesign(this.opts.template);
  private designing = false;
  private designer: Designer | null = null;
  /** Tegner arkene om, når teksten skifter højde (skrifter og billeder, der kommer sent). */
  private pager: ResizeObserver | null = null;
  private pageCount: HTMLElement | null = null;

  constructor(view: EditorView, path: () => string | null) {
    this.view = view;
    this.path = path;
    this.root = document.createElement("div");
    this.root.id = "print-root";
    this.bar = document.createElement("div");
    this.bar.className = "pv-bar";
    this.paper = document.createElement("div");
    this.paper.className = "pv-paper";
    this.side = document.createElement("aside");
    this.side.className = "pv-side";
    const stage = document.createElement("div");
    stage.className = "pv-stage";
    stage.append(this.paper, this.side);
    this.root.append(this.bar, stage);
    this.pageStyle = document.createElement("style");
    document.head.append(this.pageStyle);
    document.body.append(this.root);
    // Et link i forhåndsvisningen må aldrig føre webviewet væk fra programmet.
    for (const kind of ["click", "auxclick"]) {
      this.paper.addEventListener(kind, (e) => {
        if ((e.target as HTMLElement).closest("a")) e.preventDefault();
      });
    }
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    window.addEventListener("resize", () => {
      if (this.isOpen) this.fit();
    });
    window.addEventListener("afterprint", () => {
      if (!this.isOpen) this.paper.replaceChildren();
    });
  }

  get isOpen(): boolean {
    return document.body.classList.contains("print-preview");
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else void this.open();
  }

  async open(): Promise<void> {
    if (!this.path()) return;
    document.body.classList.add("print-preview");
    this.fit();
    await this.render();
    this.root.tabIndex = -1;
    this.root.focus();
  }

  close(): void {
    if (this.designing) this.toggleDesign(false);
    document.body.classList.remove("print-preview");
    this.pager?.disconnect();
    this.paper.replaceChildren();
    this.view.focus();
  }

  private setOptions(patch: Partial<PrintOptions>): void {
    this.opts = { ...this.opts, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.opts));
    } catch {
      // Valget gælder så kun denne kørsel.
    }
    void this.render();
  }

  private saveDesign(): void {
    const { templates, selected, layout } = this.design;
    try {
      localStorage.setItem(DESIGN_KEY, JSON.stringify({ templates, selected, current: layout }));
    } catch {
      // Opsætningen gælder så kun denne kørsel.
    }
  }

  private setLayout(layout: PageLayout): void {
    this.design.layout = layout;
    this.saveDesign();
    void this.render();
  }

  /** En af de to faste skabeloner: deres standardopsætning, som før side-designeren. */
  private chooseTemplate(t: Template): void {
    this.design = { ...this.design, selected: undefined, layout: defaultLayout(t) };
    this.saveDesign();
    this.setOptions({ template: t });
  }

  private chooseSaved(name: string): void {
    const saved = this.design.templates.find((x) => x.name === name);
    if (!saved) return;
    this.design = { ...this.design, selected: name, layout: cloneLayout(saved.layout) };
    this.saveDesign();
    this.setOptions({ template: saved.base });
  }

  /** »Design« til og fra. Ved Luk tegnes intet igen (`redraw`). */
  private toggleDesign(redraw = true): void {
    this.designing = !this.designing;
    this.root.classList.toggle("pv-designing", this.designing);
    if (!this.designing) this.designer?.unmount(this.paper, this.side);
    // Fokus følger med ind i designeren og tilbage til knappen, der åbnede den.
    const target = this.designing ? "back" : "design";
    if (redraw) void this.render().then(() => this.side.querySelector<HTMLElement>(`[data-pv="${target}"]`)?.focus());
  }

  private async ensureDesigner(): Promise<Designer> {
    if (this.designer) return this.designer;
    const { Designer } = await import("./designer.ts");
    this.designer = new Designer({
      layout: () => this.design.layout,
      setLayout: (l) => this.setLayout(l),
      options: () => this.opts,
      templates: () => this.design.templates,
      selected: () => this.design.selected,
      saveAs: (name) => {
        const saved = { name, base: this.opts.template, layout: this.design.layout };
        this.design = { ...this.design, templates: withTemplate(this.design.templates, saved), selected: name };
        this.saveDesign();
        notify(tr(`Skabelonen »${name}« er gemt.`, `Template “${name}” saved.`));
        void this.render();
      },
      deleteSelected: () => {
        const name = this.design.selected;
        if (!name) return;
        this.design = { templates: this.design.templates.filter((x) => x.name !== name), selected: undefined, layout: defaultLayout(this.opts.template) };
        this.saveDesign();
        notify(tr(`Skabelonen »${name}« er slettet.`, `Template “${name}” deleted.`));
        void this.render();
      },
      reset: () => {
        const saved = this.design.templates.find((x) => x.name === this.design.selected);
        this.setLayout(saved ? cloneLayout(saved.layout) : defaultLayout(this.opts.template));
      },
    });
    return this.designer;
  }

  private async meta(): Promise<Meta> {
    const { metaFor } = await load();
    const path = this.path() ?? tr("Tekst.md", "Text.md");
    const name = path.slice(path.lastIndexOf("\\") + 1);
    return metaFor(this.view.state.doc.toString(), name, this.view.state.field(authorshipField).me.name);
  }

  /** Tegn artiklen og `@page`-reglerne for den valgte skabelon og opsætning. */
  private async render(): Promise<void> {
    const { articleHtml, pageMargins, pageCss } = await load();
    const meta = await this.meta();
    const t = this.opts.template;
    const layout = this.design.layout;
    const m = pageMargins(t, layout);
    this.pageStyle.textContent = pageCss(t, meta, this.opts, layout);
    const article = document.createElement("article");
    // Orddeling i print og PDF følger sproget.
    article.lang = currentLang();
    // En anden skrift end skabelonens egen er et valg i side-designeren (print.css .skrift-*).
    const font = layout.font !== nativeFont(t) ? ` skrift-${layout.font}` : "";
    article.className = `pv-article tpl-${t}${font}${settings().paragraphs === "indryk" ? " afsnit-indryk" : ""}`;
    article.style.setProperty("--punkt", `"${bulletChar(settings())}  "`);
    // articleHtml escaper alt fra teksten undtagen <u> (render.ts), så det er sikkert her.
    article.innerHTML = articleHtml(this.source(), { ...this.opts, title: layout.title }, meta, imageUrl);
    this.renderTop();
    this.pager?.disconnect();
    if (this.designing) {
      this.paper.classList.remove("pv-paged");
      this.paper.style.padding = `${m.top}cm ${m.right}cm ${m.bottom}cm ${m.left}cm`;
      this.paper.replaceChildren(article);
      (await this.ensureDesigner()).mount(this.paper, this.side, meta);
      this.side.prepend(this.designHeader());
      this.side.setAttribute("aria-label", tr("Sidehoved, sidefod og margener", "Header, footer and margins"));
    } else {
      this.renderPanel();
      this.paginate(article, m, pageRows(layout, meta, this.opts));
    }
  }

  /**
   * Siderne, som de kommer ud af printeren (29/10: før var forhåndsvisningen ét langt ark, og ingen
   * kunne se, hvor siderne skiftede). Teksten sættes i spalter på en sides højde, der brydes til
   * nye rækker (`column-wrap`). Chromium deler spalter med samme regler som sider: tabeller,
   * overskrifter, enlige linjer og `+++`. Arkene bag spalterne er tomme kasser med sidehoved og sidefod.
   * Kun på skærmen: print og PDF ser artiklen uden spalter (print.css).
   */
  private paginate(article: HTMLElement, m: Margins, rows: ReturnType<typeof pageRows>): void {
    const flow = document.createElement("div");
    flow.className = "pv-flow";
    flow.append(article);
    const sheets = document.createElement("div");
    sheets.className = "pv-sheets";
    sheets.setAttribute("aria-hidden", "true");
    this.paper.style.padding = "";
    for (const [k, v] of Object.entries({ top: m.top, right: m.right, bottom: m.bottom, left: m.left })) this.paper.style.setProperty(`--pv-${k}`, `${v}cm`);
    this.paper.classList.add("pv-paged");
    this.paper.replaceChildren(sheets, flow);
    const cm = 96 / 2.54;
    const draw = () => {
      // Skaleret papir (fit): målene på skærmen er gange `zoom`.
      const zoom = this.paper.getBoundingClientRect().width / (21 * cm) || 1;
      const gap = (parseFloat(getComputedStyle(flow).rowGap) || 0) * zoom;
      const column = (PAGE_HEIGHT - m.top - m.bottom) * cm * zoom;
      repeatHeads(flow, column + gap);
      const n = Math.max(1, Math.round((flow.getBoundingClientRect().height + gap) / (column + gap)));
      if (this.pageCount) this.pageCount.textContent = n === 1 ? tr("1 side", "1 page") : tr(`${n} sider`, `${n} pages`);
      if (sheets.childElementCount === n) return;
      const out: HTMLElement[] = [];
      for (let i = 0; i < n; i++) {
        const page = i === 0 ? rows.first : rows.pages;
        const sheet = document.createElement("div");
        sheet.className = "pv-sheet";
        sheet.style.setProperty("--i", String(i));
        sheet.append(edge("pv-sheet-head", page.header, i + 1), edge("pv-sheet-foot", page.footer, i + 1));
        out.push(sheet);
      }
      sheets.replaceChildren(...out);
    };
    this.pager = new ResizeObserver(draw);
    this.pager.observe(flow);
  }

  /** Øverst kun sideantallet og Luk (bud 2, 29/10). Alt andet står i panelet til højre. */
  private renderTop(): void {
    this.pageCount = document.createElement("span");
    this.pageCount.className = "pv-pages-count";
    this.pageCount.setAttribute("aria-live", "polite");
    const close = Object.assign(button(tr("Luk", "Close"), () => this.close()), { className: "pv-quiet pv-close" });
    close.title = "Esc";
    this.bar.replaceChildren(this.pageCount, close);
  }

  /**
   * Panelet til højre (bud 2, 29/10): skabelonen, hvad der er med på siden, sidehoved og sidefod, og
   * hvad du gør med teksten. Før stod det hele på én linje, og valgene lå i en menu, der skulle
   * åbnes igen for hvert flueben. Under »Sidehoved, sidefod og margener« viser panelet side-designeren.
   */
  private renderPanel(): void {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.pv;
    this.side.setAttribute("aria-label", tr("Udskrift", "Print"));
    const parts: HTMLElement[] = [];

    const templates = section(tr("Skabelon", "Template"));
    const choices: [Template, string, string][] = [
      ["manuskript", tr("Manuskript", "Manuscript"), tr("Din skrift fra skærmen, god luft mellem linjerne og brede margener", "Your screen font, generous line spacing and wide margins")],
      ["laeseudgave", tr("Læseudgave", "Reading edition"), tr("Newsreader, tættere linjer og indrykkede afsnit", "Newsreader, tighter lines and indented paragraphs")],
    ];
    for (const [value, label, hint] of choices) {
      templates.append(choice("radio", `tpl:${value}`, label, hint, !this.design.selected && this.opts.template === value, () => this.chooseTemplate(value)));
    }
    // Egne skabeloner fra side-designeren står under de to faste.
    for (const saved of this.design.templates) {
      templates.append(choice("radio", `tpl:egen:${saved.name}`, saved.name, null, this.design.selected === saved.name, () => this.chooseSaved(saved.name)));
    }
    parts.push(templates);

    const doc = this.source();
    const hasMarkup = findNotes(doc).length > 0 || findRevisions(doc).length > 0;
    const hasCitations = citationsIn(doc).length > 0;
    const o = this.opts;
    const content = section(tr("Med på siden", "On the page"));
    const box = (key: string, label: string, on: boolean, patch: Partial<PrintOptions>) => content.append(choice("checkbox", key, label, null, on, () => this.setOptions(patch)));
    box("byline", tr("Forfatter og dato", "Author and date"), o.byline === true, { byline: !o.byline });
    box("counts", tr("Antal tegn og ord", "Characters and words"), o.counts === true, { counts: !o.counts });
    box("pages", tr("Sidetal", "Page numbers"), o.pageNumbers !== false, { pageNumbers: o.pageNumbers === false });
    box("images", tr("Billeder", "Images"), o.images !== false, { images: o.images === false });
    box("dimmed", tr("Dæmpet tekst", "Dimmed text"), o.includeDimmed, { includeDimmed: !o.includeDimmed });
    // Kun når teksten henviser til kilder (21/10): (Hansen, 2024) i teksten, eller hele kilden i en fodnote.
    if (hasCitations) box("cites", tr("Henvisninger som fodnoter", "Citations as footnotes"), o.citations === "fodnoter", { citations: o.citations === "fodnoter" ? "forfatter-aar" : "fodnoter" });
    // Noter og forslag med ud i Word som kommentarer og sporede ændringer (7/10). Kun når teksten har nogen.
    if (hasMarkup) box("markup", tr("Kommentarer og rettelser i Word", "Comments and changes in Word"), o.wordMarkup !== false, { wordMarkup: o.wordMarkup === false });
    parts.push(content);

    const design = button(tr("Sidehoved, sidefod og margener …", "Header, footer and margins …"), () => this.toggleDesign());
    design.className = "pv-design-open";
    design.dataset.pv = "design";
    parts.push(design);

    // Kopiér med eller uden markdown (15/10): uden er til mails og CMS'er, med til en anden editor.
    const copy = button(tr("Kopiér tekst", "Copy text"), () => {
      const r = copy.getBoundingClientRect();
      const run = (withMarkdown: boolean) => () => void import("./copyRich.ts").then((m) => m.copyRich(this.view, withMarkdown));
      showMenu(r.left, r.bottom + 4, [
        { label: tr("Uden markdown", "Without markdown"), run: run(false) },
        { label: tr("Med markdown", "With markdown"), run: run(true) },
      ]);
    });
    copy.className = "pv-menu";
    copy.setAttribute("aria-haspopup", "menu");
    const actions = document.createElement("div");
    actions.className = "pv-actions";
    actions.append(
      Object.assign(button(tr("Gem som PDF", "Save as PDF"), () => void this.pdf()), { className: "pv-primary" }),
      button(tr("Gem som Word", "Save as Word"), () => void this.word()),
      button(tr("Udskriv", "Print"), () => void this.print()),
      copy,
    );
    parts.push(actions);
    this.side.replaceChildren(...parts);
    if (focused) this.side.querySelector<HTMLElement>(`[data-pv="${CSS.escape(focused)}"]`)?.focus();
  }

  /** Over side-designeren i panelet: vejen tilbage til valgene. */
  private designHeader(): HTMLElement {
    const head = document.createElement("div");
    head.className = "pv-design-head";
    const back = button(tr("‹ Tilbage", "‹ Back"), () => this.toggleDesign());
    back.className = "pv-quiet";
    back.dataset.pv = "back";
    const title = document.createElement("h2");
    title.textContent = tr("Sidehoved, sidefod og margener", "Header, footer and margins");
    head.append(back, title);
    return head;
  }

  /**
   * Smalle vinduer: papiret skaleres ned, så panelet altid kan ses ved siden af (CSS `zoom`, kun på
   * skærmen). Arkene måles med samme faktor (paginate).
   */
  private fit(): void {
    const stage = this.root.querySelector<HTMLElement>(".pv-stage");
    if (!stage) return;
    const room = stage.clientWidth - this.side.offsetWidth - 72;
    const zoom = Math.max(0.4, Math.min(1, room / ((21 * 96) / 2.54)));
    stage.style.setProperty("--pv-zoom", zoom.toFixed(3));
  }

  /** »Udskriv« og Ctrl+P i forhåndsvisningen: WebView2's egen udskriftsdialog. */
  async print(): Promise<void> {
    if (!this.path()) return;
    await this.render();
    await document.fonts.ready;
    window.print();
  }

  async pdf(): Promise<void> {
    const path = this.path();
    if (!path) return;
    // Navnet følger overskriften (9/10). Rust renser det og falder tilbage på filnavnet.
    const meta = await this.meta();
    const target = await invoke<string | null>("pick_export_path", { source: path, kind: "pdf", title: meta.fromHeading ? meta.title : null });
    if (!target) return;
    await this.render();
    await document.fonts.ready;
    try {
      const { pageMargins } = await load();
      const saved = await invoke<string>("export_pdf", { margins: pageMargins(this.opts.template, this.design.layout) });
      const file = saved.slice(saved.lastIndexOf("\\") + 1);
      showBanner(tr(`PDF'en er gemt: ${file}`, `PDF saved: ${file}`), [
        { label: tr("Åbn", "Open"), run: () => void invoke("open_last_export") }
      ], { closable: true });
    } catch (e) {
      showBanner(errorText(e));
    }
    if (!this.isOpen) this.paper.replaceChildren();
  }

  /** Teksten, der trykkes: en hovedfil med kapitlerne sat ind (lange tekster fase 1), ellers teksten selv. */
  private source(): string {
    const doc = this.view.state.doc.toString();
    const texts = this.view.state.field(chapterTexts, false);
    return texts?.size ? expandChapters(doc, texts) : doc;
  }

  async word(): Promise<void> {
    const path = this.path();
    if (!path) return;
    // Navnet følger overskriften (9/10). Rust renser det og falder tilbage på filnavnet.
    const meta = await this.meta();
    const target = await invoke<string | null>("pick_export_path", { source: path, kind: "docx", title: meta.fromHeading ? meta.title : null });
    if (!target) return;
    try {
      const { wordDocument } = await import("./word.ts");
      // Word følger skabelonen og stilen fra Indstillinger, som PDF'en (ADR-0031).
      const s = settings();
      const bytes = await wordDocument(this.source(), meta, {
        includeDimmed: this.opts.includeDimmed,
        markup: this.opts.wordMarkup !== false,
        byline: this.opts.byline,
        counts: this.opts.counts,
        pageNumbers: this.opts.pageNumbers,
        images: this.opts.images,
        template: this.opts.template,
        book: s.paragraphs === "indryk",
        bullet: bulletChar(s),
        font: fontName(s.font),
        layout: this.design.layout,
        citations: this.opts.citations,
      });
      const saved = await invoke<string>("write_export", { bytes: Array.from(bytes) });
      const file = saved.slice(saved.lastIndexOf("\\") + 1);
      showBanner(tr(`Word-filen er gemt: ${file}`, `Word file saved: ${file}`), [
        { label: tr("Åbn", "Open"), run: () => void invoke("open_last_export") }
      ], { closable: true });
    } catch (e) {
      showBanner(errorText(e));
    }
  }
}

/** En overskrift og det, der står under den, i panelet. */
function section(title: string): HTMLElement {
  const el = document.createElement("section");
  el.className = "pv-section";
  const h = document.createElement("h2");
  h.textContent = title;
  el.append(h);
  return el;
}

/** Et valg i panelet: en radioknap eller et flueben, med en lille forklaring under, når der er en. */
function choice(type: "radio" | "checkbox", key: string, label: string, hint: string | null, checked: boolean, run: () => void): HTMLElement {
  const row = document.createElement("label");
  row.className = "pv-choice";
  const input = document.createElement("input");
  input.type = type;
  if (type === "radio") input.name = "pv-skabelon";
  input.checked = checked;
  input.dataset.pv = key;
  input.addEventListener("change", run);
  const text = document.createElement("span");
  const name = document.createElement("span");
  name.textContent = label;
  text.append(name);
  if (hint) {
    const small = document.createElement("small");
    small.textContent = hint;
    text.append(small);
  }
  row.append(input, text);
  return row;
}

/** A4 i cm. Bredden står i print.css. */
const PAGE_HEIGHT = 29.7;

/**
 * Print gentager en lang tabels overskriftsrække øverst på hver side, spalter gør ikke. Uden den
 * stod forhåndsvisningen en række forskudt fra PDF'en efter første delte tabel (29/10). Kopierne
 * lægges ind forfra hver gang, så resultatet, og dermed højden, er det samme ved næste kald.
 */
function repeatHeads(flow: HTMLElement, pitch: number): void {
  flow.querySelectorAll(".pv-repeat").forEach((r) => r.remove());
  const top = () => flow.getBoundingClientRect().top;
  const pageOf = (el: Element) => Math.floor((el.getBoundingClientRect().top - top() + 1) / pitch);
  for (const table of flow.querySelectorAll<HTMLTableElement>(".pv-long table")) {
    const head = table.tHead?.rows[0];
    if (!head) continue;
    let page = pageOf(head);
    for (const row of [...table.tBodies].flatMap((b) => [...b.rows])) {
      if (pageOf(row) > page) {
        const copy = head.cloneNode(true) as HTMLTableRowElement;
        copy.className = "pv-repeat";
        copy.setAttribute("aria-hidden", "true");
        row.before(copy);
      }
      page = pageOf(row);
    }
  }
}

/** Sidehoved eller sidefod på et ark: venstre, midte og højre, med sidetallet sat ind. */
function edge(className: string, row: Row, page: number): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  const text = (parts: Part[]) => parts.map((p) => (typeof p === "string" ? p : String(page))).join("");
  for (const side of ["left", "center", "right"] as const) {
    const cell = document.createElement("span");
    cell.textContent = text(row[side]);
    el.append(cell);
  }
  return el;
}

function button(label: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", run);
  return b;
}
