// Samler licenserne for alt, der følger med Gode Tekster, i src-tauri/resources/LICENSES.txt
// (delbar udgave 3/10). Installeren lægger filen ved programmet, og »Om Gode Tekster« viser den.
//
// Kun det, der faktisk distribueres: Rust-crates i den normale afhængighedskæde for Windows (ikke
// build- eller dev-afhængigheder), npm-pakker uden dev, og skrifter, ordklasser og ikoner i
// src/assets. Teksterne er pakkernes egne licensfiler; identiske tekster står én gang med alle
// pakkerne over. Mangler en pakke sin fil, stoppes der: så skal det løses i hånden, ikke gættes.
//
//   node scripts/licenser.mjs           skriv filen
//   node scripts/licenser.mjs --check   fejl, hvis filen ikke er ajour (til udgivelsesscriptet)

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri", "resources", "LICENSES.txt");
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;

// Pakker uden licensfil i selve pakken. Teksten er hentet ved kilden 3/10 (repoets LICENSE eller
// pakkens README) og ligger i scripts/licens-tillaeg/. selectors deler MPL-teksten med cssparser.
const EXTRA = {
  "webview2-com": "webview2-com.txt",
  "webview2-com-sys": "webview2-com.txt",
  "webview2-com-macros": "webview2-com.txt",
  "defmt-parser": "defmt-parser.txt",
  "alloc-stdlib": "alloc-stdlib.txt",
  "hash.js": "hash.js.txt",
  isarray: "isarray.txt",
};
const SAME_AS = { selectors: "cssparser" };

/** Pakkens licensfiler (kun i rodmappen, som pakkerne selv lægger dem). */
function licenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim());
}

/** Ved dobbeltlicens vælger vi den mest tilladende, og kun dens fil kommer med. */
function pickFiles(texts, license) {
  if (texts.length < 2 || !/\bOR\b|\//.test(license ?? "")) return texts;
  const mit = texts.filter((t) => /Permission is hereby granted, free of charge/.test(t));
  if (mit.length) return mit;
  const cc0 = texts.filter((t) => /CC0|Creative Commons Legal Code/.test(t));
  return cc0.length ? cc0 : texts;
}

function rustCrates() {
  const meta = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc"], {
      cwd: join(root, "src-tauri"),
      maxBuffer: 256 * 1024 * 1024,
    }).toString(),
  );
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg);
  }
  return [...seen]
    .map((id) => byId.get(id))
    .filter((p) => p.source != null)
    .map((p) => ({ name: p.name, version: p.version, license: p.license, dir: dirname(p.manifest_path), url: p.repository }));
}

function npmPackages() {
  const lines = execSync("npm ls --omit=dev --all --parseable", { cwd: root }).toString().split(/\r?\n/);
  return lines
    .filter((l) => l.includes("node_modules"))
    .map((dir) => {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return { name: pkg.name, version: pkg.version, license: typeof pkg.license === "string" ? pkg.license : pkg.license?.type, dir, url: pkg.repository?.url ?? pkg.repository };
    });
}

/** Grupper pakker efter identisk licenstekst. */
function grouped(pkgs, kind, missing) {
  const groups = new Map();
  for (const p of pkgs) {
    let texts = pickFiles(licenseFiles(p.dir), p.license);
    if (texts.length === 0 && EXTRA[p.name]) {
      texts = [readFileSync(join(root, "scripts", "licens-tillaeg", EXTRA[p.name]), "utf8").replace(/\r\n/g, "\n").trim()];
    }
    if (texts.length === 0 && SAME_AS[p.name]) {
      const twin = pkgs.find((x) => x.name === SAME_AS[p.name]);
      if (twin) texts = licenseFiles(twin.dir);
    }
    if (texts.length === 0) {
      missing.push(`${kind}: ${p.name} ${p.version} (${p.license})`);
      continue;
    }
    let text = texts.join("\n\n-----\n\n");
    // jszip: »MIT eller GPLv3«, og vi bruger MIT. GPL-teksten bagefter kommer ikke med.
    if (p.name === "jszip") text = text.split(/\nGPL version 3/)[0].trim();
    // Kortest mulige form (4/10: »meget lang«): ophavsretslinjerne er det eneste, der er
    // pakkens egen; resten er licensens standardtekst. Teksten står én gang pr. licens, og hver pakke
    // står under den med sine egne ophavsretslinjer. Tekster, der kun adskiller sig i mellemrum,
    // linjeskift og ophavsret, er den samme licens.
    const lines = text.split("\n");
    const isCopyright = (l) => COPYRIGHT.test(l) && !/[[{]yyyy[\]}]|\[name of copyright owner\]/i.test(l);
    const copyright = [...new Set(lines.filter(isCopyright).map((l) => l.trim()))];
    const body = lines.filter((l) => !isCopyright(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    // Apache 2.0 og MPL 2.0 er den samme licens, selv når pakkernes kopier har små opsætningsforskelle.
    // Kun når pakken har én fil, og den er licensen alene: crossbeam, chrono, dpi og tao har tillæg
    // (fx Go-projektets BSD-licens), som ellers forsvandt ind i den fælles tekst (set 4/10).
    // MIT på samme måde. Grænsen er licensens egen længde med lidt luft: en længere fil har noget med.
    const FAMILIES = [
      ["mit", /Permission is hereby granted, free of charge/, 1400],
      ["apache-2.0", /Apache License\s+Version 2\.0, January 2004/, 12500],
      ["mpl-2.0", /Mozilla Public License Version 2\.0/, 17500],
    ];
    const single = texts.length === 1 && !/\n-----\n/.test(body);
    const family = single ? (FAMILIES.find(([, re, max]) => re.test(body) && body.length < max)?.[0] ?? null) : null;
    const key = family ?? createHash("sha256").update(body.replace(/\s+/g, " ")).digest("hex");
    if (!groups.has(key)) groups.set(key, { text: body, pkgs: [] });
    groups.get(key).pkgs.push({ ...p, copyright });
  }
  return [...groups.values()].sort((a, b) => b.pkgs.length - a.pkgs.length);
}

// Kun egentlige ophavsretslinjer: »Copyright« med stort efterfulgt af (c), ©, et årstal eller et navn,
// eller »(c)«/»©« med et årstal. Ikke licensernes egne sætninger (»copyright notice that is …«).
const COPYRIGHT = /^\s*(Copyright\s+(\(c\)|\(C\)|©|\d{4}|[A-Z])|\(c\)\s*\d{4}|©\s*\d{4})/;

function section(title, groups) {
  const rule = "=".repeat(78);
  let s = `\n${rule}\n${title}\n${rule}\n`;
  for (const g of groups) {
    const names = g.pkgs
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `${p.name} ${p.version}${p.copyright.length ? `: ${p.copyright.join(" · ")}` : ""}`)
      .join("\n");
    s += `\n${"-".repeat(78)}\n${names}\n${"-".repeat(78)}\n\n${g.text}\n`;
  }
  return s;
}

const assets = join(root, "src", "assets");
const missing = [];
const rust = rustCrates();
const npm = npmPackages();
const mpl = rust.filter((p) => /MPL/.test(p.license ?? ""));

let text = `Gode Tekster: licenser for tredjepartskomponenter

Gode Tekster er lavet af Gode Medier (godemedier.dk) og er fri software under GNU General Public
License version 3 (GPL-3.0). Kildekoden ligger på https://github.com/godemedier/gode-tekster.

Programmet bygger på frie komponenter, som andre
har lavet og givet fri. De fleste er under MIT- eller Apache-licensen, og skrifterne IBM Plex og
Newsreader under SIL Open Font License. De må bruges og deles gratis. Licenserne står nedenfor.
Tak til dem, der har lavet dem.

Ved dobbeltlicens (fx »MIT OR Apache-2.0«) bruger Gode Tekster MIT-licensen.

Hver licenstekst står én gang. Over den står de pakker, der bruger den, med deres egne
ophavsretslinjer.

MPL-2.0: ${mpl.map((p) => `${p.name} ${p.version}`).join(", ")} er brugt uændret. Kildekoden findes på
https://crates.io under hvert navn.
`;

text += `\n${"=".repeat(78)}\nSkrifter, ordklasser og ikoner\n${"=".repeat(78)}\n`;
text += `\n${"-".repeat(78)}\nIBM Plex Mono, IBM Plex Sans, IBM Plex Serif (SIL Open Font License 1.1)\n${"-".repeat(78)}\n\n${readFileSync(join(assets, "fonts", "LICENSE-IBMPlex.txt"), "utf8").replace(/\r\n/g, "\n").trim()}\n`;
text += `\n${"-".repeat(78)}\nNewsreader (SIL Open Font License 1.1)\n${"-".repeat(78)}\n\n${readFileSync(join(assets, "fonts", "LICENSE-Newsreader.txt"), "utf8").replace(/\r\n/g, "\n").trim()}\n`;
text += `\n${"-".repeat(78)}\nOrdklasser (ordklasser.json)\n${"-".repeat(78)}\n\n${readFileSync(join(assets, "LICENSE-ordklasser.md"), "utf8").replace(/\r\n/g, "\n").trim()}\n`;
text += `\n${"-".repeat(78)}\nIkoner fra Lucide (lucide.dev): tandhjul og taleboble (ISC)\n${"-".repeat(78)}\n
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without
fee is hereby granted, provided that the above copyright notice and this permission notice appear
in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
`;
// Én liste for Rust og JavaScript: samme licens står kun én gang (4/10).
text += section(`Komponenter (${rust.length + npm.length})`, grouped([...rust, ...npm], "pakke", missing));

if (missing.length) {
  console.error(`Mangler licensfil (${missing.length}). Løs dem i hånden:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
if (process.argv.includes("--check")) {
  // Git kan give filen Windows-linjeskift ved checkout; det er ikke en forskel i licenserne.
  const now = existsSync(out) ? readFileSync(out, "utf8").replace(/\r\n/g, "\n") : "";
  if (now !== text) {
    console.error("LICENSES.txt er ikke ajour. Kør node scripts/licenser.mjs");
    process.exit(1);
  }
  console.log("LICENSES.txt er ajour.");
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`LICENSES.txt: ${rust.length} crates, ${npm.length} npm-pakker, ${(text.length / 1024).toFixed(0)} KB`);
}
