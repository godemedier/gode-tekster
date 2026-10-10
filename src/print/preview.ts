// Forhåndsvisning og udskrift (Ctrl+P, 9/10: én indgang) og eksport til PDF og Word (ADR-0011, -0018).
// Print-DOM'en tegnes på ny før hver udskrift, så den altid viser teksten, som den er nu.

import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";

import { authorshipField } from "../editor/authorship.ts";
import { imageUrl } from "../editor/images.ts";
import { findNotes, findRevisions } from "../editor/critic.ts";
import { bulletChar, settings } from "../settings.ts";
import { errorText, notify, showBanner } from "../ui/banner.ts";
import { fontName } from "../ui/settingspanel.ts";
import type { Meta, PrintOptions, Template } from "./render.ts";
import { tr, currentLang } from "../i18n.ts";
import { showMenu, type MenuItem } from "../ui/menu.ts";
import { cloneLayout, defaultLayout, layoutFrom, nativeFont, templatesFrom, withTemplate, type PageLayout, type SavedTemplate } from "./layout.ts";
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
    this.side.setAttribute("aria-label", tr("Design", "Design"));
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
    await this.render();
    document.body.classList.add("print-preview");
    this.root.tabIndex = -1;
    this.root.focus();
  }

  close(): void {
    if (this.designing) this.toggleDesign(false);
    document.body.classList.remove("print-preview");
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
    if (redraw) void this.render();
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
    this.paper.style.padding = `${m.top}cm ${m.right}cm ${m.bottom}cm ${m.left}cm`;
    const article = document.createElement("article");
    // Orddeling i print og PDF følger sproget.
    article.lang = currentLang();
    // En anden skrift end skabelonens egen er et valg i side-designeren (print.css .skrift-*).
    const font = layout.font !== nativeFont(t) ? ` skrift-${layout.font}` : "";
    article.className = `pv-article tpl-${t}${font}${settings().paragraphs === "indryk" ? " afsnit-indryk" : ""}`;
    article.style.setProperty("--punkt", `"${bulletChar(settings())}  "`);
    // articleHtml escaper alt fra teksten undtagen <u> (render.ts), så det er sikkert her.
    article.innerHTML = articleHtml(this.view.state.doc.toString(), { ...this.opts, title: layout.title }, meta, imageUrl);
    this.paper.replaceChildren(article);
    this.renderBar();
    if (this.designing) (await this.ensureDesigner()).mount(this.paper, this.side, meta);
  }

  private renderBar(): void {
    const seg = document.createElement("div");
    seg.className = "pv-seg";
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", tr("Skabelon", "Template"));
    const choices: [Template, string][] = [
      ["manuskript", tr("Som på skærmen", "As on screen")],
      ["laeseudgave", tr("Som i et blad", "As in a magazine")],
    ];
    for (const [value, label] of choices) {
      const b = button(label, () => this.chooseTemplate(value));
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(!this.design.selected && this.opts.template === value));
      seg.append(b);
    }
    // Egne skabeloner fra side-designeren står ved siden af de to faste.
    for (const saved of this.design.templates) {
      const b = button(saved.name, () => this.chooseSaved(saved.name));
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(this.design.selected === saved.name));
      seg.append(b);
    }
    // Hvad der kommer med (9/10): ét valg med flueben i stedet for en række afkrydsningsfelter. Menuen
    // åbner igen efter hvert valg, så flere kan slås til og fra i én omgang.
    const doc = this.view.state.doc.toString();
    const hasMarkup = findNotes(doc).length > 0 || findRevisions(doc).length > 0;
    const content = button(tr("Indhold", "Content"), () => openContent());
    content.className = "pv-menu";
    content.setAttribute("aria-haspopup", "menu");
    const openContent = () => {
      const r = (this.bar.querySelector<HTMLElement>(".pv-menu") ?? content).getBoundingClientRect();
      const item = (label: string, checked: boolean, patch: Partial<PrintOptions>): MenuItem => ({
        label,
        checked,
        run: () => {
          this.setOptions(patch);
          // Linjen tegnes forfra, så knappen er ny: menuen åbner ved den nye (9/10: den hoppede væk).
          window.setTimeout(openContent, 0);
        },
      });
      const o = this.opts;
      showMenu(r.left, r.bottom + 4, [
        item(tr("Forfatter og dato", "Author and date"), o.byline === true, { byline: !o.byline }),
        item(tr("Antal tegn og ord", "Characters and words"), o.counts === true, { counts: !o.counts }),
        item(tr("Sidetal", "Page numbers"), o.pageNumbers !== false, { pageNumbers: o.pageNumbers === false }),
        { separator: true },
        item(tr("Billeder", "Images"), o.images !== false, { images: o.images === false }),
        item(tr("Dæmpet tekst", "Dimmed text"), o.includeDimmed, { includeDimmed: !o.includeDimmed }),
        // Noter og forslag med ud i Word som kommentarer og sporede ændringer (7/10). Kun når teksten har nogen.
        ...(hasMarkup ? [item(tr("Kommentarer og rettelser i Word", "Comments and changes in Word"), o.wordMarkup !== false, { wordMarkup: o.wordMarkup === false })] : []),
      ]);
    };
    const design = button(tr("Design", "Design"), () => this.toggleDesign());
    design.setAttribute("aria-pressed", String(this.designing));
    design.className = "pv-toggle";
    const gap = document.createElement("span");
    gap.className = "pv-gap";
    this.bar.replaceChildren(
      seg,
      content,
      design,
      gap,
      button(tr("Udskriv", "Print"), () => void this.print()),
      Object.assign(button(tr("Gem som PDF", "Save as PDF"), () => void this.pdf()), { className: "pv-primary" }),
      button(tr("Gem som Word", "Save as Word"), () => void this.word()),
      button(tr("Kopiér tekst", "Copy text"), () => void import("./copyRich.ts").then((m) => m.copyRich(this.view))),
      Object.assign(button(tr("Luk", "Close"), () => this.close()), { className: "pv-quiet" }),
    );
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
      const bytes = await wordDocument(this.view.state.doc.toString(), meta, {
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

function button(label: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", run);
  return b;
}
