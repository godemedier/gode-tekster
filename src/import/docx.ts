// Word-import (plan 2-9 del G, 2/10): en .docx bliver en ny .md ved siden af. mammoth læser
// Word-filen til enkel HTML, og den oversættes her til den markdown, Gode Tekster skriver:
// overskrifter, fed, kursiv, <u>, ~~gennemstreget~~, lister, citater, tabeller og fodnoter som
// [^n]. Billeder kommer ikke med (convertImage giver en tom kilde); de bliver en plads med alt-teksten.
//
// HTML'en kommer fra mammoth og er velformet og enkel, så en lille parser her er nok og virker
// både i WebView2 og i Node (testene).

import mammoth from "mammoth";

import { tr } from "../i18n.ts";

type El = { tag: string; attrs: Record<string, string>; children: Node[] };
type Node = El | string;

const VOID = new Set(["br", "img", "hr"]);

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function parseHtml(html: string): El {
  const root: El = { tag: "root", attrs: {}, children: [] };
  const stack: El[] = [root];
  const re = /<\/?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[3] !== undefined) {
      top.children.push(decode(m[3]));
      continue;
    }
    const tag = m[1].toLowerCase();
    if (m[0].startsWith("</")) {
      const i = stack.map((e) => e.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[a[1].toLowerCase()] = decode(a[2]);
    const el: El = { tag, attrs, children: [] };
    top.children.push(el);
    if (!VOID.has(tag) && !m[2].trim().endsWith("/")) stack.push(el);
  }
  return root;
}

// --- markdown ----------------------------------------------------------------------------------

type Ctx = { notes: Map<string, string> };

function escapeInline(t: string): string {
  return t.replace(/([\\*_`[\]])/g, "\\$1");
}

function noteId(href: string): string | null {
  const m = /^#(?:footnote|endnote)-(\d+)$/.exec(href);
  return m ? m[1] : null;
}

function inline(nodes: Node[], ctx: Ctx): string {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") {
      out += escapeInline(n.replace(/\s+/g, " "));
      continue;
    }
    const inner = () => inline(n.children, ctx);
    switch (n.tag) {
      case "strong":
      case "b":
        out += wrap(inner(), "**");
        break;
      case "em":
      case "i":
        out += wrap(inner(), "*");
        break;
      case "u":
        out += wrap(inner(), "<u>", "</u>");
        break;
      case "s":
      case "del":
      case "strike":
        out += wrap(inner(), "~~");
        break;
      case "br":
        out += "  \n";
        break;
      case "img":
        out += n.attrs.alt ? tr(`*[Billede: ${escapeInline(n.attrs.alt)}]*`, `*[Image: ${escapeInline(n.attrs.alt)}]*`) : tr("*[Billede]*", "*[Image]*");
        break;
      case "a": {
        const href = n.attrs.href ?? "";
        const id = noteId(href);
        if (id) out += `[^${id}]`;
        else if (/^#/.test(href) || /^#?(footnote|endnote)-ref-/.test(n.attrs.id ?? "")) out += inner();
        else if (/^(https?:|mailto:)/i.test(href)) out += `[${inner()}](${href.replace(/\)/g, "%29").replace(/ /g, "%20")})`;
        else out += inner();
        break;
      }
      case "sup":
      case "sub":
      default:
        out += inner();
    }
  }
  return out;
}

/** Fed og kursiv må ikke starte eller slutte med mellemrum i markdown. */
function wrap(text: string, open: string, close = open): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!m || !m[2]) return text;
  return `${m[1]}${open}${m[2]}${close}${m[3]}`;
}

/** Linjestarter, markdown ellers ville læse som overskrift, citat eller liste. */
function escapeLineStart(t: string): string {
  return t.replace(/^(#{1,6}\s|>|[-+]\s|\d+[.)]\s)/, "\\$1");
}

function block(n: Node, ctx: Ctx, out: string[], indent = ""): void {
  if (typeof n === "string") {
    if (n.trim()) out.push(indent + escapeLineStart(escapeInline(n.trim())));
    return;
  }
  const h = /^h([1-6])$/.exec(n.tag);
  if (h) {
    out.push(`${"#".repeat(Number(h[1]))} ${inline(n.children, ctx).trim()}`);
    return;
  }
  switch (n.tag) {
    case "p": {
      const t = inline(n.children, ctx).trim();
      if (t) out.push(indent + escapeLineStart(t));
      return;
    }
    case "blockquote": {
      const inner: string[] = [];
      for (const c of n.children) block(c, ctx, inner);
      if (inner.length) out.push(inner.join("\n\n").split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
      return;
    }
    case "ul":
    case "ol": {
      // Fodnoterne samles til sidst som [^n]: … (mammoth lægger dem i en <ol> sidst).
      const items = n.children.filter((c): c is El => typeof c !== "string" && c.tag === "li");
      if (items.length && items.every((li) => /^(footnote|endnote)-\d+$/.test(li.attrs.id ?? ""))) {
        for (const li of items) {
          const id = (li.attrs.id ?? "").split("-")[1];
          const text = li.children
            .map((c) => (typeof c === "string" ? escapeInline(c) : inline(c.tag === "p" ? c.children : [c], ctx)))
            .join(" ")
            .replace(/\s*↑\s*$/, "")
            .replace(/\s+/g, " ")
            .trim();
          ctx.notes.set(id, text);
        }
        return;
      }
      out.push(list(n, ctx, indent));
      return;
    }
    case "table":
      out.push(table(n, ctx));
      return;
    case "hr":
      out.push("* * *");
      return;
    default:
      for (const c of n.children) block(c, ctx, out, indent);
  }
}

function list(n: El, ctx: Ctx, indent: string): string {
  const lines: string[] = [];
  let i = 1;
  for (const li of n.children) {
    if (typeof li === "string" || li.tag !== "li") continue;
    const marker = n.tag === "ol" ? `${i++}. ` : "- ";
    const own = li.children.filter((c) => typeof c === "string" || (c.tag !== "ul" && c.tag !== "ol"));
    const nested = li.children.filter((c): c is El => typeof c !== "string" && (c.tag === "ul" || c.tag === "ol"));
    const text = own.map((c) => (typeof c === "string" ? escapeInline(c) : c.tag === "p" ? inline(c.children, ctx) : inline([c], ctx))).join(" ").replace(/\s+/g, " ").trim();
    lines.push(`${indent}${marker}${text}`);
    for (const sub of nested) lines.push(list(sub, ctx, indent + " ".repeat(marker.length)));
  }
  return lines.join("\n");
}

function table(n: El, ctx: Ctx): string {
  const rows: string[][] = [];
  const walk = (e: El) => {
    for (const c of e.children) {
      if (typeof c === "string") continue;
      if (c.tag === "tr") {
        rows.push(
          c.children
            .filter((x): x is El => typeof x !== "string" && (x.tag === "td" || x.tag === "th"))
            .map((cell) => {
              const parts: string[] = [];
              for (const k of cell.children) block(k, ctx, parts);
              return parts.join(" ").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
            }),
        );
      } else walk(c);
    }
  };
  walk(n);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

export function htmlToMarkdown(html: string): string {
  const ctx: Ctx = { notes: new Map() };
  const out: string[] = [];
  for (const n of parseHtml(html).children) block(n, ctx, out);
  let md = out.filter((b) => b.trim()).join("\n\n");
  if (ctx.notes.size) md += "\n\n" + [...ctx.notes].map(([id, t]) => `[^${id}]: ${t}`).join("\n");
  return md.trim() + "\n";
}

/** Word-typografier, mammoth ikke kender, men som danske skabeloner bruger. */
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Titel'] => h1:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Citat'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Block Text'] => blockquote > p:fresh",
  "p[style-name='Manchet'] => h4:fresh",
  "u => u",
];

export type Imported = { markdown: string; warnings: string[] };

export async function docxToMarkdown(bytes: ArrayBuffer): Promise<Imported> {
  // WebView2 bruger mammoths browserudgave (`arrayBuffer`), testene Node-udgaven (`buffer`).
  const input = { arrayBuffer: bytes, buffer: bytes } as { arrayBuffer: ArrayBuffer };
  const result = await mammoth.convertToHtml(
    input,
    {
      styleMap: STYLE_MAP,
      // Billeder lægges ikke ind som data i teksten; de bliver en plads med deres alt-tekst.
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
    },
  );
  return {
    markdown: htmlToMarkdown(result.value),
    warnings: result.messages.filter((m) => m.type === "warning").map((m) => m.message),
  };
}
