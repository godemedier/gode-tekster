// Word-eksport (ADR-0018, -0031): de samme markdown-tokens som print, til en .docx, der ligner den
// valgte skabelon. Manuskript er programmets egen stil: skriften fra Indstillinger, luftig
// linjeafstand, brede margener og citater med streg. Læseudgave er en side i et blad. Dansk sprog
// (ellers staver Word på engelsk) og ægte fodnoter i begge.

import {
  AlignmentType,
  BorderStyle,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  DeletedTextRun,
  Document,
  ExternalHyperlink,
  Footer,
  FootnoteReferenceRun,
  Header,
  HeadingLevel,
  InsertedTextRun,
  LevelFormat,
  LineRuleType,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
  type ParagraphChild,
} from "docx";
import JSZip from "jszip";
import type { Token } from "markdown-it";

import { bodyFor, countsLine, headLine, MARGINS, markdownIt, SPACE_MARK, type Meta, type Template } from "./render.ts";
import { tr, isEnglish } from "../i18n.ts";

const CM = 567; // twips pr. cm
const A4_WIDTH = 11906;

/**
 * Programmets skrifter følger med programmet, ikke med modtagerens Office. Word får den nærmeste
 * skrift, der findes i Office på både Windows og Mac.
 */
const WORD_FONTS: Record<string, string> = {
  "Recursive Halvmono": "Consolas",
  Literata: "Georgia",
  "Schibsted Grotesk": "Calibri",
  "IBM Plex Mono": "Consolas",
  "IBM Plex Sans": "Calibri",
  "IBM Plex Serif": "Georgia",
  "Avenir Next": "Calibri",
  Arial: "Arial",
  Georgia: "Georgia",
  "iA Writer Duo": "Consolas",
  "iA Writer Quattro": "Calibri",
};
export const wordFont = (programFont: string): string => WORD_FONTS[programFont] ?? "Consolas";

/** Punkter → Words enheder: halve punkter til skrift, twips til afstand. */
const half = (pt: number) => Math.round(pt * 2);
const tw = (pt: number) => Math.round(pt * 20);

/**
 * Skabelonens mål, oversat fra print.css (`.tpl-manuskript`, `.tpl-laeseudgave`), så Word og PDF
 * ligner hinanden. Linjeafstanden er »mindst«, så hævede tal ikke skæres.
 */
type Look = {
  font: string;
  pt: number;
  color: string;
  line: number;
  after: number;
  /** Indryk på afsnit efter afsnit (twips). 0 = luft imellem i stedet. */
  indent: number;
  hyphenate: boolean;
  head: { pt: number; color: string };
  title: { pt: number; line: number; after: number };
  /** Mellemrubrikker: størrelse, luft før og efter (pt), kursiv. */
  h: [number, number, number, boolean][];
  manchet: { pt: number; color: string; italic: boolean; line: number };
  quote: { border: number; color: string; pt: number };
  notes: number;
};

function lookFor(template: Template, programFont: string, book: boolean): Look {
  if (template === "laeseudgave") {
    return {
      font: "Georgia",
      pt: 11,
      color: "111111",
      line: tw(11 * 1.4),
      after: 0,
      indent: tw(11 * (book ? 1.5 : 1)),
      hyphenate: true,
      head: { pt: 8.5, color: "555555" },
      title: { pt: 24, line: tw(24 * 1.15), after: tw(8) },
      // # midt i teksten, ## og ### (print.css: h1 i brødteksten er sjælden, h2 14 pt, h3 11 pt kursiv).
      h: [
        [18, 16, 4, false],
        [14, 16, 4, false],
        [11, 12, 2, true],
      ],
      manchet: { pt: 13, color: "111111", italic: true, line: tw(13 * 1.35) },
      quote: { border: 12, color: "111111", pt: 11 * 1.12 },
      notes: 9,
    };
  }
  return {
    font: wordFont(programFont),
    pt: 10.5,
    color: "1F1F1F",
    line: tw(10.5 * 1.75),
    after: book ? 0 : tw(9),
    indent: book ? tw(10.5 * 1.5) : 0,
    hyphenate: false,
    head: { pt: 7.5, color: "888888" },
    title: { pt: 18, line: tw(18 * 1.25), after: tw(6) },
    h: [
      [15, 20, 8, false],
      [12.5, 18, 6, false],
      [10.5, 14, 4, false],
    ],
    manchet: { pt: 11, color: "555555", italic: false, line: tw(11 * 1.6) },
    quote: { border: 16, color: "1F1F1F", pt: 10.5 },
    notes: 9,
  };
}

export type WordOptions = {
  includeDimmed: boolean;
  /** Som i print (render.ts PrintOptions, 9/10): forfatter og dato, tal, sidetal, billeder. */
  byline?: boolean;
  counts?: boolean;
  pageNumbers?: boolean;
  images?: boolean;
  /** Noter som kommentarer og forslag som sporede ændringer (7/10). Ellers en ren udgave. */
  markup?: boolean;
  template?: Template;
  /** Afsnit som i bøger (Indstillinger, Afsnit). */
  book?: boolean;
  bullet?: string;
  /** Skriften fra Indstillinger. Manuskript bruger den. */
  font?: string;
};

/**
 * Noter og forslag med ud i Word (7/10): en note bliver en kommentar, et forslag, der ikke er taget
 * stilling til, en sporet ændring. De kodes som tegn fra Unicodes private område, før markdown-it
 * læser teksten, så de overlever parsningen og kan findes igen i løbene (`runs`):
 *   \uE000 n \uE001: note nr. n · \uE002 … \uE003: indsat · \uE004 gammel \uE005 ny \uE006: erstattet
 */
const NOTE_ANY = /(?:<!--(?!\s*gt:)([\s\S]*?)-->|\{>>([\s\S]*?)<<\})/;
const NOTE_ALONE = new RegExp(String.raw`[ \t]*\n[ \t]*(?:\n[ \t]*)?` + NOTE_ANY.source + String.raw`[ \t]*(?=\n|$)`, "g");
const NOTE_INLINE = new RegExp(String.raw`[ \t]?` + NOTE_ANY.source, "g");

export function encodeMarkup(md: string): { md: string; notes: string[] } {
  const notes: string[] = [];
  const note = (a?: string, b?: string) => {
    notes.push((a ?? b ?? "").trim());
    return `\uE000${notes.length - 1}\uE001`;
  };
  // En note på sin egen linje hæftes på slutningen af teksten før, ellers står den som et tomt afsnit.
  let out = md.replace(NOTE_ALONE, (_, a, b) => note(a, b));
  out = out.replace(NOTE_INLINE, (_, a, b) => note(a, b));
  out = out.replace(/\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g, (_, o: string, n: string) => `\uE004${o}\uE005${n}\uE006`);
  out = out.replace(/\{\+\+([\s\S]*?)\+\+\}/g, (_, n: string) => `\uE002${n}\uE003`);
  return { md: out, notes };
}

const REV_SWITCH: Record<string, "ins" | "del" | null> = { "\uE002": "ins", "\uE003": null, "\uE004": "del", "\uE005": "ins", "\uE006": null };

type Markup = {
  rev: "ins" | "del" | null;
  /** Næste id og forfatter til en sporet ændring. */
  change: () => { id: number; author: string; date: string };
  /** Kommentarens id for note nr. n (samme note giver samme id). */
  comment: (n: number) => number;
  used: Map<number, number>;
};
/** Sat, mens et dokument bygges med noter og forslag. Bygningen er synkron, til Packer kaldes. */
let markup: Markup | null = null;
/** Billeder med (som pladser); fra med »Kun tekst« (9/10). Sat, mens et dokument bygges. */
let withImages = true;

type Marks = { bold?: boolean; italics?: boolean; underline?: boolean; strike?: boolean; code?: boolean };

/** Inline-tokens → løb. Fodnotehenvisninger bliver Words egne fodnoter. */
function runs(children: Token[], notes: Map<number, number>, linesKept = false): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  const marks: Marks = {};
  let link: { href: string; runs: ParagraphChild[] } | null = null;
  const plain = (t: string) => {
    if (!t) return;
    const opts: IRunOptions = {
      text: t,
      bold: marks.bold,
      italics: marks.italics,
      underline: marks.underline || link ? {} : undefined,
      strike: marks.strike,
      font: marks.code ? "Consolas" : undefined,
    };
    // Et forslag, der ikke er taget stilling til, bliver en sporet ændring i Word (7/10).
    const rev = markup?.rev;
    const run = rev && markup ? new (rev === "ins" ? InsertedTextRun : DeletedTextRun)({ ...opts, ...markup.change() }) : new TextRun(opts);
    if (link) link.runs.push(run);
    else out.push(run);
  };
  // Mærkerne fra encodeMarkup: en note bliver en kommentar, de andre tænder og slukker en ændring.
  const text = (t: string) => {
    if (!markup || !/[\uE000-\uE006]/.test(t)) return plain(t);
    let last = 0;
    for (const m of t.matchAll(/\uE000(\d+)\uE001|[\uE002-\uE006]/g)) {
      plain(t.slice(last, m.index));
      last = (m.index ?? 0) + m[0].length;
      if (m[1] !== undefined) {
        const id = markup.comment(Number(m[1]));
        out.push(new CommentRangeStart(id), new CommentRangeEnd(id), new TextRun({ children: [new CommentReference(id)] }));
      } else {
        markup.rev = REV_SWITCH[m[0]] ?? null;
      }
    }
    plain(t.slice(last));
  };
  for (const t of children) {
    switch (t.type) {
      case "text":
        text(t.content);
        break;
      case "code_inline":
        marks.code = true;
        text(t.content);
        marks.code = false;
        break;
      case "softbreak":
        // I et citat står kilden (»– Navn«) på sin egen linje, som i editoren.
        if (linesKept) out.push(new TextRun({ break: 1 }));
        else text(" ");
        break;
      case "hardbreak":
        out.push(new TextRun({ break: 1 }));
        break;
      case "strong_open":
      case "strong_close":
        marks.bold = t.type === "strong_open";
        break;
      case "em_open":
      case "em_close":
        marks.italics = t.type === "em_open";
        break;
      case "s_open":
      case "s_close":
        marks.strike = t.type === "s_open";
        break;
      case "html_inline":
        if (/^<u>$/i.test(t.content)) marks.underline = true;
        else if (/^<\/u>$/i.test(t.content)) marks.underline = false;
        else if (!/^<!--/.test(t.content)) text(t.content);
        break;
      case "link_open":
        link = { href: String(t.attrGet("href") ?? ""), runs: [] };
        break;
      case "link_close":
        // Links ind i dokumentet (#…) bliver almindelig tekst.
        if (link && /^(https?:|mailto:)/i.test(link.href)) out.push(new ExternalHyperlink({ link: link.href, children: link.runs }));
        else if (link) out.push(...link.runs);
        link = null;
        break;
      case "footnote_ref": {
        const id = notes.get((t.meta as { id: number }).id);
        if (id) out.push(new FootnoteReferenceRun(id));
        break;
      }
      case "image":
        if (withImages) text(t.content ? tr(`[Billede: ${t.content}]`, `[Image: ${t.content}]`) : tr("[Billede]", "[Image]"));
        break;
    }
  }
  return out;
}

type Ctx = { notes: Map<number, number>; listStack: ("bullet" | "number")[]; listRefs: string[]; quote: number; listInstance: number; look: Look; book: boolean; prevPlain: boolean };

/** Nummereringens navn i Word ud fra listens type (a, A, i, I eller tal) og afgrænser (. eller )). */
function listRef(type: string | null, delim: string): string {
  return `${type ?? "tal"}${delim === ")" ? "-p" : ""}`;
}

/** Blok-tokens → afsnit og tabeller. */
function blocks(tokens: Token[], ctx: Ctx): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Bogafsnit: kun et almindeligt afsnit lige efter et andet almindeligt afsnit rykkes ind.
    const wasPlain = ctx.prevPlain;
    if (t.type !== "paragraph_close") ctx.prevPlain = false;
    switch (t.type) {
      // Fodnoternes indhold bliver Word-fodnoter (footnotes() nedenfor), ikke brødtekst.
      case "footnote_block_open":
        while (i < tokens.length && tokens[i].type !== "footnote_block_close") i++;
        break;
      case "heading_open": {
        const level = Number(t.tag.slice(1));
        const inline = tokens[i + 1];
        const heading = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][Math.min(level, 3) - 1];
        // #### og dybere er manchet (STRATEGI): fed brødtekst, ikke en overskrift.
        out.push(level >= 4 ? new Paragraph({ children: runs(inline.children ?? [], ctx.notes), style: "Manchet" }) : new Paragraph({ heading, children: runs(inline.children ?? [], ctx.notes) }));
        i += 2;
        break;
      }
      case "paragraph_open": {
        const inline = tokens[i + 1];
        if (inline.content === SPACE_MARK) {
          if (ctx.book) out.push(new Paragraph({ spacing: { after: 0 }, children: [] }));
          i += 2;
          break;
        }
        const list = ctx.listStack[ctx.listStack.length - 1];
        const level = ctx.listStack.length - 1;
        const plain = !list && ctx.quote === 0;
        // Listepunkter står tæt som i print. Luften kommer efter det sidste punkt.
        const lastItem = /^(bullet|ordered)_list_close$/.test(tokens[i + 4]?.type ?? "");
        const listSpacing = list ? { spacing: { after: lastItem ? Math.max(ctx.look.after, tw(6)) : tw(2) } } : {};
        out.push(
          new Paragraph({
            ...listSpacing,
            ...(ctx.look.indent && plain ? { spacing: { after: 0 }, indent: wasPlain ? { firstLine: ctx.look.indent } : undefined } : {}),
            children: runs(inline.children ?? [], ctx.notes, ctx.quote > 0),
            style: ctx.quote > 0 ? "Citat" : undefined,
            numbering: list === "bullet" ? { reference: "punkt", level } : list === "number" ? { reference: ctx.listRefs[ctx.listRefs.length - 1] ?? "tal", level, instance: ctx.listInstance } : undefined,
          }),
        );
        ctx.prevPlain = plain;
        i += 2;
        break;
      }
      case "bullet_list_open":
        ctx.listStack.push("bullet");
        ctx.listRefs.push("punkt");
        break;
      case "ordered_list_open":
        ctx.listStack.push("number");
        ctx.listRefs.push(listRef(t.attrGet("type") as string | null, t.markup));
        if (ctx.listStack.length === 1) ctx.listInstance++;
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        ctx.listStack.pop();
        ctx.listRefs.pop();
        break;
      case "blockquote_open":
        ctx.quote++;
        break;
      case "blockquote_close":
        ctx.quote--;
        break;
      case "hr":
        out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: tw(ctx.look.pt * 1.2), after: tw(ctx.look.pt * 1.2) }, children: [new TextRun("*   *   *")] }));
        break;
      case "fence":
      case "code_block":
        for (const line of t.content.replace(/\n$/, "").split("\n")) {
          out.push(new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: line, font: "Consolas", size: half(ctx.look.pt * 0.88) })] }));
        }
        break;
      case "table_open": {
        const rows: TableRow[] = [];
        let cells: TableCell[] = [];
        let head = false;
        let j = i + 1;
        for (; j < tokens.length && tokens[j].type !== "table_close"; j++) {
          const c = tokens[j];
          if (c.type === "thead_open") head = true;
          if (c.type === "thead_close") head = false;
          if (c.type === "tr_open") cells = [];
          if (c.type === "th_open" || c.type === "td_open") {
            const inline = tokens[j + 1];
            cells.push(new TableCell({ children: [new Paragraph({ style: "Tabel", children: runs(inline.children ?? [], ctx.notes) })] }));
          }
          if (c.type === "tr_close") rows.push(new TableRow({ children: cells, tableHeader: head }));
        }
        // Tynde grå streger og lidt luft i cellerne, som i print.
        const rule = { style: BorderStyle.SINGLE, size: 4, color: "999999" };
        // En tabel kan ikke selv have luft om sig i Word. Et lavt tomt afsnit før og efter giver den.
        const spacer = () => new Paragraph({ spacing: { before: 0, after: 0, line: tw(ctx.look.pt * 0.8), lineRule: LineRuleType.EXACT }, children: [] });
        out.push(spacer());
        out.push(
          new Table({
            rows,
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: { top: rule, bottom: rule, left: rule, right: rule, insideHorizontal: rule, insideVertical: rule },
            margins: { top: tw(3), bottom: tw(3), left: tw(6), right: tw(6) },
          }),
          spacer(),
        );
        i = j;
        break;
      }
    }
  }
  return out;
}

/** Fodnoternes indhold ligger sidst i tokenstrømmen (markdown-it-footnote). */
function footnotes(tokens: Token[], notes: Map<number, number>, look: Look): Record<string, { children: Paragraph[] }> {
  const out: Record<string, { children: Paragraph[] }> = {};
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "footnote_open") continue;
    const id = notes.get((tokens[i].meta as { id: number }).id);
    const inner: Token[] = [];
    let j = i + 1;
    for (; tokens[j] && tokens[j].type !== "footnote_close"; j++) inner.push(tokens[j]);
    if (id) {
      const paras = blocks(inner, { notes, listStack: [], listRefs: [], quote: 0, listInstance: 0, look: { ...look, indent: 0 }, book: false, prevPlain: false }).filter((p): p is Paragraph => p instanceof Paragraph);
      out[String(id)] = { children: paras };
    }
    i = j;
  }
  return out;
}

/**
 * Sidehoved og sidefod som skabelonens `@page` (render.ts `pageCss`, 9/10): forfatter og dato øverst
 * på hver side, anslag og ord nederst på første side, sidetal nederst fra side 2. Hver del kan vælges fra.
 */
function pageParts(look: Look, meta: Meta, opts: WordOptions) {
  const small = { size: half(7.5), color: "8A8F94" };
  const line = (children: (string | typeof PageNumber.CURRENT)[]) =>
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ ...small, font: look.font, children })] });
  const head = headLine(opts, meta);
  const counts = countsLine(opts, meta);
  const header = head ? new Header({ children: [line([head])] }) : new Header({ children: [] });
  return {
    headers: { default: header, first: header },
    footers: {
      default: new Footer({ children: opts.pageNumbers === false ? [] : [line([PageNumber.CURRENT])] }),
      first: new Footer({ children: counts ? [line([counts])] : [] }),
    },
  };
}

/** »Kim Skribent« → »KS«, til Words kommentarer. */
function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join("").slice(0, 3) || "GT";
}

/** Titelblokken som i print (render.ts `articleHtml`): titlen kun fra teksten, linjen under kun det valgte. */
function titleBlock(meta: Meta): Paragraph[] {
  return meta.startsWithTitle ? [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: meta.title })] })] : [];
}

export async function wordDocument(markdown: string, meta: Meta, opts: WordOptions): Promise<Uint8Array> {
  const template = opts.template ?? "manuskript";
  const book = opts.book ?? false;
  const bullet = opts.bullet ?? "•";
  const look = lookFor(template, opts.font ?? "", book);
  const m = MARGINS[template];
  // Noter og forslag med: kodes før parsningen, kommentarerne samles, mens løbene bygges.
  const encoded = opts.markup ? encodeMarkup(markdown) : null;
  const author = meta.author || "Gode Tekster";
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let changeId = 0;
  const used = new Map<number, number>();
  markup = encoded
    ? { rev: null, used, change: () => ({ id: ++changeId, author, date: stamp }), comment: (n) => used.get(n) ?? (used.set(n, used.size + 1), used.size) }
    : null;
  const tokens = markdownIt().parse(bodyFor(encoded?.md ?? markdown, opts.includeDimmed, meta), {});
  // markdown-it nummererer noterne 0, 1, 2 i brugsrækkefølge. Word vil have 1, 2, 3.
  const notes = new Map<number, number>();
  for (const t of tokens) {
    for (const c of t.children ?? []) {
      if (c.type === "footnote_ref") {
        const id = (c.meta as { id: number }).id;
        if (!notes.has(id)) notes.set(id, notes.size + 1);
      }
    }
  }
  const parts = pageParts(look, meta, opts);
  withImages = opts.images !== false;
  const { font, color } = look;
  const atLeast = (line: number) => ({ line, lineRule: LineRuleType.AT_LEAST });
  const heading = ([pt, before, after, italics]: [number, number, number, boolean]) => ({
    run: { font, size: half(pt), bold: true, italics, color },
    paragraph: { spacing: { before: tw(before), after: tw(after), ...atLeast(tw(pt * 1.3)) }, keepNext: true },
  });
  const noteParts = footnotes(tokens, notes, look);
  const body = [...titleBlock(meta), ...blocks(tokens, { notes, listStack: [], listRefs: [], quote: 0, listInstance: 0, look, book, prevPlain: false })];
  const comments = [...used].map(([n, id]) => ({ id, author, initials: initials(author), date: new Date(stamp), children: [new Paragraph({ children: [new TextRun(encoded?.notes[n] ?? "")] })] }));
  markup = null;
  const doc = new Document({
    creator: meta.author,
    title: meta.title,
    ...(comments.length ? { comments: { children: comments } } : {}),
    ...(look.hyphenate ? { hyphenation: { autoHyphenation: true } } : {}),
    styles: {
      default: {
        document: {
          run: { font, size: half(look.pt), color, language: { value: isEnglish() ? "en-GB" : "da-DK" } },
          paragraph: { spacing: { after: look.after, ...atLeast(look.line) } },
        },
        title: { run: { font, size: half(look.title.pt), bold: true, color }, paragraph: { spacing: { after: look.title.after, ...atLeast(look.title.line) } } },
        heading1: heading(look.h[0]),
        heading2: heading(look.h[1]),
        heading3: heading(look.h[2]),
        hyperlink: { run: { color, underline: {} } },
        footnoteText: { run: { font, size: half(look.notes), color: "333333" }, paragraph: { spacing: { after: tw(3), ...atLeast(tw(look.notes * 1.45)) } } },
      },
      paragraphStyles: [
        // Citatet som i editoren (citat A): en mørk streg til venstre og kursiv.
        {
          id: "Citat",
          name: "Citat",
          basedOn: "Normal",
          next: "Normal",
          run: { italics: true, size: half(look.quote.pt) },
          paragraph: {
            indent: { left: tw(14) },
            spacing: { before: tw(10), after: tw(10) },
            border: { left: { style: BorderStyle.SINGLE, size: look.quote.border, color: look.quote.color, space: 12 } },
          },
        },
        {
          id: "Manchet",
          name: "Manchet",
          basedOn: "Normal",
          next: "Normal",
          run: { size: half(look.manchet.pt), color: look.manchet.color, italics: look.manchet.italic },
          paragraph: { spacing: { after: tw(12), ...atLeast(look.manchet.line) } },
        },
        // keepNext holder en tabel samlet på én side, som `break-inside: avoid` i print.
        { id: "Tabel", name: "Tabel", basedOn: "Normal", run: { size: half(look.pt * 0.92) }, paragraph: { keepNext: true, spacing: { after: 0, ...atLeast(tw(look.pt * 0.92 * 1.3)) } } },
      ],
    },
    numbering: {
      config: [
        // Punkttegnet efter indstillingen (5/10), og en nummerering pr. form: 1. 1) a. a) A. A) i. i) I. I).
        {
          reference: "punkt",
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: bullet,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: CM * (level + 1), hanging: CM / 2 } } },
          })),
        },
        ...([
          ["tal", LevelFormat.DECIMAL],
          ["a", LevelFormat.LOWER_LETTER],
          ["A", LevelFormat.UPPER_LETTER],
          ["i", LevelFormat.LOWER_ROMAN],
          ["I", LevelFormat.UPPER_ROMAN],
        ] as const).flatMap(([ref, format]) =>
          [".", ")"].map((delim) => ({
            reference: listRef(ref, delim),
            levels: [0, 1, 2].map((level) => ({
              level,
              format,
              text: `%${level + 1}${delim}`,
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: CM * (level + 1), hanging: CM / 2 } } },
            })),
          })),
        ),
      ],
    },
    footnotes: noteParts,
    sections: [
      {
        properties: {
          titlePage: true,
          page: {
            size: { width: A4_WIDTH, height: 16838 },
            margin: {
              top: Math.round(m.top * CM),
              right: Math.round(m.right * CM),
              bottom: Math.round(m.bottom * CM),
              left: Math.round(m.left * CM),
            },
          },
        },
        ...parts,
        children: body,
      },
    ],
  });
  const bytes = new Uint8Array(await Packer.toArrayBuffer(doc));
  return look.hyphenate ? withoutHyphensInHeadings(bytes) : bytes;
}

/**
 * Orddeling i brødteksten, aldrig i titel og mellemrubrikker (print.css: `hyphens: manual`).
 * docx kan ikke slå den fra pr. typografi, så `<w:suppressAutoHyphens/>` sættes ind bagefter,
 * lige før `<w:spacing>`, som skemaet kræver rækkefølgen.
 */
async function withoutHyphensInHeadings(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file("word/styles.xml");
  if (!file) return bytes;
  const xml = (await file.async("string")).replace(
    /(<w:style\b[^>]*w:styleId="(?:Title|Heading[1-3])"[\s\S]*?<w:pPr>[\s\S]*?)(<w:spacing\b)/g,
    "$1<w:suppressAutoHyphens/>$2",
  );
  zip.file("word/styles.xml", xml);
  return zip.generateAsync({ type: "uint8array" });
}
