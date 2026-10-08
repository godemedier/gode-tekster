// Linjebredden i tegn (ADR-0037). CSS' `ch` er bredden af et nul, og det passer kun i mono: i en
// proportional skrift er nullet bredere end et gennemsnitligt bogstav, så 72ch blev til 85-106 tegn.
// Her måles den gennemsnitlige tegnbredde på dansk prosa i den valgte skrift, og bredden sættes i em.
//
// Målingen gælder kun, når skriften faktisk er hentet: før det måler canvas reserveskriften (8/10:
// Literata gav 59 tegn i stedet for 72). Derfor gemmes kun målinger af hentede skrifter, og bredden
// regnes om, når en skrift bliver færdig.

const SAMPLE =
  "Øjeblikket før en tekst bliver til, er det sværeste. Man sidder med en halv idé, en kop kaffe og en flade, der venter. »Skriv bare,« sagde hun. Klokken 9.45 stod der 1.284 anslag og ét godt afsnit om budgettet.";
/** Editorens spatiering (setup.ts), lagt oven i hvert tegn. */
const LETTER_SPACING_EM = 0.01;

const cache = new Map<string, number>();
let canvas: HTMLCanvasElement | null = null;
let last: { chars: number; stack: string } | null = null;

function measure(stack: string): number {
  canvas ??= document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0.6;
  ctx.font = `400 100px ${stack}`;
  const em = ctx.measureText(SAMPLE).width / 100 / [...SAMPLE].length + LETTER_SPACING_EM;
  return Number.isFinite(em) && em > 0.2 && em < 1 ? em : 0.6;
}

/** Gennemsnitlig tegnbredde i em for en CSS-skriftstak. */
export async function charWidthEm(stack: string): Promise<number> {
  const known = cache.get(stack);
  if (known) return known;
  await document.fonts.load(`400 100px ${stack}`, SAMPLE).catch(() => []);
  const em = measure(stack);
  if (document.fonts.check(`400 100px ${stack}`, SAMPLE)) cache.set(stack, em);
  return em;
}

/** Sætter --linjelaengde, så en linje rummer `chars` tegn i skriften `stack`. */
export async function setLineLength(chars: number, stack: string): Promise<void> {
  last = { chars, stack };
  const em = await charWidthEm(stack);
  if (last.chars !== chars || last.stack !== stack) return;
  document.documentElement.style.setProperty("--linjelaengde", `${(chars * em).toFixed(2)}em`);
}

// En skrift, der bliver færdig efter målingen, giver en ny måling.
document.fonts.addEventListener("loadingdone", () => {
  if (last && !cache.has(last.stack)) void setLineLength(last.chars, last.stack);
});
