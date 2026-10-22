// Fokus tilbage, hvor det kom fra (personatjek 2/10): når et vindue eller en menu lukker, må
// fokus ikke lande på <body>, for så går det næste, brugeren skriver, ingen steder hen.

let fallback: () => void = () => {};

/** Sættes af main.ts: editoren er stedet, fokus går hen, når det forrige element er væk. */
export function setFocusFallback(fn: () => void): void {
  fallback = fn;
}

/** Husk fokus nu. Den returnerede funktion sætter det tilbage. */
export function rememberFocus(): () => void {
  const prev = document.activeElement;
  return () => {
    if (prev instanceof HTMLElement && prev.isConnected && prev !== document.body && !prev.closest("[inert]")) prev.focus();
    else fallback();
  };
}

/** Bevar den samme kontrol og markering, når et panel tegnes forfra. */
export function preserveFocus(root: HTMLElement): () => void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return () => {};
  const path: number[] = [];
  let child: Element = active;
  while (child !== root && child.parentElement) {
    path.unshift([...child.parentElement.children].indexOf(child));
    child = child.parentElement;
  }
  const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? [active.selectionStart, active.selectionEnd] as const : null;
  return () => {
    let target: Element | undefined = root;
    for (const index of path) target = target?.children[index];
    if (!(target instanceof HTMLElement) || root.hidden) return;
    target.focus({ preventScroll: true });
    if (selection && selection[0] !== null && selection[1] !== null && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
      target.setSelectionRange(selection[0], selection[1]);
    }
  };
}

export function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]')]
    .filter((el) => el.tabIndex >= 0 && !el.matches(":disabled") && !el.closest("[hidden], [inert]") && el.getClientRects().length > 0);
}

/** Tab bliver i det åbne dialogvindue, også når kun én kontrol kan nås. */
export function trapTab(root: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
  const items = focusable(root);
  const edge = event.shiftKey ? items[0] : items.at(-1);
  if (!items.length || document.activeElement === edge || !root.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? items.at(-1) : items[0])?.focus();
  }
}
