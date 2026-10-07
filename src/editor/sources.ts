// Kilder fra faktatjek og research (ADR-0017): link, der springer direkte til citatet på siden
// (text fragment, som i Prismet), og teksten til en fodnote eller et fraklip.

import { shortDate } from "./dates.ts";
import { tr } from "../i18n.ts";

export type Source = { title: string; url: string; quote: string; publisher: string; date: string; check: string };

/** Link til selve citatet. Lange citater angives med begyndelse og slutning (`start,slut`). */
export function fragmentUrl(url: string, quote: string): string {
  const base = url.split("#")[0];
  const words = quote.replace(/[»«"“”]/g, "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return base;
  const enc = (s: string) => encodeURIComponent(s).replace(/-/g, "%2D").replace(/,/g, "%2C").replace(/&/g, "%26");
  const frag = words.length > 10 ? `${enc(words.slice(0, 5).join(" "))},${enc(words.slice(-5).join(" "))}` : enc(words.join(" "));
  return `${base}#:~:text=${frag}`;
}

function linkText(s: string): string {
  return s.replace(/[[\]]/g, "").trim();
}

/** Fodnoten: udgiver, titel som link til citatet, dato og hvornår den er hentet. */
export function footnoteText(s: Source, today = new Date()): string {
  const url = s.check === "fundet" ? fragmentUrl(s.url, s.quote) : s.url;
  const parts = [s.publisher.trim() ? `${s.publisher.trim()}: ` : "", `[${linkText(s.title) || s.url}](${url})`];
  if (s.date.trim()) parts.push(`, ${s.date.trim()}`);
  parts.push(tr(` (hentet ${shortDate(today)})`, ` (retrieved ${shortDate(today)})`));
  return parts.join("").replace(/\n+/g, " ");
}

/** Fraklippet: citatet (kun hvis det står på siden) og kilden. */
export function clippingText(s: Source, summary = ""): string {
  const lines: string[] = [];
  if (s.check === "fundet") lines.push(`»${s.quote.trim()}«`);
  else if (summary) lines.push(summary.trim());
  lines.push(`– ${linkText(s.title)}${s.publisher ? `, ${s.publisher}` : ""}. ${s.url}`);
  return lines.join("\n");
}
