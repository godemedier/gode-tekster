// En lille menu ved musen (højreklik, sortering). Lukker ved klik udenfor og Esc, piletaster
// flytter mellem punkterne, og fokus går tilbage, hvor det kom fra.

import { rememberFocus } from "./focus.ts";

export type MenuItem =
  | { label: string; run: () => void; checked?: boolean }
  | { separator: true };

let open: HTMLElement | null = null;
let restore: (() => void) | null = null;

export function closeMenu(): void {
  if (!open) return;
  open.remove();
  open = null;
  restore?.();
  restore = null;
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  restore = rememberFocus();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    if ("separator" in item) {
      const hr = document.createElement("hr");
      hr.setAttribute("role", "separator");
      menu.append(hr);
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
    if (item.checked !== undefined) b.setAttribute("aria-checked", String(item.checked));
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = item.checked ? "✓" : "";
    const label = document.createElement("span");
    label.textContent = item.label;
    b.append(check, label);
    b.addEventListener("click", () => {
      closeMenu();
      item.run();
    });
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  open = menu;
  menu.querySelector("button")?.focus();
}

window.addEventListener("mousedown", (e) => {
  if (open && !open.contains(e.target as Node)) closeMenu();
});
window.addEventListener("keydown", (e) => {
  if (!open) return;
  if (e.key === "Escape") closeMenu();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...open.querySelectorAll<HTMLButtonElement>("button")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  }
});
