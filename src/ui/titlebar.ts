// Titellinjen (ADR-0065): som i iA Writer er Windows' egen titellinje væk, og vinduets top er tom,
// mens der skrives. Linjen toner frem, når musen kommer op til den, med tekstens navn og de tre
// vindueknapper. Den kan trækkes i, og dobbeltklik maksimerer (data-tauri-drag-region).

import { getCurrentWindow } from "@tauri-apps/api/window";
import { tr } from "../i18n.ts";

// Windows' egne glyffer: tynde streger på 10 px.
const glyph = (d: string) =>
  `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">${d}</svg>`;
const MINIMIZE = glyph('<path d="M0 5.5h10"></path>');
const MAXIMIZE = glyph('<rect x="0.5" y="0.5" width="9" height="9"></rect>');
const RESTORE = glyph('<rect x="0.5" y="2.5" width="7" height="7"></rect><path d="M2.5 2.5v-2h7v7h-2"></path>');
const CLOSE = glyph('<path d="M0 0l10 10M10 0L0 10"></path>');

function button(cls: string, icon: string, label: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `tb-btn ${cls}`;
  b.innerHTML = icon;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", run);
  return b;
}

/** Bygger titellinjen øverst i vinduet. Kun på skrivebordet: mobilen har ingen. */
export function installTitlebar(): void {
  const win = getCurrentWindow();
  const bar = document.createElement("header");
  bar.id = "titlebar";
  bar.setAttribute("data-tauri-drag-region", "");
  const title = document.createElement("span");
  title.className = "tb-title";
  title.setAttribute("data-tauri-drag-region", "");
  const maximize = button("tb-max", MAXIMIZE, tr("Maksimer", "Maximise"), () => void win.toggleMaximize());
  bar.append(
    title,
    button("tb-min", MINIMIZE, tr("Minimer", "Minimise"), () => void win.minimize()),
    maximize,
    // Samme vej som Windows' kryds: Rust fanger lukningen, og fladen gemmer først (lib.rs).
    button("tb-close", CLOSE, tr("Luk", "Close"), () => void win.close()),
  );
  document.body.prepend(bar);
  document.body.classList.add("has-titlebar");

  // Rust sætter titlen (document.rs). Linjen ses kun, når musen er der, så den læses dér.
  const refreshTitle = () => void win.title().then((t) => { title.textContent = t; }).catch(() => {});
  const refreshMaximized = () =>
    void win.isMaximized().then((max) => {
      maximize.innerHTML = max ? RESTORE : MAXIMIZE;
      const label = max ? tr("Gendan", "Restore") : tr("Maksimer", "Maximise");
      maximize.title = label;
      maximize.setAttribute("aria-label", label);
    }).catch(() => {});
  bar.addEventListener("pointerenter", () => { refreshTitle(); refreshMaximized(); });
  void win.onResized(refreshMaximized);
  refreshTitle();
  refreshMaximized();
}
