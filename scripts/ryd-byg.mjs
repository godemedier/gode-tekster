// Rydder op i Rusts byggecache (27/10). Cargo sletter aldrig selv gammelt inkrementelt byg eller
// artefakter fra tidligere versioner af en crate, så src-tauri/target og synk/target vokser, til
// disken er fuld. cargo-sweep fjerner det, der ikke er brugt i en uge, og det, der er bygget med en
// Rust-version, som ikke længere er installeret. Det næste byg bliver kun langsommere for det, der
// faktisk er fjernet.
//
//   node scripts/ryd-byg.mjs              ryd op nu
//   node scripts/ryd-byg.mjs --installer  ryd op hver mandag kl. 12 (Windows' Opgavestyring)
//
// Kræver cargo-sweep: cargo install cargo-sweep --locked

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TASK = "Gode Tekster byggecache";
const DAYS = 7;

// Opgavestyringen kører uden skallens PATH-tilføjelser fra rustup, så cargo findes ved sin fulde sti.
const ownCargo = join(homedir(), ".cargo", "bin", "cargo.exe");
const cargo = existsSync(ownCargo) ? ownCargo : "cargo";

if (process.argv.includes("--installer")) {
  // schtasks og ikke Register-ScheduledTask: den sidste kræver administrator. Node har en fast sti,
  // så opgaven ikke peger på et versionsnummer, der skifter ved næste opdatering.
  const run = `"${process.execPath}" "${fileURLToPath(import.meta.url)}"`;
  execFileSync("schtasks", ["/Create", "/TN", TASK, "/TR", run, "/SC", "WEEKLY", "/D", "MON", "/ST", "12:00", "/F"], { stdio: "inherit" });
  console.log(`Opgaven »${TASK}« kører hver mandag kl. 12.`);
  process.exit(0);
}

/** Mappens størrelse i bytes. */
function size(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += size(p);
    else if (e.isFile()) total += statSync(p).size;
  }
  return total;
}
const gb = (b) => `${(b / 1024 ** 3).toFixed(2)} GB`;

try {
  execFileSync(cargo, ["sweep", "--version"], { stdio: "pipe" });
} catch {
  console.error("cargo-sweep mangler. Installér med: cargo install cargo-sweep --locked");
  process.exit(1);
}

let failed = false;
for (const project of ["src-tauri", "synk"]) {
  const dir = join(root, project);
  const target = join(dir, "target");
  if (!existsSync(target)) continue;
  const before = size(target);
  try {
    execFileSync(cargo, ["sweep", "--time", String(DAYS), dir], { stdio: "pipe" });
    execFileSync(cargo, ["sweep", "--installed", dir], { stdio: "pipe" });
  } catch (e) {
    failed = true;
    console.error(`${project}: ${String(e.stderr ?? e.message).trim()}`);
    continue;
  }
  console.log(`${project}/target: ${gb(before)} → ${gb(size(target))}`);
}
process.exit(failed ? 1 : 0);
