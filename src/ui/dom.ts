// Små hjælpere til at bygge fladen. Tekst sættes altid med `textContent`, aldrig som HTML (AGENTS.md,
// sikkerhed). Samlet her 20/10: panelerne havde hver sin kopi (kodegennemgang).

/** Et element med klasse og tekst. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** En knap, der ikke sender en formular. */
export function button(label: string, run: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", run);
  return b;
}
