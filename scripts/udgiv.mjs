// Udgiv en ny version af Gode Tekster til tekster.godemedier.dk (delbar udgave 3/10).
//
//   1. Sæt versionen i src-tauri/tauri.conf.json, src-tauri/Cargo.toml og package.json.
//   2. node scripts/udgiv.mjs --noter "Hvad er nyt, kort"     (--uden-byg springer bygget over)
//
// Scriptet bygger installeren, signerer den med nøglen i .updater/ (aldrig i git), lægger den op og
// lægger til sidst manifestet op, så det aldrig peger på en fil, der ikke er der endnu. Bagefter
// tjekkes det, at serveren svarer med den nye version. Programmerne derude henter den inden for
// seks timer og installerer den stille, når de afsluttes (src-tauri/src/updater.rs).

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTest } from "./starttest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://tekster.godemedier.dk";
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const die = (msg) => {
  console.error(`STOP: ${msg}`);
  process.exit(1);
};

const version = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const cargo = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8").match(/^version = "(.+)"/m)?.[1];
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (cargo !== version || pkg !== version) die(`versionerne er ikke ens: tauri.conf ${version}, Cargo ${cargo}, package ${pkg}`);
const notes = arg("--noter") ?? "";

const keyFile = join(root, ".updater", "gode-tekster.key");
const tokenFile = join(root, ".updater", "upload-token");
if (!existsSync(keyFile)) die("signeringsnøglen mangler i .updater/ (gendan den fra backup)");
if (!existsSync(tokenFile)) die("upload-nøglen mangler i .updater/upload-token");
const token = readFileSync(tokenFile, "utf8").trim();

// Findes versionen allerede derude, er der intet at gøre (og intet må overskrives).
const live = await fetch(`${BASE}/opdatering/latest.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (live?.version === version) die(`${version} er allerede udgivet. Hæv versionen først.`);

execSync("node scripts/licenser.mjs --check", { cwd: root, stdio: "inherit" });
if (!process.argv.includes("--uden-byg")) execSync("npm run tauri build", { cwd: root, stdio: "inherit" });

const built = join(root, "src-tauri", "target", "release", "bundle", "nsis", `Gode Tekster_${version}_x64-setup.exe`);
if (!existsSync(built)) die(`installeren findes ikke: ${built}`);

// Starttest (4/10): 0.1.3 byggede uden fejl, men fladen manglede en fil og åbnede med et tomt
// vindue. Bygget lykkedes ≠ programmet starter. Start den byggede exe på en prøvefil og kræv, at
// fladen melder »klar« i loggen, før noget lægges op.
if (!(await startTest(join(root, "src-tauri", "target", "release", "gode-tekster.exe")).catch((e) => die(e.message)))) {
  die("starttesten fejlede: fladen meldte aldrig »klar«. Byg forfra: slet dist, kør cargo clean -p gode-tekster --release.");
}
console.log("Starttest: fladen starter.");
const name = `Gode-Tekster_${version}_x64-setup.exe`;
const file = join(root, "src-tauri", "target", "release", "bundle", "nsis", name);
copyFileSync(built, file);

// Som én citeret streng: med shell:true forsvinder et tomt argument (-p ""), og så bliver
// filstien læst som adgangskode (set 3/10).
execSync(`npx tauri signer sign -f "${keyFile}" -p "" "${file}"`, { cwd: root, stdio: "ignore" });
const signature = readFileSync(`${file}.sig`, "utf8").trim();

// Udgaven uden installation (5/10): selve exe'en, der lige har bestået starttesten. Den har sin
// egen post i manifestet, så den flytbare udgave henter en exe og ikke en installer (updater.rs).
const portableName = `Gode-Tekster_${version}_x64-portable.exe`;
const portableFile = join(root, "src-tauri", "target", "release", "bundle", "nsis", portableName);
copyFileSync(join(root, "src-tauri", "target", "release", "gode-tekster.exe"), portableFile);
execSync(`npx tauri signer sign -f "${keyFile}" -p "" "${portableFile}"`, { cwd: root, stdio: "ignore" });
const portableSignature = readFileSync(`${portableFile}.sig`, "utf8").trim();

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { url: `${BASE}/hent/${name}`, signature },
    "windows-x86_64-portable": { url: `${BASE}/hent/${portableName}`, signature: portableSignature },
  },
};

// Tre forsøg: den første upload af 0.1.1 blev afbrudt midtvejs (ECONNABORTED), den næste gik igennem.
async function put(path, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${BASE}/udgivelse/${path}`, { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body });
      if (!r.ok) die(`upload af ${path} gav ${r.status}: ${await r.text()}`);
      return;
    } catch (e) {
      if (attempt === 3) die(`upload af ${path} fejlede tre gange: ${e.cause?.code ?? e.message}`);
      console.log(`  forbindelsen røg (${e.cause?.code ?? e.message}), prøver igen …`);
    }
  }
}
console.log(`Lægger ${name} op (${(statSync(file).size / 1e6).toFixed(1)} MB) …`);
await put(name, readFileSync(file));
console.log(`Lægger ${portableName} op (${(statSync(portableFile).size / 1e6).toFixed(1)} MB) …`);
await put(portableName, readFileSync(portableFile));
await put("latest.json", JSON.stringify(manifest, null, 2));

const check = await fetch(`${BASE}/opdatering/latest.json`).then((r) => r.json());
const head = await fetch(`${BASE}/hent/${name}`, { method: "HEAD" });
if (check.version !== version) die(`serveren svarer stadig ${check.version}`);
if (Number(head.headers.get("content-length")) !== statSync(file).size) die("filen på serveren har ikke samme størrelse");
const headPortable = await fetch(`${BASE}/hent/${portableName}`, { method: "HEAD" });
if (Number(headPortable.headers.get("content-length")) !== statSync(portableFile).size) die("den flytbare udgave på serveren har ikke samme størrelse");
console.log(`Udgivet: ${version}. Download: ${BASE}/hent`);

// godemedier.dk/apps/gode-tekster viser version og størrelse fra manifestet, når sitet bygges
// (5/10). Byg det igen, så siden følger med. Udgivelsen er færdig uanset udfaldet.
const WEBSITE_APP = "ptsa92vyba41yvg62hst1vb3"; // Coolify: godemedier-forgejo (prod)
try {
  execSync(`node C:/GM/standard/scripts/coolify.mjs deploy ${WEBSITE_APP}`, { stdio: "ignore" });
  console.log("godemedier.dk bygges igen med den nye version.");
} catch {
  console.log(`godemedier.dk blev ikke bygget igen. Kør: node C:/GM/standard/scripts/coolify.mjs deploy ${WEBSITE_APP}`);
}
