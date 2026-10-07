// Henter Gode Ords sprogregler ind i Gode Tekster (stiltjek, research 2/10). Ordlisterne bor ét
// sted, i Gode Ord (AGENTS.md i roden: »dupliker dem ikke«). Her kopieres filerne uændret, med
// commit-stempel øverst (L-007), og importerne får .ts-endelser. src/sprog/sprog.test.ts fejler,
// hvis kopien er gledet fra Gode Ord: ret i Gode Ord, og kør så dette script igen.
//
//   node scripts/sprog.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SOURCE = "C:/GM/projekter/gode-medier-suite/gode-ord";
const FILES = ["clarity.ts", "quotes.ts", "aitells.ts"];
const target = new URL("../src/sprog/", import.meta.url);

/** Det, kopien skal indeholde: Gode Ords fil med .ts på de relative importer. */
export function transform(source) {
  return source.replace(/from "\.\/(\w+)"/g, 'from "./$1.ts"');
}

const commit = execFileSync("git", ["-C", SOURCE, "log", "-1", "--format=%h %cs", "--", ...FILES.map((f) => `src/lib/${f}`)], { encoding: "utf8" }).trim();
mkdirSync(target, { recursive: true });
for (const f of FILES) {
  const body = transform(readFileSync(`${SOURCE}/src/lib/${f}`, "utf8"));
  const header = `// KOPI af gode-ord/src/lib/${f} @ ${commit}. Ret i Gode Ord, ikke her, og kør scripts/sprog.mjs.\n`;
  writeFileSync(new URL(f, target), header + body);
}
console.log(`src/sprog/ opdateret fra Gode Ord ${commit}`);
