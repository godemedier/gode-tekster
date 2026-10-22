// Scrollbarer ses kun, mens der rulles (5/10): ellers er de usynlige, så intet forstyrrer
// teksten. Et rulle-område får klassen `is-scrolling` ved hver rulning og mister den lidt efter,
// og styles.css tegner kun tommelen i den tilstand. Pladsen til scrollbaren bliver, så teksten ikke
// hopper, når den kommer og går.

const VISIBLE_MS = 900;
const timers = new WeakMap<Element, number>();

export function installScrollbars(): void {
  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target instanceof Element ? e.target : document.scrollingElement;
      if (!el) return;
      el.classList.add("is-scrolling");
      window.clearTimeout(timers.get(el));
      timers.set(
        el,
        window.setTimeout(() => el.classList.remove("is-scrolling"), VISIBLE_MS),
      );
    },
    { capture: true, passive: true },
  );
}
