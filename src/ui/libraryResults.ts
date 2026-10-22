// Søg i alle tekster (2/10): i søgelinjen (Ctrl+F) med / foran, ikke i et vindue for sig.
// Fundene står under søgefeltet; pil op og ned vælger, Enter eller et klik åbner teksten ved fundet.
// Søgningen sker i Rust (search.rs), som stopper en forældet søgning, når der skrives videre.

import { invoke } from "@tauri-apps/api/core";

import { tr } from "../i18n.ts";

type Hit = { path: string; name: string; folder: string; snippet: string; at: number; len: number; pos: number };

export class LibraryResults {
  readonly el: HTMLUListElement;
  private hits: Hit[] = [];
  private selected = 0;
  private timer: number | undefined;
  private run = 0;
  private onCount: (n: number | null) => void;

  constructor(onCount: (n: number | null) => void) {
    this.onCount = onCount;
    this.el = document.createElement("ul");
    this.el.className = "gt-find-results";
    this.el.setAttribute("role", "listbox");
    this.el.setAttribute("aria-label", tr("Fund i alle tekster", "Matches in all texts"));
    this.el.hidden = true;
  }

  /** Ny søgetekst (uden /). Søger efter et øjeblik, når der holdes pause. */
  set(query: string): void {
    window.clearTimeout(this.timer);
    this.el.hidden = false;
    if (query.trim().length < 2) {
      this.run++;
      this.hits = [];
      this.onCount(null);
      this.note(tr("Søg i alle tekster: skriv mindst to tegn efter /.", "Search all texts: type at least two characters after /."));
      return;
    }
    this.timer = window.setTimeout(() => void this.search(query), 250);
  }

  clear(): void {
    window.clearTimeout(this.timer);
    this.run++;
    this.hits = [];
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  move(dir: 1 | -1): void {
    if (!this.hits.length) return;
    this.selected = Math.max(0, Math.min(this.hits.length - 1, this.selected + dir));
    this.render();
  }

  /** Åbn teksten ved fundet. main.ts lytter efter gt-open-at. */
  open(i = this.selected): void {
    const h = this.hits[i];
    if (h) window.dispatchEvent(new CustomEvent("gt-open-at", { detail: { path: h.path, pos: h.pos } }));
  }

  private async search(query: string): Promise<void> {
    const id = ++this.run;
    this.note(tr("Søger …", "Searching …"));
    try {
      const found = await invoke<Hit[]>("search_library", { query });
      if (id !== this.run) return;
      this.hits = found;
      this.selected = 0;
      this.onCount(found.length);
      this.render();
    } catch {
      if (id === this.run) this.note(tr("Søgningen fejlede.", "The search failed."));
    }
  }

  private note(text: string): void {
    const li = document.createElement("li");
    li.className = "gt-find-note";
    li.textContent = text;
    this.el.replaceChildren(li);
  }

  private render(): void {
    if (!this.hits.length) return this.note(tr("Ingen tekster indeholder det.", "No texts contain that."));
    this.el.replaceChildren(
      ...this.hits.map((h, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === this.selected));
        const name = document.createElement("span");
        name.className = "gt-find-hit-name";
        name.textContent = h.name;
        const line = document.createElement("span");
        line.className = "gt-find-hit-line";
        const chars = [...h.snippet];
        const mark = document.createElement("strong");
        mark.textContent = chars.slice(h.at, h.at + h.len).join("");
        line.append(chars.slice(0, h.at).join(""), mark, chars.slice(h.at + h.len).join(""));
        li.append(name, line);
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.open(i);
        });
        return li;
      }),
    );
    this.el.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }
}
