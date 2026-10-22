// Nummererede overskrifter fortsætter (5/10): står der »## 1. Indledning«, får den næste
// overskrift på samme niveau »2. « af sig selv, både når den laves med Ctrl+1-3 og når »## «
// skrives. Fjerner man nummeret, holder det op. En overskrift på et højere niveau imellem (et nyt
// afsnit) stopper også rækken.

const HEADING = /^(#{1,6})\s+(.*)$/;
const NUMBER = /^(\d+)([.)])\s/;

/** Nummeret til en ny overskrift på `level` i linje `index`, ud fra linjerne over den. */
export function nextHeadingNumber(lines: readonly string[], index: number, level: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const m = HEADING.exec(lines[i]);
    if (!m) continue;
    const l = m[1].length;
    if (l < level) return null;
    if (l > level) continue;
    const n = NUMBER.exec(m[2]);
    return n ? `${Number(n[1]) + 1}${n[2]} ` : null;
  }
  return null;
}

/** Har overskriftens tekst allerede et nummer? */
export const hasNumber = (text: string): boolean => NUMBER.test(text);
