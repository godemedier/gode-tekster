// Henter den danske ordbog (da_DK fra Stavekontrolden) til stavekontrollen (ADR-0063). Køres i
// hånden af en udvikler, typisk før en udgivelse. Programmet selv henter aldrig noget.
//
//   node scripts/ordbog.mjs           hent nyeste, vis forskellen og læg filerne på plads
//   node scripts/ordbog.mjs --tjek    vis kun, om der er en nyere, og hvad den ændrer
//   node scripts/ordbog.mjs --tving   læg filerne på plads, også når versionen er den samme
//
// Filerne lægges i src-tauri/resources/ordbog/ sammen med KILDE.txt (version, adresse og sha256).
// Bagefter: `cargo test` i src-tauri (prøveordene i spelling.rs) og `node scripts/licenser.mjs`.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src-tauri", "resources", "ordbog");
const PAGE = "https://stavekontrolden.dk/?dictionaries=1";
const BASE = "https://stavekontrolden.dk/dictionaries/da_DK/";
const LIBREOFFICE = "https://raw.githubusercontent.com/LibreOffice/dictionaries/master/da_DK/";
const FILES = ["da_DK.aff", "da_DK.dic", "README_da_DK.txt"];
const LICENSES = [/GNU GPL version 2\.0/, /GNU LGPL version 2\.1/, /Mozilla MPL version 1\.1/];

const args = process.argv.slice(2);
const onlyCheck = args.includes("--tjek");
const force = args.includes("--tving");

/** Stopper scriptet. process.exit() lige efter fetch kan få Node på Windows til at gå ned
 * (libuv: »UV_HANDLE_CLOSING«), så fejlen kastes og fanges nederst i stedet. */
class Stop extends Error {}
function die(msg) {
  throw new Stop(msg);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const compare = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) die(`${url} svarede ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Filerne i en zip (en .oxt er en zip). Kun »stored« og »deflate«, som alle .oxt bruger. */
function unzip(buf, wanted) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) die("filen er ikke en zip");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) die("zip-kataloget er ødelagt");
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (!wanted.includes(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
    else die(`${name} er pakket med en ukendt metode (${method})`);
  }
  return out;
}

/** Versionen i .aff (»#Stavekontrolden version 2.9.148«). */
const affVersion = (aff) => /^#Stavekontrolden version (\d+\.\d+\.\d+)/m.exec(aff.toString("utf8"))?.[1] ?? null;

/** Grundformerne i .dic uden flag. Første linje er antallet. */
function headwords(dic) {
  const out = new Set();
  const lines = dic.toString("utf8").split(/\r?\n/);
  for (const line of lines.slice(1)) {
    if (!line || line.startsWith("#")) continue;
    // En skråstreg med en bagstreg foran er en del af ordet (»A\/S«). Den første uden er flagene.
    const m = /^((?:\\.|[^/\s])+)/.exec(line);
    if (m) out.add(m[1].replace(/\\\//g, "/"));
  }
  return out;
}

async function main() {
  // 1. Nyeste version på Stavekontroldens side.
  const page = (await get(PAGE)).toString("utf8");
  const versions = [...page.matchAll(/da_DK-(\d+\.\d+\.\d+)\.oxt/g)].map((m) => m[1]);
  if (!versions.length) die(`ingen da_DK-*.oxt på ${PAGE}`);
  const latest = versions.sort(compare).at(-1);

  const currentAff = existsSync(join(target, "da_DK.aff")) ? readFileSync(join(target, "da_DK.aff")) : null;
  const current = currentAff ? affVersion(currentAff) : null;
  console.log(`I programmet: ${current ?? "ingen"}. Nyeste hos Stavekontrolden: ${latest}.`);
  if (current && compare(latest, current) < 0) die("Stavekontroldens nyeste er ældre end den i programmet");
  if (current === latest && !force) {
    console.log("Ordbogen er ajour. Intet at gøre.");
    return;
  }

  // 2. Hent og pak ud.
  const url = `${BASE}da_DK-${latest}.oxt`;
  const oxt = await get(url);
  const files = unzip(oxt, FILES);
  for (const f of FILES) if (!files.has(f)) die(`${f} mangler i ${url}`);
  const aff = files.get("da_DK.aff");
  const dic = files.get("da_DK.dic");
  const readme = files.get("README_da_DK.txt").toString("utf8");

  // 3. Det, der skal passe, før filerne må bruges.
  if (affVersion(aff) !== latest) die(`.aff siger version ${affVersion(aff)}, filnavnet ${latest}`);
  if (!/^SET UTF-8/m.test(aff.toString("utf8"))) die(".aff er ikke længere UTF-8 (SET UTF-8 mangler)");
  for (const re of LICENSES) if (!re.test(readme)) die(`licenslinjen ${re} mangler i README_da_DK.txt. Læs licensen, før ordbogen bruges`);
  const affLicense = aff.toString("utf8");
  if (!/GPL 2\.0\/LGPL 2\.1\/MPL 1\.1 tri-license/.test(affLicense)) die("licensen i .aff er ikke længere GPL 2.0/LGPL 2.1/MPL 1.1");

  // 4. Samme version hos LibreOffice? Så skal filerne være ens (Stavekontrolden har ingen signatur).
  const loAffRes = await fetch(`${LIBREOFFICE}da_DK.aff`);
  if (loAffRes.ok) {
    const loAff = Buffer.from(await loAffRes.arrayBuffer());
    const loVersion = affVersion(loAff);
    if (loVersion === latest) {
      const loDic = await get(`${LIBREOFFICE}da_DK.dic`);
      if (sha256(loAff) !== sha256(aff) || sha256(loDic) !== sha256(dic)) die(`LibreOffice har ${latest} med et andet indhold. Undersøg det, før filerne bruges`);
      console.log(`LibreOffice har samme version med samme indhold.`);
    } else {
      console.log(`LibreOffice har ${loVersion ?? "en ukendt version"}, så der er intet at sammenligne med.`);
    }
  }

  // 5. Forskellen i ord.
  const after = headwords(dic);
  const fmt = (n) => n.toLocaleString("da-DK");
  if (current) {
    const before = headwords(readFileSync(join(target, "da_DK.dic")));
    const added = [...after].filter((w) => !before.has(w));
    const removed = [...before].filter((w) => !after.has(w));
    console.log(`Grundformer: ${fmt(before.size)} → ${fmt(after.size)} (${added.length} nye, ${removed.length} fjernet).`);
    if (added.length) console.log(`  Nye, fx: ${added.slice(0, 12).join(", ")}`);
    if (removed.length) console.log(`  Fjernet, fx: ${removed.slice(0, 12).join(", ")}`);
  } else {
    console.log(`Grundformer: ${fmt(after.size)}.`);
  }

  if (onlyCheck) {
    console.log("--tjek: intet er skrevet.");
    return;
  }

  // 6. Læg filerne på plads med en kildefil.
  mkdirSync(target, { recursive: true });
  for (const f of FILES) writeFileSync(join(target, f), files.get(f));
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(target, "KILDE.txt"),
    `Dansk ordbog til stavekontrollen (ADR-0063). Opdateres med: node scripts/ordbog.mjs

  Version:  ${latest}
  Hentet:   ${date}
  Kilde:    ${url}
  Ophav:    Stavekontrolden (Foreningen for frit tilgængelige sprogværktøjer), bygget på data fra
            Det Danske Sprog- og Litteraturselskab
  Licens:   GPL 2.0, LGPL 2.1 eller MPL 1.1 efter eget valg. Gode Tekster bruger den under LGPL 2.1.

  sha256
    ${sha256(oxt)}  da_DK-${latest}.oxt
    ${sha256(aff)}  da_DK.aff
    ${sha256(dic)}  da_DK.dic
    ${sha256(Buffer.from(readme))}  README_da_DK.txt
  `,
  );
  console.log(`Lagt i src-tauri/resources/ordbog/. Kør nu \`cargo test spelling\` i src-tauri og \`node scripts/licenser.mjs\`.`);
}

try {
  await main();
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.error(`Stop: ${e.message}`);
  process.exitCode = 1;
}
