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

// Print-laget (markdown-it) hentes først, når der skal printes, så opstarten ikke betaler for det.
const load = () => import("./render.ts");

// Ny nøgle 9/10: forfatter, dato og tal er nu med som standard, også for den, der havde valgt dem fra.
const KEY = "gt-print-2";

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
  private opts = storedOptions();

  constructor(view: EditorView, path: () => string | null) {
    this.view = view;
    this.path = path;
    this.root = document.createElement("div");
    this.root.id = "print-root";
    this.bar = document.createElement("div");
    this.bar.className = "pv-bar";
    this.paper = document.createElement("div");
    this.paper.className = "pv-paper";
    this.root.append(this.bar, this.paper);
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

  private async meta(): Promise<Meta> {
    const { metaFor } = await load();
    const path = this.path() ?? tr("Tekst.md", "Text.md");
    const name = path.slice(path.lastIndexOf("\\") + 1);
    return metaFor(this.view.state.doc.toString(), name, this.view.state.field(authorshipField).me.name);
  }

  /** Tegn artiklen og `@page`-reglerne for den valgte skabelon. */
  private async render(): Promise<void> {
    const { articleHtml, pageMargins, pageCss } = await load();
    const meta = await this.meta();
    const t = this.opts.template;
    const m = pageMargins(t);
    this.pageStyle.textContent = pageCss(t, meta, this.opts);
    this.paper.style.padding = `${m.top}cm ${m.right}cm ${m.bottom}cm ${m.left}cm`;
    const article = document.createElement("article");
    // Orddeling i print og PDF følger sproget.
    article.lang = currentLang();
    article.className = `pv-article tpl-${t}${settings().paragraphs === "indryk" ? " afsnit-indryk" : ""}`;
    article.style.setProperty("--punkt", `"${bulletChar(settings())}  "`);
    // articleHtml escaper alt fra teksten undtagen <u> (render.ts), så det er sikkert her.
    article.innerHTML = articleHtml(this.view.state.doc.toString(), this.opts, meta, imageUrl);
    this.paper.replaceChildren(article);
    this.renderBar();
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
      const b = button(label, () => this.setOptions({ template: value }));
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(this.opts.template === value));
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
    const gap = document.createElement("span");
    gap.className = "pv-gap";
    this.bar.replaceChildren(
      seg,
      content,
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
      const saved = await invoke<string>("export_pdf", { margins: pageMargins(this.opts.template) });
      const file = saved.slice(saved.lastIndexOf("\\") + 1);
      notify(tr(`PDF'en er gemt: ${file}`, `PDF saved: ${file}`));
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
      });
      const saved = await invoke<string>("write_export", { bytes: Array.from(bytes) });
      const file = saved.slice(saved.lastIndexOf("\\") + 1);
      notify(tr(`Word-filen er gemt: ${file}`, `Word file saved: ${file}`));
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
