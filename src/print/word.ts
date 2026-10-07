// Word-eksport (ADR-0018): de samme markdown-tokens som print, til en .docx i »Manuskript«-form,
// som danske forlag, fonde og redaktører beder om: Times New Roman 12, »1,5 linjer«, 2,5 cm
// margen, »Side X af Y«, dansk sprog (ellers staver Word på engelsk) og ægte fodnoter.

import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  Footer,
  FootnoteReferenceRun,
  Header,
  HeadingLevel,
  LevelFormat,
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
import type { Token } from "markdown-it";

import { bodyFor, MARGINS, markdownIt, SPACE_MARK, surname, type Meta } from "./render.ts";
import { tr, isEnglish } from "../i18n.ts";

const FONT = "Times New Roman";
const CM = 567; // twips pr. cm

type Marks = { bold?: boolean; italics?: boolean; underline?: boolean; strike?: boolean; code?: boolean };

/** Inline-tokens → løb. Fodnotehenvisninger bliver Words egne fodnoter. */
function runs(children: Token[], notes: Map<number, number>, linesKept = false): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  const marks: Marks = {};
  let link: { href: string; runs: TextRun[] } | null = null;
  const text = (t: string) => {
    const opts: IRunOptions = {
      text: t,
      bold: marks.bold,
      italics: marks.italics,
      underline: marks.underline || link ? {} : undefined,
      strike: marks.strike,
      font: marks.code ? "Consolas" : undefined,
    };
    const run = new TextRun(opts);
    if (link) link.runs.push(run);
    else out.push(run);
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
        text(t.content ? tr(`[Billede: ${t.content}]`, `[Image: ${t.content}]`) : tr("[Billede]", "[Image]"));
        break;
    }
  }
  return out;
}

type Ctx = { notes: Map<number, number>; listStack: ("bullet" | "number")[]; listRefs: string[]; quote: number; listInstance: number; book: boolean; prevPlain: boolean };

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
        out.push(
          new Paragraph({
            ...(ctx.book && plain ? { spacing: { after: 0 }, indent: wasPlain ? { firstLine: 425 } : undefined } : {}),
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
        out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun("*   *   *")] }));
        break;
      case "fence":
      case "code_block":
        for (const line of t.content.replace(/\n$/, "").split("\n")) {
          out.push(new Paragraph({ children: [new TextRun({ text: line, font: "Consolas", size: 20 })] }));
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
            cells.push(new TableCell({ children: [new Paragraph({ children: runs(inline.children ?? [], ctx.notes) })] }));
          }
          if (c.type === "tr_close") rows.push(new TableRow({ children: cells, tableHeader: head }));
        }
        out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        i = j;
        break;
      }
    }
  }
  return out;
}

/** Fodnoternes indhold ligger sidst i tokenstrømmen (markdown-it-footnote). */
function footnotes(tokens: Token[], notes: Map<number, number>): Record<string, { children: Paragraph[] }> {
  const out: Record<string, { children: Paragraph[] }> = {};
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "footnote_open") continue;
    const id = notes.get((tokens[i].meta as { id: number }).id);
    const inner: Token[] = [];
    let j = i + 1;
    for (; tokens[j] && tokens[j].type !== "footnote_close"; j++) inner.push(tokens[j]);
    if (id) {
      const paras = blocks(inner, { notes, listStack: [], listRefs: [], quote: 0, listInstance: 0, book: false, prevPlain: false }).filter((p): p is Paragraph => p instanceof Paragraph);
      out[String(id)] = { children: paras };
    }
    i = j;
  }
  return out;
}

/** »Side X af Y« nederst, også på forsiden. */
function pageFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ size: 18, children: [tr("Side ", "Page "), PageNumber.CURRENT, tr(" af ", " of "), PageNumber.TOTAL_PAGES] })],
      }),
    ],
  });
}

export async function wordDocument(markdown: string, meta: Meta, includeDimmed: boolean, book = false, bullet = "•"): Promise<Uint8Array> {
  const tokens = markdownIt().parse(bodyFor(markdown, includeDimmed, meta), {});
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
  const header = [
    ...(meta.author ? [new Paragraph({ children: [new TextRun({ text: meta.author })] })] : []),
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: meta.title })] }),
    new Paragraph({ spacing: { after: 480 }, children: [new TextRun({ text: meta.countLine, size: 20 })] }),
  ];
  const doc = new Document({
    creator: meta.author,
    title: meta.title,
    styles: {
      default: {
        document: { run: { font: FONT, size: 24, language: { value: isEnglish() ? "en-GB" : "da-DK" } }, paragraph: { spacing: { line: 360, after: 120 } } },
        title: { run: { font: FONT, size: 32, bold: true, color: "000000" }, paragraph: { spacing: { after: 120 } } },
        heading1: { run: { font: FONT, size: 28, bold: true, color: "000000" }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true } },
        heading2: { run: { font: FONT, size: 24, bold: true, color: "000000" }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true } },
        heading3: { run: { font: FONT, size: 24, bold: true, italics: true, color: "000000" }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true } },
      },
      paragraphStyles: [
        { id: "Citat", name: "Citat", basedOn: "Normal", next: "Normal", paragraph: { indent: { left: CM } } },
        { id: "Manchet", name: "Manchet", basedOn: "Normal", next: "Normal", run: { bold: true } },
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
    footnotes: footnotes(tokens, notes),
    sections: [
      {
        properties: {
          titlePage: true,
          page: {
            size: { width: 11906, height: 16838 },
            margin: {
              top: MARGINS.manuskript.top * CM,
              right: MARGINS.manuskript.right * CM,
              bottom: MARGINS.manuskript.bottom * CM,
              left: MARGINS.manuskript.left * CM,
            },
          },
        },
        headers: {
          default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: [surname(meta.author), meta.title].filter(Boolean).join(" · "), size: 18 })] })] }),
          first: new Header({ children: [] }),
        },
        footers: {
          default: pageFooter(),
          first: pageFooter(),
        },
        children: [...header, ...blocks(tokens, { notes, listStack: [], listRefs: [], quote: 0, listInstance: 0, book, prevPlain: false })],
      },
    ],
  });
  const buffer = await Packer.toArrayBuffer(doc);
  return new Uint8Array(buffer);
}
