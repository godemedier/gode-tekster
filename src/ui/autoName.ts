// Nye tekster får navn efter det første, der skrives (5/10). Så længe filen hedder det, den
// fik ved oprettelsen (»Uden titel«, »Untitled«, evt. med tal), omdøbes den, når første linje er
// færdig, altså når der er trykket Enter efter den. Derefter står navnet fast, og man kan selv
// omdøbe som før.

const DEFAULT = /^(Uden titel|Untitled)( \d+)?\.md$/i;
const MAX = 60;

/** Har filen stadig det navn, programmet gav den? */
export function hasDefaultName(path: string): boolean {
  return DEFAULT.test(path.slice(path.lastIndexOf("\\") + 1));
}

/** Filnavnet (uden .md) ud fra første færdige linje, eller null, hvis der ikke er en endnu. */
export function titleFromText(text: string): string | null {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim() !== "");
  // Første linje er først færdig, når der står noget efter den (Enter er trykket).
  if (i < 0 || i === lines.length - 1) return null;
  const raw = lines[i]
    .replace(/<!--.*?-->/g, "")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\{--|--\}|\{\+\+|\+\+\}|\{>>.*?<<\}/g, "")
    .replace(/[*_`~]/g, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let name = raw;
  if (name.length > MAX) {
    const cut = name.slice(0, MAX);
    const space = cut.lastIndexOf(" ");
    name = space > MAX / 2 ? cut.slice(0, space) : cut;
  }
  name = name.replace(/[.\s]+$/, "");
  return name || null;
}
