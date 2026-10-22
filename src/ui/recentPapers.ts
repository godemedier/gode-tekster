// De seneste tekster som små papirark, når vinduet ikke har en tekst (ADR-0030): et nyt vindue
// (Ctrl+N), eller når den åbne fil er flyttet eller slettet. Hvert ark er et frimærke af
// tekstens første side: overskriften og de første afsnit i tekstens egen skrift.

import { tr } from "../i18n.ts";
import { formatTime } from "./format.ts";

export interface RecentDoc {
  path: string;
  name: string;
  folder: string;
  modifiedMs: number;
  head: string;
}

export interface PaperBlock {
  kind: "h" | "p";
  text: string;
}

/** Så meget tekst kommer på et ark. Resten ville alligevel være skåret af. */
const PAPER_CHARS = 420;

/** Markdown-tegn væk fra en linje, så arket viser teksten, ikke koden. */
function plain(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Starten af en tekst som et ark: en titel og de første blokke. Titlen er første linje, hvis den
 * er en overskrift, ellers filnavnet. Skjulte blokke (`<!-- … -->`), front matter, tabeller og
 * kodeblokke kommer ikke med.
 */
export function paperOf(head: string, name: string): { title: string; blocks: PaperBlock[] } {
  let text = head.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?(-->|$)/g, "");
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const lines: string[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*\|/.test(raw) || /^\s*(-{3,}|\*{3,})\s*$/.test(raw)) continue;
    lines.push(raw);
  }

  let title = name;
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first >= 0 && /^\s*#{1,6}\s/.test(lines[first])) {
    title = plain(lines[first]) || name;
    lines.splice(0, first + 1);
  }

  const blocks: PaperBlock[] = [];
  let used = 0;
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const t = para.join(" ");
    para = [];
    if (t) blocks.push({ kind: "p", text: t });
    used += t.length;
  };
  for (const raw of lines) {
    if (used >= PAPER_CHARS) break;
    if (raw.trim() === "") {
      flush();
      continue;
    }
    if (/^\s*#{1,6}\s/.test(raw)) {
      flush();
      const t = plain(raw);
      if (t) blocks.push({ kind: "h", text: t });
      used += t.length;
      continue;
    }
    // Hvert listepunkt er sin egen linje på arket, som i teksten.
    if (/^\s*([-*+]|\d+[.)])\s+/.test(raw)) flush();
    const t = plain(raw);
    if (t) para.push(t);
  }
  flush();
  return { title, blocks };
}

/** Lidt skæve ark, som papirer lagt på et bord. Fast pr. plads, så intet danser ved gentegning. */
const TILT = [-1.1, 0.7, -0.4, 1.0, -0.8, 0.5, -0.2, 0.9];

/** Tegner arkene i `host`. Uden seneste tekster bliver `host` tom og skjult. */
export function renderPapers(host: HTMLElement, docs: RecentDoc[], open: (path: string) => void): void {
  host.replaceChildren();
  host.hidden = docs.length === 0;
  if (!docs.length) return;

  const label = document.createElement("h2");
  label.className = "gt-papers-label";
  label.textContent = tr("Seneste tekster", "Recent texts");
  const grid = document.createElement("div");
  grid.className = "gt-papers";

  docs.forEach((doc, i) => {
    const { title, blocks } = paperOf(doc.head, doc.name);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gt-paper";
    button.style.setProperty("--tilt", `${TILT[i % TILT.length]}deg`);
    button.title = doc.path;

    const sheet = document.createElement("span");
    sheet.className = "gt-paper-sheet";
    sheet.setAttribute("aria-hidden", "true");
    // Teksten toner ud forneden. Det sker i et lag for sig, så arkets kant og skygge står skarpt.
    const page = document.createElement("span");
    page.className = "gt-paper-text";
    const h = document.createElement("span");
    h.className = "gt-paper-title";
    h.textContent = title;
    page.append(h);
    for (const b of blocks) {
      const el = document.createElement("span");
      el.className = b.kind === "h" ? "gt-paper-h" : "gt-paper-p";
      el.textContent = b.text;
      page.append(el);
    }
    sheet.append(page);

    // Titlen står på arket. Under det kun hvornår og hvor, som på et skrivebord.
    const caption = document.createElement("span");
    caption.className = "gt-paper-caption";
    caption.textContent = [formatTime(doc.modifiedMs), doc.folder].filter(Boolean).join(" · ");
    button.setAttribute("aria-label", `${title}, ${caption.textContent}`);

    button.append(sheet, caption);
    button.addEventListener("click", () => open(doc.path));
    grid.append(button);
  });

  host.append(label, grid);
}
