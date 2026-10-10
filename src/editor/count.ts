// Tællingen i hjørnet (design runde 2, ADR-0015): ord, anslag, normalsider og læsetid. Tæller
// teksten, som læseren ser den: uden markdown-tegn, uden fraklip og uden dæmpet tekst, fordi den
// er på vej ud. Fodnoterne tæller med (ADR-0017), men ikke deres etiketter. En normalside er 2.400 anslag inklusive mellemrum.

import { withoutParked } from "./parked.ts";
import { resolveDimmed } from "./inline.ts";
import { locale, tr } from "../i18n.ts";

export type Count = { words: number; chars: number; pages: number; minutes: number };

/** Ord pr. minut for en voksen, der læser dansk sagprosa (Brysbaert 2019: ca. 238 for engelsk). */
const WPM = 220;

export function readableText(markdown: string): string {
  return resolveDimmed(withoutParked(markdown), false)
    .replace(/^\[\^[^\]\s]+\]:\s?/gm, "")
    .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "")
    .replace(/\[\^[^\]\s]+\]/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?u>/g, "")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/^\s*(\*\s*\*\s*\*|-\s*-\s*-|_\s*_\s*_)[\s*_-]*$/gm, "")
    .replace(/(\*\*|__|~~|\*|_|`)/g, "")
    .replace(/^\|?[\s:|-]+\|[\s:|-]*$/gm, "")
    .replace(/\|/g, " ");
}

export function count(markdown: string): Count {
  const text = readableText(markdown);
  // Som Word (målt 2/10 på samme tekst: 2.903 ord og 17.110 anslag i begge): et ord er alt mellem to
  // mellemrum, også en løs tankestreg, og anslag er alle tegn undtagen linjeskift, også dobbelte
  // mellemrum. Redaktioner bestiller i Words tal. Før tæller vi linjeskift som mellemrum (+57) og
  // sprang løse tegn over (-6).
  const words = text.split(/\s+/).filter(Boolean).length;
  const chars = [...text.replace(/[\r\n]/g, "")].length;
  return { words, chars, pages: chars / 2400, minutes: words / WPM };
}

const nf = new Intl.NumberFormat(locale());
const nf1 = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export function formatCount(c: Count): { short: string; long: string[] } {
  const min = Math.round(c.minutes);
  const words = tr(`${nf.format(c.words)} ord`, c.words === 1 ? "1 word" : `${nf.format(c.words)} words`);
  return {
    short: words,
    long: [
      words,
      tr(`${nf.format(c.chars)} anslag`, c.chars === 1 ? "1 character" : `${nf.format(c.chars)} characters`),
      tr(`${nf1.format(c.pages)} normalsider`, `${nf1.format(c.pages)} standard pages`),
      min < 1 ? tr("under 1 min. at læse", "under 1 min. to read") : tr(`${min} min. at læse`, `${min} min. to read`),
    ],
  };
}
