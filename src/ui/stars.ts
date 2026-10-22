// Stjernemarkerede mapper og filer i biblioteket (5/10): de står altid øverst. Stierne
// ligger i indstillingerne og følger med, når en fil eller mappe omdøbes eller flyttes.

const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();

export function isStarred(starred: string[], path: string): boolean {
  const p = norm(path);
  return starred.some((s) => norm(s) === p);
}

export function toggleStar(starred: string[], path: string): string[] {
  return isStarred(starred, path) ? starred.filter((s) => norm(s) !== norm(path)) : [...starred, path];
}

/**
 * Listen efter en omdøbning, flytning (`to` er den nye sti) eller sletning (`to` er null). Gælder
 * også alt inde i en mappe, der flyttes eller slettes.
 */
export function afterMove(starred: string[], from: string, to: string | null): string[] {
  const f = norm(from);
  const out: string[] = [];
  for (const s of starred) {
    const n = norm(s);
    if (n !== f && !n.startsWith(f + "\\")) out.push(s);
    else if (to !== null) out.push(to + s.slice(from.length));
  }
  return out;
}
