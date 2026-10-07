// Kvalitets- og sikkerheds-gate. Kaldes af lefthook ved pre-commit. exit 1 blokerer commit.
// Tools der ikke er installeret springes gracefully over. Tunge scanninger scopes til staged.
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const sh = (c) => { try { execSync(c, { stdio: "pipe", encoding: "utf8" }); return { ok: true, out: "" }; } catch (e) { return { ok: false, out: `${e.stdout||""}${e.stderr||""}` }; } };
// Som sh(), men beholder ogsaa output ved GROEN exit. Noedvendigt for gitleaks: dens
// "hvor meget blev der scannet"-linjer gaar til stderr og skal laeses, selv naar den melder rent.
const shOut = (c) => { try { return { ok: true, out: execSync(`${c} 2>&1`, { stdio: "pipe", encoding: "utf8" }) || "" }; } catch (e) { return { ok: false, out: `${e.stdout||""}${e.stderr||""}` }; } };
const have = (c) => { try { execSync(c, { stdio: "pipe" }); return true; } catch { return false; } };
const staged = () => { try { return execSync("git -c core.quotepath=false diff --staged --name-only -z --diff-filter=ACM", { encoding: "utf8" }).split("\0").map(s=>s.trim()).filter(Boolean); } catch { return []; } };
let pkg = {}; try { pkg = JSON.parse(readFileSync("package.json","utf8")); } catch {}
const deps = { ...(pkg.dependencies||{}), ...(pkg.devDependencies||{}) };
const has = (n) => Object.prototype.hasOwnProperty.call(deps, n);
const pm = existsSync("pnpm-lock.yaml") ? "pnpm" : existsSync("yarn.lock") ? "yarn" : existsSync("bun.lockb") ? "bun" : "npm";
const files = staged();
const LOCK = ["package-lock.json","pnpm-lock.yaml","yarn.lock","bun.lockb","requirements.txt","poetry.lock","go.sum","Cargo.lock"];
const lockStaged = files.some(f => LOCK.includes(f.split("/").pop()));
const codeFiles = files.filter(f => /\.(ts|tsx|js|jsx|mjs|cjs|py|go)$/.test(f));
const failures = [], skipped = [];
// 1) HEMMELIGHEDER - hurtigst, koeres foerst. VERIFICÉR subkommando mod 'gitleaks --help'.
// Groen exit-kode er IKKE nok: scanningen skal ogsaa have kunnet LAESE aendringerne.
// Git for Windows kobler *.doc/*.docx/*.pdf/*.rtf til konverteren `astextplain`. Paa en fil
// den ikke kender svarer git `unsupported filetype` og opgiver HELE diff'en - gitleaks faar
// nul bytes og melder groent. Maalt 2026-08-24: token alene = blokeret, token + én .docx =
// SLAP IGENNEM. `.gitattributes` (docx m.fl. som `binary`) lukker den kendte aarsag; dette
// vaern fanger de ukendte filtyper. "Kunne ikke maale" er ikke "rent" (L-176).
if (have("gitleaks version")) {
  const r = shOut("gitleaks git --staged --no-banner --redact");
  if (!r.ok) failures.push("HEMMELIGHEDER (gitleaks):\n" + r.out);
  else if (/unable to read files to diff|unsupported filetype/i.test(r.out)) failures.push("HEMMELIGHEDER: git kunne ikke diffe alle staged filer, saa scanningen daekker ikke alt.\nDet ser ud som 'no leaks found', men der blev maaske scannet nul bytes.\nSandsynlig aarsag: en filtype uden 'binary' i .gitattributes. Tilfoej den.\n\n" + r.out);
} else skipped.push("gitleaks");
// 2) TYPECHECK
if (existsSync("tsconfig.json") && has("typescript")) { const r = sh("npx tsc --noEmit"); if (!r.ok) failures.push("TYPECHECK:\n" + r.out); }
// 3) TESTS
const t = pkg.scripts?.test || ""; if (t && !/no test specified/i.test(t)) { const r = sh(pm === "npm" ? "npm test --silent" : `${pm} test`); if (!r.ok) failures.push("TESTS:\n" + r.out); }
// 3b) RUST (Gode Tekster, 2/10-2026 - husets foerste Rust-projekt; ikke i skabelonen endnu).
// Koeres kun, naar Rust-kode eller Cargo-filer er staged. Mangler cargo, BLOKERER trinnet i
// stedet for at springe over: "kunne ikke maale" er ikke "rent" (L-176). Tests koeres af
// `npm test` i trin 3, saa her er det kun formatering og lint.
const rustStaged = files.some(f => /\.rs$|(^|\/)Cargo\.(toml|lock)$/.test(f));
if (rustStaged && existsSync("src-tauri/Cargo.toml")) {
  if (!have("cargo --version")) failures.push("RUST: cargo findes ikke i denne shell. Rust-koden kan ikke tjekkes.\nInstallér med 'winget install Rustlang.Rustup', og start en ny shell.");
  else {
    const m = "--manifest-path src-tauri/Cargo.toml";
    const f = sh(`cargo fmt ${m} --check`); if (!f.ok) failures.push("RUST-FORMATERING (koer 'cargo fmt " + m + "'):\n" + f.out);
    const c = sh(`cargo clippy ${m} --all-targets --quiet -- -D warnings`); if (!c.ok) failures.push("RUST-LINT (clippy):\n" + c.out);
  }
}
// 4) KODEMOENSTRE (SAST) - kun aendrede kodefiler. VERIFICÉR flags mod 'semgrep --help'. --metrics off af privatshensyn.
if (have("semgrep --version")) { if (codeFiles.length) { const cfg = existsSync(".semgrep.yml") ? ".semgrep.yml" : "auto"; const r = sh(`semgrep scan --config ${cfg} --error --quiet --metrics off --disable-version-check ${codeFiles.map(f=>`"${f}"`).join(" ")}`); if (!r.ok) failures.push("KODEMOENSTRE (semgrep):\n" + r.out); } } else skipped.push("semgrep");
// 5) SAARBARE AFHAENGIGHEDER (SCA) - kun naar et lockfile er staged. VERIFICÉR syntax mod 'osv-scanner --help'.
// Scan de STAGEDE lockfiles eksplicit med -L: mappe-scan ('scan source . --recursive')
// er broken paa Windows i osv-scanner 2.3.x (walker C:\, finder 0 kilder, exit 128).
if (have("osv-scanner --version")) { if (lockStaged) { const locks = files.filter(f => LOCK.includes(f.split("/").pop())); const r = sh("osv-scanner scan source " + locks.map(f=>`-L "${f}"`).join(" ")); if (!r.ok) failures.push("SAARBARE AFHAENGIGHEDER (osv-scanner):\n" + r.out); } } else skipped.push("osv-scanner");
// 6) DOK-LOFT - kontraktfiler der lastes i hver session maa ikke VOKSE over loftet.
// Ligger i standard/, saa loftet er ét sted for hele huset. Findes stien ikke (fx et repo
// uden for C:\GM), springes trinnet over frem for at fejle.
{ const g = "C:/GM/standard/scripts/dok-loft.mjs"; if (existsSync(g)) { const r = sh(`node "${g}"`); if (!r.ok) failures.push("DOK-LOFT:\n" + r.out); } }
if (skipped.length) console.error("[sprunget over - ikke installeret: " + skipped.join(", ") + "]");
if (failures.length) { console.error("\nGate fejlede - commit blokeret. Ret foelgende:\n\n" + failures.join("\n\n")); process.exit(1); }
process.exit(0);
