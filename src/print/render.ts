// Print-laget (ADR-0011, -0017): markdown → HTML til Ctrl+P, PDF og forhåndsvisning, og de samme
// tokens til Word (word.ts). Fraklip er fjernet før rendering. Dæmpet tekst udelades, medmindre
// brugeren vælger den med. Fodnoter samles sidst som »Noter«, fordi Chromium ikke kan sætte dem
// nederst på siden.

import MarkdownItLib, { type MarkdownIt } from "markdown-it";
import footnote from "markdown-it-footnote";
import { fancyLists } from "./fancyListsMd.ts";

import { withoutParked } from "../editor/parked.ts";
import { count, formatCount } from "../editor/count.ts";
import { danishDate, longDate } from "../editor/dates.ts";
import { tr, isEnglish } from "../i18n.ts";

export { danishDate };

export type Template = "manuskript" | "laeseudgave";
export type PrintOptions = {
  template: Template;
  includeDimmed: boolean;
  /** Kun Word: noter og forslag med (7/10). */
  wordMarkup?: boolean;
  /** Forfatter og dato i sidehovedet. Standard: til (9/10). */
  byline?: boolean;
  /** Anslag og ord i sidefoden på første side (det, en redaktion beder om). Standard: til. */
  counts?: boolean;
  /** Sidetal nederst fra side 2. Standard: til. */
  pageNumbers?: boolean;
  /** Billeder med. Fra: kun teksten (9/10). Standard: til. */
  images?: boolean;
};

/** Margener i cm, som skabelonens `@page` (og PDF-kaldet i Rust). */
export const MARGINS: Record<Template, { top: number; right: number; bottom: number; left: number }> = {
  manuskript: { top: 3.5, right: 4.5, bottom: 3, left: 4.5 },
  laeseudgave: { top: 2.5, right: 4, bottom: 3, left: 4 },
};

const NBSP = " ";

/**
 * Hvor langt tabeller og billeder må gå ud i margenen, i cm (9/10). Chromium klipper alt til venstre
 * for sidens indholdsområde, så siden får en smallere margen, og artiklen polstres med det samme.
 */
export const UDFALD = 2;

/** Sidens egne margener: skabelonens, minus udfaldet i siderne (`@page`, Ctrl+R og PDF-kaldet i Rust). */
export function pageMargins(t: Template): { top: number; right: number; bottom: number; left: number } {
  const m = MARGINS[t];
  return { ...m, left: m.left - UDFALD, right: m.right - UDFALD };
}

/**
 * Afstand i en tekst med indrykning (3/10): to eller flere tomme linjer mellem afsnit betyder
 * »luft her«. Markdown slår dem sammen til ét afsnitsskift, så de bliver til et afsnit med kun dette
 * usynlige tegn, som print (render.ts) og Word (word.ts) kender.
 */
export const SPACE_MARK = "\u2063";

/** Teksten, som den skal trykkes: uden fraklip og (som standard) uden dæmpet tekst. */
export function prepare(markdown: string, includeDimmed: boolean): string {
  let md = withoutParked(markdown);
  md = includeDimmed ? md.replace(/\{--([\s\S]*?)--\}/g, "$1") : md.replace(/[ \t]?\{--[\s\S]*?--\}/g, "");
  return md
    .split(/(^```[\s\S]*?^```\s*$)/m)
    .map((part, i) => (i % 2 === 1 ? part : typography(part).replace(/\n(?:[ \t]*\n){2,}(?=\S)/g, `\n\n${SPACE_MARK}\n\n`)))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/** Hårde mellemrum og tankestreg, som en sætter ville gøre (ADR-0012). Intervaller røres ikke. */
export function typography(text: string): string {
  const out = text
    // Opgavelister: markdown-it kender dem ikke, så boksene sættes som tegn.
    .replace(/^(\s*[-*+]\s+)\[ \]\s/gm, "$1☐ ")
    .replace(/^(\s*[-*+]\s+)\[[xX]\]\s/gm, "$1☒ ")
    .replace(/(\S) - (\S)/g, "$1 – $2")
    .replace(/(\S) –/g, `$1${NBSP}–`)
    .replace(/(\d) (%|km|kg|cm|mm|m²)/g, `$1${NBSP}$2`);
  // Danske forkortelser og datoer får hårde mellemrum, kun på dansk.
  return isEnglish() ? out : danish(out);
}

function danish(text: string): string {
  return text
    .replace(/(\d) (kr\.|mio\.|mia\.|pct\.)/g, `$1${NBSP}$2`)
    .replace(/\b(kl\.|nr\.|s\.|ca\.) (\d)/g, `$1${NBSP}$2`)
    .replace(/(\d{1,2}\.) (januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december)\b/g, `$1${NBSP}$2`);
}

/** Slår et billedes sti op til en URL, fladen kan vise. Uden en (tests, Word) bliver billedet en plads. */
export type ImageUrl = (src: string) => string | null;

export function markdownIt(imageUrl?: ImageUrl, withImages = true): MarkdownIt {
  const md = new MarkdownItLib({ html: true, linkify: false, typographer: false });
  md.use(footnote);
  md.use(fancyLists);
  // Kun <u> og </u> må stå som HTML i teksten. Alt andet vises som tekst (ingen scripts, ingen
  // billeder udefra, ingen styles i print-DOM'en).
  const allowed = /^<\/?u>$/i;
  md.renderer.rules.html_inline = (tokens, idx) =>
    /^<!--/.test(tokens[idx].content) ? "" : allowed.test(tokens[idx].content) ? tokens[idx].content.toLowerCase() : md.utils.escapeHtml(tokens[idx].content);
  md.renderer.rules.html_block = (tokens, idx) => (/^<!--/.test(tokens[idx].content) ? "" : `<p>${md.utils.escapeHtml(tokens[idx].content)}</p>`);
  // Fodnotetal uden klammer, som i en bog: ¹ ikke [1].
  md.renderer.rules.footnote_caption = (tokens, idx) => String(Number((tokens[idx].meta as { id: number }).id) + 1);
  // Lokale billeder via asset-protokollen (editor/images.ts), med alt-teksten som billedtekst. Uden
  // en vej til billedet en tydelig plads frem for et brudt billede. »Kun tekst« udelader dem (9/10).
  md.renderer.rules.image = (tokens, idx) => {
    if (!withImages) return "";
    const t = tokens[idx];
    const alt = md.utils.escapeHtml(t.content);
    const url = imageUrl?.(String(t.attrGet("src") ?? ""));
    if (!url) return `<span class="img-missing">[${tr("Billede", "Image")}${alt ? `: ${alt}` : ""}]</span>`;
    return `<span class="pv-fig"><img src="${md.utils.escapeHtml(url)}" alt="${alt}">${alt ? `<em class="pv-cap">${alt}</em>` : ""}</span>`;
  };
  // Tabeller og billeder må gå ud i margenen (9/10), så kolonnerne får plads.
  md.renderer.rules.table_open = () => '<div class="pv-wide"><table>\n';
  md.renderer.rules.table_close = () => "</table></div>\n";
  // Tilbagelinket ↩︎ giver ingen mening på papir.
  md.renderer.rules.footnote_anchor = () => "";
  md.renderer.rules.footnote_block_open = () => `<section class="footnotes"><h2 class="notes-title">${tr("Noter", "Notes")}</h2><ol class="footnotes-list">\n`;
  // Links må kun pege ud på nettet eller ind i dokumentet. Relative stier (billeder i `medier/`) er
  // tilladt: markdown-it bruger samme tjek for billeder, og før 9/10 kom ingen billeder med.
  const validate = md.validateLink.bind(md);
  md.validateLink = (url) => validate(url) && (/^(https?:|mailto:|#)/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url));
  return md;
}

export type Meta = {
  title: string;
  author: string;
  date: string;
  countLine: string;
  words: string;
  startsWithTitle: boolean;
  /** Titlen er tekstens første overskrift, ikke filnavnet (9/10: navnet på en PDF eller Word-fil). */
  fromHeading: boolean;
};

export function metaFor(markdown: string, fileName: string, author: string, now = new Date()): Meta {
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(withoutParked(markdown));
  const first = withoutParked(markdown).trimStart();
  const c = count(markdown);
  const f = formatCount(c);
  return {
    title: h1 ? h1[1].replace(/[*_`]/g, "") : fileName.replace(/\.(md|markdown|txt)$/i, ""),
    author,
    date: longDate(now),
    countLine: tr(`${f.long[1]} inkl. mellemrum (${f.long[2]}) · ${f.long[0]}`, `${f.long[1]} incl. spaces (${f.long[2]}) · ${f.long[0]}`),
    words: f.long[0],
    startsWithTitle: /^#\s/.test(first),
    fromHeading: h1 !== null,
  };
}

export function surname(name: string): string {
  return name.trim().split(/\s+/).pop() ?? name;
}

function cssString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

/** Forfatter og dato, som de står i sidehovedet, når de er valgt (standard). */
export function headLine(opts: Partial<PrintOptions>, meta: Meta): string {
  return opts.byline === false ? "" : [meta.author, meta.date].filter(Boolean).join(" · ");
}

/** Anslag og ord, som de står i sidefoden på første side, når de er valgt (standard). */
export function countsLine(opts: Partial<PrintOptions>, meta: Meta): string {
  return opts.counts === false ? "" : meta.countLine;
}

/**
 * `@page` kan ikke afgrænses med en klasse, så reglerne skrives for den valgte skabelon (9/10):
 * forfatter og dato i en lille grotesk øverst på hver side, anslag og ord nederst på første side,
 * sidetal nederst fra side 2. Alt kan vælges fra under »Indhold«.
 */
export function pageCss(t: Template, meta: Meta, opts: Partial<PrintOptions> = {}): string {
  const m = pageMargins(t);
  const margin = `${m.top}cm ${m.right}cm ${m.bottom}cm ${m.left}cm`;
  const small = `font: 7.5pt "Schibsted Grotesk", sans-serif; color: #8a8f94; font-variant-numeric: tabular-nums;`;
  const head = headLine(opts, meta);
  const counts = countsLine(opts, meta);
  const top = head ? `@top-center { content: ${cssString(head)}; ${small} }` : "";
  const bottom = opts.pageNumbers === false ? "" : `@bottom-center { content: counter(page); ${small} }`;
  return `@page { size: A4; margin: ${margin}; ${top} ${bottom} }
@page :first { @bottom-center { content: ${counts ? cssString(counts) : "none"}; ${small} } }`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Brødteksten til print og Word: forberedt, og uden titlen, som skabelonen sætter selv. */
export function bodyFor(markdown: string, includeDimmed: boolean, meta: Meta): string {
  const body = prepare(markdown, includeDimmed);
  return meta.startsWithTitle ? body.replace(/^\s*#\s+.+\n?/, "") : body;
}

/** Hele artiklen som HTML (uden `@page`). Titlen er tekstens egen første overskrift, ikke filnavnet. */
export function articleHtml(markdown: string, opts: PrintOptions, meta: Meta, imageUrl?: ImageUrl): string {
  const html = markdownIt(imageUrl, opts.images !== false)
    .render(bodyFor(markdown, opts.includeDimmed, meta))
    .replaceAll(`<p>${SPACE_MARK}</p>`, '<p class="luft" aria-hidden="true"></p>')
    // Et afsnit med kun et billede bliver en figur, der må gå ud i margenen.
    .replace(/<p><span class="pv-fig">([\s\S]*?)<\/span><\/p>/g, '<figure class="pv-wide pv-fig">$1</figure>')
    // Et afsnit, der kun var et billede, står tomt, når billederne er fravalgt.
    .replace(/<p>\s*<\/p>\n?/g, "");
  if (!meta.startsWithTitle) return html;
  return `<header class="pv-head"><h1 class="pv-title">${esc(meta.title)}</h1></header>${html}`;
}
