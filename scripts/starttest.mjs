// Starttest (4/10): starter en bygget exe på en prøvefil og kræver, at fladen melder »klar efter« i
// loggen. 0.1.3 byggede uden fejl, men fladen manglede en fil og åbnede med et tomt vindue: bygget
// lykkedes ≠ programmet starter. Bruges af udgiv.mjs før upload, og kan køres alene:
//
//   node scripts/starttest.mjs [sti til gode-tekster.exe]     (standard: target\release)

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** true, når fladen startede. Kaster, hvis Gode Tekster allerede kører (enkeltinstans). */
export async function startTest(exe, seconds = 40) {
  const running = execSync('tasklist /FI "IMAGENAME eq gode-tekster.exe"').toString();
  if (/gode-tekster\.exe/i.test(running)) {
    throw new Error("Gode Tekster kører. Luk det (Ctrl+Q), så testen ikke sendes over til det kørende vindue.");
  }
  const log = join(process.env.LOCALAPPDATA, "dk.godemedier.godetekster", "log", "gode-tekster.log");
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n") : []);
  const before = lines().length;
  const sample = join(tmpdir(), "gode-tekster-starttest.md");
  writeFileSync(sample, "# Starttest\n\nEt afsnit.\n");
  const child = spawn(exe, [sample], { env: { ...process.env, GT_TEST: "1" }, stdio: "ignore" });
  let ok = false;
  for (let i = 0; i < seconds * 2 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 500));
    ok = lines().slice(before).some((l) => l.includes("klar efter"));
  }
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {
    // Allerede lukket.
  }
  return ok;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const exe = process.argv[2] ?? join(root, "src-tauri", "target", "release", "gode-tekster.exe");
  const ok = await startTest(exe);
  console.log(ok ? "Starttest: fladen starter." : "Starttest FEJLEDE: fladen meldte aldrig »klar«.");
  process.exit(ok ? 0 : 1);
}
