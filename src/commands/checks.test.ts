import { test } from "node:test";
import assert from "node:assert/strict";
import { setLangForTest } from "../i18n.ts";
import { BUILTIN_CHECKS, builtinCheckId, parseWordlist, runCheck } from "./checks.ts";
import type { Command, Finding } from "./types.ts";

const check = (body: string): Command => ({ name: "t", kind: "check", description: "t", aliases: [], scope: "document", newfile: false, body, source: "user" });
const excerpts = (f: Finding[]) => f.map((x) => x.excerpt);

/** Kontrakten for alle fund: positionerne peger på det ordrette uddrag i den tekst, tjekket fik. */
function assertExact(findings: Finding[], text: string): void {
  for (const f of findings) {
    assert.ok(f.from >= 0 && f.to > f.from && f.to <= text.length);
    assert.equal(text.slice(f.from, f.to), f.excerpt);
    assert.ok(f.comment.length > 0);
  }
  assert.deepEqual(
    findings.map((f) => f.from),
    findings.map((f) => f.from).sort((a, b) => a - b),
    "fundene står i tekstens rækkefølge",
  );
}

test("ordlisten læses: én regel pr. linje, tomme linjer springes over", () => {
  const r = parseWordlist("pct. => procent\n\ni forhold til => (skriv hvad du mener)\r\nimplementere=>indføre\n");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rules, [
    { from: "pct.", to: "procent", line: 1 },
    { from: "i forhold til", to: "(skriv hvad du mener)", line: 3 },
    { from: "implementere", to: "indføre", line: 4 },
  ]);
});

test("en linje uden pil er en fejl med linjenummer, og resten læses stadig", () => {
  const r = parseWordlist("a => b\nbare et ord\n => intet foran\nc => d");
  assert.deepEqual(
    r.errors.map((e) => e.line),
    [2, 3],
  );
  assert.equal(r.rules.length, 2);
});

test("ordliste: hele ord uanset store og små bogstaver, og kommentaren er højresiden", () => {
  const text = "Pct. er ikke procent. 5 pct. af dem vil implementere det, men implementeringen venter.";
  const f = runCheck(check("pct. => procent\nimplementere => indføre"), text, "da");
  assertExact(f, text);
  assert.deepEqual(excerpts(f), ["Pct.", "pct.", "implementere"]);
  assert.deepEqual(
    f.map((x) => x.comment),
    ["procent", "procent", "indføre"],
  );
});

test("ordliste: flere ord, æøå og regler uden højreside", () => {
  const text = "I forhold til prisen er påen ikke på. Altså i forhold  til.";
  const f = runCheck(check("i forhold til => skriv hvad du mener\npå =>"), text, "da");
  assertExact(f, text);
  assert.deepEqual(excerpts(f), ["I forhold til", "på"]);
  assert.equal(f[1].comment, "Står på din ordliste.");
});

test("ordliste: tegn fra regulære udtryk er bare tegn", () => {
  const text = "Skriv a.b og axb og (x) og [y]*.";
  assert.deepEqual(excerpts(runCheck(check("a.b => punktum\n(x) => parentes\n[y]* => stjerne"), text, "da")), ["a.b", "(x)", "[y]*"]);
});

test("tjek læser ikke skjulte blokke, noter og dæmpet tekst", () => {
  const text = "pct. her. <!-- pct. i en note --> {--pct. dæmpet <!-- pct. --> stadig pct. dæmpet--} {>> pct. <<}\n\n[^1]: pct. i en fodnote\n\n<!-- gt:parkeret id=p1 dato=2026-10-05\npct. i fraklip\n-->\npct. igen";
  const f = runCheck(check("pct. => procent"), text, "da");
  assertExact(f, text);
  assert.deepEqual(
    f.map((x) => x.from),
    [0, text.lastIndexOf("pct.")],
  );
});

test("et tjek ændrer ikke teksten og er det samme hver gang", () => {
  const text = "TK her og og der. Hansen og Hanssen.";
  const before = text.slice();
  for (const id of BUILTIN_CHECKS) {
    const a = runCheck(check(`builtin: ${id}`), text, "da");
    assert.deepEqual(runCheck(check(`builtin: ${id}`), text, "da"), a);
  }
  assert.equal(text, before);
});

test("builtin: id'et læses, og et ukendt giver ingen fund", () => {
  assert.equal(builtinCheckId("builtin: names"), "names");
  assert.equal(builtinCheckId("  builtin:gaps \n"), "gaps");
  assert.equal(builtinCheckId("a => b"), null);
  assert.equal(builtinCheckId("builtin: a => b"), null, "en regel om ordet builtin er stadig en ordliste");
  assert.deepEqual(runCheck(check("builtin: findesikke"), "TK", "da"), []);
  assert.deepEqual(BUILTIN_CHECKS, ["all", "names", "gaps", "repeats"]);
});

test("names: samme navn stavet forskelligt", () => {
  const text = "Det siger Mette Frederiksen. Senere svarede Frederiksen igen, og Fredriksen gik. Ifølge Frederiksens kontor er det rigtigt.";
  const f = runCheck(check("builtin: names"), text, "da");
  assertExact(f, text);
  assert.deepEqual(excerpts(f), ["Fredriksen"]);
  assert.match(f[0].comment, /»Frederiksen«/);
});

test("names: står to stavemåder lige tit, vises begge, og ejefald er ikke en anden stavemåde", () => {
  const text = "Vi talte med Christensen i går. I dag ringede Christenson tilbage.";
  assert.deepEqual(excerpts(runCheck(check("builtin: names"), text, "da")), ["Christensen", "Christenson"]);
  assert.deepEqual(runCheck(check("builtin: names"), "Vi mødte Jensen. Det er Jensens hus og Jensen's bil.", "da"), []);
  assert.deepEqual(runCheck(check("builtin: names"), "Hun bor i Danmark. Alle i Danmarks Radio ved det.", "da"), []);
});

test("names: ord først i en sætning er ikke navne", () => {
  assert.deepEqual(runCheck(check("builtin: names"), "Husene er røde. Huset er blåt. Huser man nogen?", "da"), []);
  // Men et navn først i en sætning tæller, når det ligner et, der står midt i en anden.
  const text = "Vi talte med Frederiksen og igen med Frederiksen. Fredriksen svarede ikke. Morgenen efter ringede hun.";
  assert.deepEqual(excerpts(runCheck(check("builtin: names"), text, "da")), ["Fredriksen"]);
});

test("names: samme ting med to forskellige tal", () => {
  const text = "Foreningen har 340 medlemmer og 12 ansatte. Sidste år var der 5 år til målet. De 430 medlemmer betaler i 10 år.";
  const f = runCheck(check("builtin: names"), text, "da");
  assertExact(f, text);
  assert.deepEqual(excerpts(f), ["340", "430"]);
  assert.match(f[0].comment, /430 medlemmer/);
  assert.match(f[1].comment, /340 medlemmer/);
});

test("names: samme tal to gange er ikke et fund, og tusindtal læses som ét tal", () => {
  assert.deepEqual(runCheck(check("builtin: names"), "Der kom 1.200 gæster. De 1.200 gæster spiste.", "da"), []);
  const text = "Der kom 1.200 gæster. De 1.250 gæster spiste.";
  assert.deepEqual(excerpts(runCheck(check("builtin: names"), text, "da")), ["1.200", "1.250"]);
});

test("gaps: TK, XXX, spørgsmålstegn, klammer og tomme links", () => {
  const text = "Borgmesteren TK sagde XXX kroner?? Se [?] og [...] og […] og [kilden]() og [](https://x.dk) samt [???].";
  const f = runCheck(check("builtin: gaps"), text, "da");
  assertExact(f, text);
  assert.deepEqual(excerpts(f), ["TK", "XXX", "??", "[?]", "[...]", "[…]", "[kilden]()", "[](https://x.dk)", "[???]"]);
});

test("gaps: almindelig tekst giver ingen fund", () => {
  const text = "ATK og TKO er forkortelser. Hvad? Et [link](https://x.dk) og et ![](medier/billede.png) og en liste [1].";
  assert.deepEqual(runCheck(check("builtin: gaps"), text, "da"), []);
});

test("gaps: noter med TJEK eller CHECK findes, andre noter og dæmpet tekst gør ikke", () => {
  const text = "Tal. <!-- TJEK: er det rigtigt? --> Mere {>> CHECK the figure <<} og <!-- bare en note med TK --> {--TK dæmpet--}";
  const f = runCheck(check("builtin: gaps"), text, "da");
  assertExact(f, text);
  assert.deepEqual(excerpts(f), ["<!-- TJEK: er det rigtigt? -->", "{>> CHECK the figure <<}"]);
});

test("repeats: samme ord to gange i træk", () => {
  const text = "Det er er en fejl, og og det er Det det også.\nEn linje\nlinje to. Tal 2 2 tæller ikke, og »at, at« er sat med vilje.";
  const f = runCheck(check("builtin: repeats"), text, "da");
  assertExact(f, text);
  assert.deepEqual(excerpts(f), ["er er", "og og", "Det det", "linje\nlinje"]);
});

test("repeats: samme sætningsstart tre gange i træk", () => {
  const text = "Vi kom. Vi så. Vi vandt. Vi gik. De blev. De sov.";
  const f = runCheck(check("builtin: repeats"), text, "da");
  assertExact(f, text);
  assert.deepEqual(
    f.map((x) => x.from),
    [text.indexOf("Vi vandt"), text.indexOf("Vi gik")],
  );
  assert.match(f[0].comment, /^3 sætninger/);
  assert.match(f[1].comment, /^4 sætninger/);
});

test("repeats: lister og overskrifter må gerne begynde ens", () => {
  const text = "- Alle navne er tjekket\n- Alle tal er tjekket\n- Alle links virker\n\n# Alle\n\nAlle kom. Alle gik.";
  assert.deepEqual(runCheck(check("builtin: repeats"), text, "da"), []);
});

test("kommentarerne følger programmets sprog", () => {
  setLangForTest("en");
  try {
    assert.equal(runCheck(check("builtin: gaps"), "TK", "en")[0].comment, "Marked as unfinished.");
    assert.match(runCheck(check("builtin: repeats"), "the the", "en")[0].comment, /“the” appears twice/);
    assert.match(parseWordlist("ingen pil").errors[0].message, /arrow/);
  } finally {
    setLangForTest("da");
  }
});

test("meget lange tekster: højst 200 fund", () => {
  assert.equal(runCheck(check("builtin: gaps"), "TK ".repeat(500), "da").length, 200);
});
