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
