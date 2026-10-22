// Hurtigåbning (Ctrl+O): skriv et par bogstaver af filnavnet, Enter åbner. Alle tekstfiler i
// bibliotekerne hentes fra Rust én gang pr. åbning (skjulte mapper og worktrees er sorteret fra).

import { invoke } from "@tauri-apps/api/core";

import { fuzzyScore } from "./format.ts";
import { rememberFocus } from "./focus.ts";
import { tr } from "../i18n.ts";

type Hit = { name: string; path: string; folder: string; modifiedMs: number; dimmed: boolean };

const MAX_SHOWN = 40;

export function openQuick(open: (path: string) => void): void {
  const overlay = document.getElementById("overlay") as HTMLElement;
  const restore = rememberFocus();
  const box = document.createElement("div");
  box.className = "quick";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", tr("Åbn en tekst", "Open a text"));
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = tr("Åbn en tekst", "Open a text");
  input.setAttribute("aria-label", tr("Søg efter filnavn", "Search by file name"));
  const list = document.createElement("ul");
  list.setAttribute("role", "listbox");
  box.append(input, list);
  overlay.replaceChildren(box);
  overlay.hidden = false;
  input.focus();

  let files: Hit[] = [];
  let shown: Hit[] = [];
  let selected = 0;

  const close = () => {
    restore();
    overlay.hidden = true;
    overlay.replaceChildren();
  };
  const choose = (h: Hit | undefined) => {
    if (!h) return;
    close();
    open(h.path);
  };

  const render = () => {
    const q = input.value.trim();
    shown = q
      ? files
          .map((f) => ({ f, s: Math.max(fuzzyScore(q, f.name) * 2, fuzzyScore(q, `${f.folder}/${f.name}`)) - (f.dimmed ? 5 : 0) }))
          .filter((x) => x.s >= 0)
          .sort((a, b) => b.s - a.s || b.f.modifiedMs - a.f.modifiedMs)
          .slice(0, MAX_SHOWN)
          .map((x) => x.f)
      : [...files].filter((f) => !f.dimmed).sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, MAX_SHOWN);
    selected = Math.min(selected, Math.max(0, shown.length - 1));
    const items = shown.map((h, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === selected));
      const name = document.createElement("span");
      name.textContent = h.name;
      const folder = document.createElement("span");
      folder.className = "q-folder";
      folder.textContent = h.folder;
      li.append(name, folder);
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(h);
      });
      return li;
    });
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "q-none";
      li.textContent = files.length ? tr("Ingen filer passer.", "No files match.") : tr("Henter filerne …", "Loading files …");
      items.push(li);
    }
    list.replaceChildren(...items);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", () => {
    selected = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, shown.length - 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[selected]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  }, { once: true });

  render();
  void invoke<Hit[]>("list_all_files").then((hits) => {
    files = hits;
    render();
  });
}
