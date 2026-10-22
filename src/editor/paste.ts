// Indsæt (fejljagt 19/10, F1-B12): HTML fra nettet, Word og Google Docs bliver markdown, usynlige
// tegn ryger, et listetegn foran det indsatte dobbeltes ikke i et tomt punkt, og en adresse over en
// markering bliver et link, også inde i fed.
//
// `htmlToMarkdown`: Google Docs' ydre `<b style="font-weight:normal">` er ikke fed, mellemrum ved
// kanten bliver uden for tegnene, og overskrifternes niveau bevares. Ren tekst samles ikke på
// linjen, som tekst fra PDF ellers ofte gør: det ville ødelægge indsat markdown og digte.

import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

/** Tegn, man ikke kan se, men som søgning og ordtal rammer: nulbredde-mellemrum, BOM og blød bindestreg. */
const INVISIBLE = /[​﻿­]/g;
/** HTML med formatering, der er værd at tage med. Kun `<p>`, `<div>` og `<br>` (VS Code, Notesblok) er ren tekst. */
const FORMATTED = /<(h[1-6]|strong|b|em|i|ul|ol|blockquote|a)\b/i;
const EMPTY_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?$/;
const ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const URL_ONLY = /^https?:\/\/[^\s<>]+$/;

/**
 * Ren tekst ind, tekst ud, og markøren (eller markeringen) i `state`. Ren funktion til testene.
 */
export function pastePlain(text: string, state: EditorState): string {
  let t = text.replace(INVISIBLE, "");
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  const before = state.doc.sliceString(line.from, sel.from);
  // En adresse over en markering på én linje: et link med det markerede som tekst.
  if (!sel.empty && URL_ONLY.test(t.trim()) && line.to >= sel.to) {
    const label = state.doc.sliceString(sel.from, sel.to);
    if (!/[[\]\n]/.test(label)) return `[${label}](${t.trim()})`;
  }
  // Et tomt punkt: listetegnet foran det indsatte er allerede der. Flere linjer uden tegn bliver punkter.
  if (sel.empty && EMPTY_ITEM.test(before) && state.doc.sliceString(sel.from, line.to).trim() === "") {
    const lines = t.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
    // Kun listetegnet: afkrydsningsfeltet går med, medmindre punktet allerede har et.
    lines[0] = lines[0].replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/, "");
    if (/\[[ xX]\][ \t]+$/.test(before)) lines[0] = lines[0].replace(/^\[[ xX]\][ \t]+/, "");
    if (lines.length > 1 && lines.every((l) => l.trim() !== "")) {
      const marker = /^[ \t]*(\d+)([.)])/.exec(before);
      const indent = /^[ \t]*/.exec(before)?.[0] ?? "";
      for (let i = 1; i < lines.length; i++) {
        if (ITEM.test(lines[i])) continue;
        lines[i] = `${marker ? `${indent}${Number(marker[1]) + i}${marker[2]} ` : before}${lines[i].trim()}`;
      }
    }
    t = lines.join("\n");
  }
  return t;
}

/** Ryd et HTML-fragment til markdown. Det, der ikke kendes, bliver ren tekst. Kræver en browser. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Word og Google Docs efterlader tomme omslag og metadata.
  doc.querySelectorAll("style,script,meta,link,o\\:p,xml,head,title").forEach((el) => el.remove());
  return block(doc.body).replace(/\n{3,}/g, "\n\n").replace(INVISIBLE, "").trim();
}

/** Tegn om teksten, med mellemrummene i kanten uden for tegnene (`**fed** og`, ikke `**fed **og`). */
function wrap(inner: string, mark: string, close = mark): string {
  const text = inner.trim();
  if (!text) return inner;
  const lead = /^\s*/.exec(inner)?.[0] ? " " : "";
  const trail = /\s*$/.exec(inner)?.[0] ? " " : "";
  return `${lead}${mark}${text}${close}${trail}`;
}

function styled(el: HTMLElement): { bold: boolean; italic: boolean; notBold: boolean } {
  const s = el.getAttribute("style") ?? "";
  const weight = /font-weight\s*:\s*(\w+)/i.exec(s)?.[1].toLowerCase();
  const bold = weight === "bold" || weight === "bolder" || (weight !== undefined && Number(weight) >= 600);
  const notBold = weight === "normal" || (weight !== undefined && Number(weight) > 0 && Number(weight) < 600);
  return { bold, italic: /font-style\s*:\s*italic/i.test(s), notBold };
}

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "br") return "\n";
  const inner = Array.from(el.childNodes).map(inline).join("");
  const st = styled(el);
  switch (tag) {
    case "strong":
    case "b":
      // Google Docs lægger hele indholdet i <b style="font-weight:normal">.
      return st.notBold ? inner : wrap(inner, "**");
    case "em":
    case "i":
      return wrap(inner, "*");
    case "a": {
      const href = el.getAttribute("href") ?? "";
      return /^https?:\/\//i.test(href) && inner.trim() ? `${/^\s/.test(inner) ? " " : ""}[${inner.trim()}](${href})${/\s$/.test(inner) ? " " : ""}` : inner;
    }
    case "span":
      // Google Docs sætter fed og kursiv som stil på <span>.
      if (st.bold && st.italic) return wrap(inner, "***");
      if (st.bold) return wrap(inner, "**");
      if (st.italic) return wrap(inner, "*");
      return inner;
    default:
      return inner;
  }
}

const INLINE = new Set(["strong", "b", "em", "i", "a", "span", "u", "code", "sup", "sub", "font"]);

function block(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  // Et omslag af inline-tegn om hele blokke (Google Docs' <b>): gå indenfor.
  if (INLINE.has(tag) && el.querySelector("p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,table")) return Array.from(el.childNodes).map(block).join("");
  if (INLINE.has(tag)) return inline(el);
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) return `\n\n${"#".repeat(Number(heading[1]))} ${inline(el).trim()}\n\n`;
  if (tag === "blockquote") {
    const lines = Array.from(el.childNodes).map(block).join("").trim().split("\n").map((l) => `> ${l}`.trimEnd());
    return `\n\n${lines.join("\n")}\n\n`;
  }
  if (tag === "ul" || tag === "ol") {
    const items = Array.from(el.children)
      .filter((c) => c.tagName.toLowerCase() === "li")
      .map((li, i) => `${tag === "ol" ? `${i + 1}.` : "-"} ${Array.from(li.childNodes).map(block).join("").replace(/\s*\n\s*/g, " ").trim()}`);
    return `\n\n${items.join("\n")}\n\n`;
  }
  if (tag === "p" || tag === "div" || tag === "li") return `\n\n${Array.from(el.childNodes).map(block).join("").trim()}\n\n`;
  if (tag === "br") return "\n";
  return Array.from(el.childNodes).map(block).join("");
}

/** Indsæt: billeder og tabeller går andre veje (insertImage.ts, tables.ts). */
export const pasteSupport = [
  EditorView.clipboardInputFilter.of((text, state) => pastePlain(text, state)),
  EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData;
      if (!data || data.files.length) return false;
      const html = data.getData("text/html");
      if (!html || !FORMATTED.test(html) || /<table\b/i.test(html)) return false;
      const md = htmlToMarkdown(html);
      if (!md) return false;
      event.preventDefault();
      view.dispatch(view.state.replaceSelection(md), { userEvent: "input.paste", scrollIntoView: true });
      return true;
    },
  }),
];
