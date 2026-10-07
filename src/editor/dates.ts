// Datoer på dansk og på lokal tid. Ét sted, så ingen kopi bruger UTC ved en fejl (L-619): et
// fraklip, der laves kl. 01 dansk sommertid, skal have dagens dato, ikke gårsdagens.

import { isEnglish, locale, tr } from "../i18n.ts";

const LONG = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"];
const SHORT = ["jan.", "feb.", "marts", "april", "maj", "juni", "juli", "aug.", "sept.", "okt.", "nov.", "dec."];

/** »2026-10-02« på lokal tid (til fraklippenes `dato=`). */
export function todayIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** »2. oktober 2026« (forside, byline). */
export function danishDate(d: Date): string {
  return `${d.getDate()}. ${LONG[d.getMonth()]} ${d.getFullYear()}`;
}

/** »2. okt. 2026« (fodnoter). */
export function danishDateShort(d: Date): string {
  return `${d.getDate()}. ${SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/** »2. oktober 2026« eller »2 October 2026«, efter programmets sprog. */
export function longDate(d: Date): string {
  return isEnglish() ? d.toLocaleDateString(locale(), { day: "numeric", month: "long", year: "numeric" }) : danishDate(d);
}

/** »2. okt. 2026« eller »2 Oct 2026«, efter programmets sprog. */
export function shortDate(d: Date): string {
  return isEnglish() ? d.toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" }) : danishDateShort(d);
}

/** »14.05« (versioner), på engelsk »14:05«. */
export function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}${tr(".", ":")}${String(d.getMinutes()).padStart(2, "0")}`;
}
