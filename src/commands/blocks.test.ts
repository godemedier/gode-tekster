import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChain, BLOCKS, formatStep, parseChain, protectedSpans } from "./blocks.ts";
import type { Lang } from "../i18n.ts";

/** Kør en kæde skrevet som i filen. Fejler testen, hvis kæden ikke kan læses. */
function run(chain: string, text: string, lang: Lang = "da"): string {
  const { steps, errors } = parseChain(chain);
  assert.deepEqual(errors, [], chain);
  return applyChain(steps, text, lang).text;
}

const PARKED = "<!-- gt:parkeret id=p1 dato=2026-10-05\nEt  klip med \"tegn\" ... og b a\n-->";

test("kæden læses: tekster i anførselstegn, valg som bare ord, tomme linjer springes over", () => {
  const { steps, errors } = parseChain('wrap "**" "**"\n\nreplace "pct." "procent" word case\nquotes da\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(steps, [
    { block: "wrap", args: ["**", "**"], line: 1 },
    { block: "replace", args: ["pct.", "procent", "word", "case"], line: 3 },
    { block: "quotes", args: ["da"], line: 4 },
  ]);
});

test("anførselstegn, omvendt skråstreg og linjeskift kan stå i en tekst", () => {
  const { steps } = parseChain('wrap "\\"" "\\\\ \\n"');
  assert.deepEqual(steps[0].args, ['"', "\\ \n"]);
  assert.equal(formatStep("wrap", ['"', "\\ \n"]), 'wrap "\\"" "\\\\ \\n"');
  assert.equal(formatStep("replace", ["a b", "", "word"]), 'replace "a b" "" word');
  assert.equal(formatStep("list", ["tasks"]), "list tasks");
});

test("en ukendt klods er en fejl med linjenummer, og de andre trin læses stadig", () => {
  const { steps, errors } = parseChain("tidy\nregex \"a\" \"b\"\nellipsis");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 2);
  assert.match(errors[0].message, /regex/);
  assert.deepEqual(
    steps.map((s) => s.block),
    ["tidy", "ellipsis"],
  );
});

test("forkerte argumenter er fejl", () => {
  const bad = ['wrap "kun én"', "wrap a b", 'replace "" "x"', "case", "case big", "case upper lower", "list", "heading 5", "heading", "strip", "strip alt", "tidy nu", "quotes da en", "sort asc", 'prefix-lines "a" "b"', 'wrap "a" "b', '"wrap"', "sort desc desc"];
  for (const line of bad) {
    const r = parseChain(line);
    assert.equal(r.errors.length, 1, line);
    assert.equal(r.errors[0].line, 1);
    assert.equal(r.steps.length, 0, line);
  }
  const good = ['wrap "" ""', "quotes", "quotes en around", "quotes around", "sort", "sort desc", "strip format links", "strip links", "heading 0", "list none", 'replace "a" ""'];
  for (const line of good) assert.deepEqual(parseChain(line).errors, [], line);
});

test("højst 8 trin", () => {
  assert.deepEqual(parseChain(Array(8).fill("tidy").join("\n")).errors, []);
  const r = parseChain(Array(10).fill("tidy").join("\n"));
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 9);
  assert.equal(r.steps.length, 8);
});

test("clip og footnote må kun stå sidst og kommer ud som then", () => {
  const r = parseChain("clip\ntidy");
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 1);
  assert.equal(parseChain("footnote\nclip").errors.length, 1);
  const ok = parseChain("tidy\nclip");
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(applyChain(ok.steps, "a  b", "da"), { text: "a b", then: "clip" });
  assert.deepEqual(applyChain(parseChain("footnote").steps, "Kilde: DST", "da"), { text: "Kilde: DST", then: "footnote" });
  assert.equal(applyChain(parseChain("tidy").steps, "a", "da").then, null);
});

test("BLOCKS har hver klods én gang med etiketter på begge sprog, og hver kan læses", () => {
  const names = BLOCKS.map((b) => b.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([...names].sort(), ["case", "clip", "dim", "ellipsis", "footnote", "heading", "join-lines", "list", "note", "number", "prefix-lines", "quotes", "replace", "reverse", "sort", "split-sentences", "strip", "suffix-lines", "table", "tidy", "unique", "wrap"].sort());
  for (const b of BLOCKS) {
    assert.ok(b.da && b.en, b.name);
    // Det mindste gyldige trin efter klodsens egne regler.
    const line = formatStep(b.name, [...Array(b.texts).fill("x"), ...b.options.slice(0, b.min)]);
    assert.deepEqual(parseChain(line).errors, [], line);
  }
});

test("wrap, prefix-lines og suffix-lines", () => {
  assert.equal(run('wrap "**" "**"', "fed"), "**fed**");
  assert.equal(run('prefix-lines "> "', "a\n\nb"), "> a\n\n> b");
  assert.equal(run('suffix-lines "  "', "a\nb"), "a  \nb  ");
});

test("replace: fast tekst, hele ord og store og små bogstaver", () => {
  assert.equal(run('replace "pct." "procent"', "5 pct. og 7 Pct. af dem"), "5 procent og 7 procent af dem");
  assert.equal(run('replace "del" "part"', "del delvis andel del."), "part partvis anpart part.");
  assert.equal(run('replace "del" "part" word', "del delvis andel del."), "part delvis andel part.");
  assert.equal(run('replace "å" "aa" word', "å på åen å"), "aa på åen aa", "æøå er bogstaver");
  assert.equal(run('replace "Hansen" "Jensen" case', "hansen og Hansen"), "hansen og Jensen");
  assert.equal(run('replace "a.*b" "x"', "a.*b og aab"), "x og aab", "ingen regulære udtryk");
  assert.equal(run('replace "$1" "$&"', "pris $1"), "pris $&", "erstatningen er også fast tekst");
  assert.equal(run('replace "aa" "a"', "aaaa"), "aa");
});

test("quotes: »« på dansk, “ ” på engelsk, og sproget kan låses", () => {
  assert.equal(run("quotes", 'Han sagde "nej" og "måske".'), "Han sagde »nej« og »måske«.");
  assert.equal(run("quotes", 'He said "no" and "maybe".', "en"), "He said “no” and “maybe”.");
  assert.equal(run("quotes da", 'Han sagde "nej".', "en"), "Han sagde »nej«.");
  assert.equal(run("quotes en", "Han sagde »nej«.", "da"), "Han sagde “nej”.");
  assert.equal(run("quotes", "“Nej,” sagde hun. ”Jo,” sagde han."), "»Nej,« sagde hun. »Jo,« sagde han.");
  assert.equal(run("quotes", '"Hele sætningen."'), "»Hele sætningen.«");
  assert.equal(run("quotes", "Det er Peters' bog, ikk'?"), "Det er Peters' bog, ikk'?", "apostroffer røres ikke");
});

test("quotes around: sætter tegn om det hele, og tegn indeni bliver enkelte", () => {
  assert.equal(run("quotes around", "Det er for dyrt"), "»Det er for dyrt«");
  assert.equal(run("quotes around", "It costs too much", "en"), "“It costs too much”");
  assert.equal(run("quotes around", 'Han sagde "nej" til mig'), "»Han sagde ›nej‹ til mig«");
  assert.equal(run("quotes around", 'He said "no" to me', "en"), "“He said ‘no’ to me”");
  assert.equal(run("quotes around", '"Allerede i tegn"'), "»Allerede i tegn«", "ikke to lag");
  assert.equal(run("quotes around", ""), "»«", "uden markering: et tomt par");
  assert.equal(run("quotes around", "  ord \n"), "  »ord« \n", "blanktegn yderst bliver udenfor");
});

test("quotes går uden om linkadresser, kode og HTML", () => {
  const text = 'Se [siden](https://x.dk "titel") og `kode "her"` og <a href="x">"link"</a>.';
  assert.equal(run("quotes", text), 'Se [siden](https://x.dk "titel") og `kode "her"` og <a href="x">»link«</a>.');
});

test("tidy: dobbelte mellemrum, mellemrum før tegn og sidst på linjen", () => {
  assert.equal(run("tidy", "Et  ord ,  to   ord .  \nNy linje  !"), "Et ord, to ord.\nNy linje!");
  assert.equal(run("tidy", "- punkt\n    - under  punkt"), "- punkt\n    - under punkt", "indrykning er markdown");
  assert.equal(run("tidy", "vent ... lidt"), "vent ... lidt");
  assert.equal(run("tidy", "smil :) nu"), "smil :) nu");
});

test("ellipsis: præcis tre punktummer", () => {
  assert.equal(run("ellipsis", "Tja... måske.... nej."), "Tja… måske.... nej.");
});

test("join-lines: linjeskift i et afsnit bliver til mellemrum, afsnit og lister bliver", () => {
  assert.equal(run("join-lines", "Første linje fra en\nPDF, der er brudt \nmidt i sætningen.\n\nNyt afsnit\nfortsætter."), "Første linje fra en PDF, der er brudt midt i sætningen.\n\nNyt afsnit fortsætter.");
  assert.equal(run("join-lines", "# Rubrik\nTekst\nmere\n- a\n- b\n1. c\n> d\nslut"), "# Rubrik\nTekst mere\n- a\n- b\n1. c\n> d\nslut");
});

test("split-sentences: én sætning pr. linje, forkortelser og datoer holder sammen", () => {
  assert.equal(run("split-sentences", "Det er nyt. Det er vigtigt! Er det sandt? Ja."), "Det er nyt.\nDet er vigtigt!\nEr det sandt?\nJa.");
  assert.equal(run("split-sentences", "Mødet er den 5. oktober kl. 14. Bl.a. A. P. Møller kommer."), "Mødet er den 5. oktober kl. 14.\nBl.a. A. P. Møller kommer.");
  assert.equal(run("split-sentences", "1. Første punkt. Andet led.\n2. Næste."), "1. Første punkt.\nAndet led.\n2. Næste.", "et listenummer er ikke en sætning");
  assert.equal(run("split-sentences", "»Nej.« Hun gik. Se https://x.dk/a.B Det virker."), "»Nej.«\nHun gik.\nSe https://x.dk/a.B Det virker.");
  assert.equal(run("split-sentences", "Ca. Halvdelen kom. Resten blev væk."), "Ca. Halvdelen kom.\nResten blev væk.");
});

test("sort: efter sprogets alfabet, tal som tal, og baglæns", () => {
  assert.equal(run("sort", "Åse\nAnna\nØrum\nÆbler\nZebra", "da"), "Anna\nZebra\nÆbler\nØrum\nÅse");
  assert.equal(run("sort", "Aarhus\nAalborg\nBirk", "da").split("\n").at(-1), "Aarhus", "aa sorteres som å på dansk");
  assert.equal(run("sort", "Aarhus\nBirk\nAalborg", "en"), "Aalborg\nAarhus\nBirk");
  assert.equal(run("sort", "10 æbler\n9 pærer\n100 nødder"), "9 pærer\n10 æbler\n100 nødder");
  assert.equal(run("sort desc", "a\nc\n\nb"), "c\nb\na");
});

test("unique, reverse og number", () => {
  assert.equal(run("unique", "a\nb\na \n\nb\nc"), "a\nb\n\nc");
  assert.equal(run("reverse", "1\n2\n3"), "3\n2\n1");
  assert.equal(run("number", "a\n- b\n\n3. c"), "1. a\n2. b\n\n3. c");
});

test("case: store, små og sætningsform", () => {
  assert.equal(run("case upper", "blåbær og æbler"), "BLÅBÆR OG ÆBLER");
  assert.equal(run("case lower", "BLÅBÆR Og Æbler"), "blåbær og æbler");
  assert.equal(run("case sentence", "HVERT ORD MED STORT. OG ET TIL! »ER DET RIGTIGT?« JA."), "Hvert ord med stort. Og et til! »Er det rigtigt?« Ja.");
  assert.equal(run("case sentence", "Hvert Ord Med Stort\n- ET PUNKT\n## EN RUBRIK"), "Hvert ord med stort\n- Et punkt\n## En rubrik");
  assert.equal(run("case sentence", "MØDET ER DEN 5. OKTOBER, BL.A. MED CA. TI."), "Mødet er den 5. oktober, bl.a. med ca. ti.");
  assert.equal(run("case sentence", "DET SKETE I 2026. SIDEN GIK DET GALT."), "Det skete i 2026. Siden gik det galt.");
  assert.equal(run("case upper", "se [siden](https://x.dk/Sti) og `kode`"), "SE [SIDEN](https://x.dk/Sti) OG `kode`");
});

test("list: punkter, tal, tjekliste og ingen", () => {
  assert.equal(run("list bullets", "a\nb\n\nc"), "- a\n- b\n\n- c");
  assert.equal(run("list numbered", "- a\n* b"), "1. a\n2. b");
  assert.equal(run("list tasks", "1. a\n- [x] b"), "- [ ] a\n- [ ] b");
  assert.equal(run("list none", "- a\n2. b\n- [ ] c\n  - d"), "a\nb\nc\n  d");
  assert.equal(run("list bullets", "- a\n- b"), "- a\n- b", "ikke to lag");
});

test("table og heading", () => {
  assert.equal(run("table", "Navn;Alder\nAnna;42"), "| Navn | Alder |\n|---|---|\n| Anna | 42 |");
  assert.equal(run("heading 2", "Rubrik"), "## Rubrik");
  assert.equal(run("heading 3", "# Rubrik"), "### Rubrik");
  assert.equal(run("heading 0", "#### Rubrik"), "Rubrik");
});

test("strip format fjerner fremhævning, men ikke links", () => {
  const text = "**Fed**, *kursiv*, _også_, __fed__, ~~ud~~, `kode`, <u>streg</u> og [et link](https://x.dk/a_b_c).";
  assert.equal(run("strip format", text), "Fed, kursiv, også, fed, ud, kode, streg og [et link](https://x.dk/a_b_c).");
  assert.equal(run("strip format", "snake_case_navn og 2 * 3 * 4"), "snake_case_navn og 2 * 3 * 4");
  assert.equal(run("strip format", "* punkt med *kursiv*"), "* punkt med kursiv");
  assert.equal(run("strip format", "***begge***"), "begge");
});

test("strip links fjerner links, men ikke fremhævning og ikke billeder", () => {
  assert.equal(run("strip links", "Se **[siden](https://x.dk)** og ![billede](medier/a.png) og <https://y.dk>."), "Se **siden** og ![billede](medier/a.png) og https://y.dk.");
  assert.equal(run("strip format links", "Se **[siden](https://x.dk)**."), "Se siden.");
});

test("dim og note er tekst", () => {
  assert.equal(run("dim", "Et afsnit."), "{--Et afsnit.--}");
  assert.equal(run("note", "tjek tallet"), "<!-- tjek tallet -->");
  assert.equal(run("dim", " ord \n"), " {--ord--} \n");
  assert.equal(run("note", "a --> b"), "<!-- a -- > b -->", "en pil må ikke lukke noten");
  assert.equal(run("dim", ""), "");
});

test("dim lægger aldrig mærker inden i mærker, og note lader gamle noter være", () => {
  assert.equal(run("dim", "Først {--allerede--} sidst"), "{--Først--} {--allerede--} {--sidst--}");
  assert.equal(run("dim", "{--alt er dæmpet--}"), "{--alt er dæmpet--}");
  assert.equal(run("note", "Først <!-- gammel --> sidst {>> ældre <<}"), "<!-- Først --> <!-- gammel --> <!-- sidst --> {>> ældre <<}");
});

test("/husk: TJEK foran og gjort til note", () => {
  assert.equal(run('wrap "TJEK: " ""\nnote', "er tallet rigtigt"), "<!-- TJEK: er tallet rigtigt -->");
});

test("/ryd: linjeskift fra PDF, mellemrum, punktummer og citationstegn i ét", () => {
  const messy = 'Han sagde  "det er\nfor dyrt" ...  og gik .';
  assert.equal(run("join-lines\ntidy\nellipsis\nquotes", messy), "Han sagde »det er for dyrt« … og gik.");
  assert.equal(run("join-lines\ntidy\nellipsis\nquotes", messy, "en"), "Han sagde “det er for dyrt” … og gik.");
});

test("skjulte blokke kommer ordret ud på samme plads, uanset kæden", () => {
  const text = `B  linje ...\nA "linje"\n\n[^1]: Kilde  med  "tegn" ...\n\n${PARKED}\n`;
  for (const b of BLOCKS) {
    const line = formatStep(b.name, [...Array(b.texts).fill("x"), ...b.options.slice(0, b.min)]);
    const out = run(line, text);
    assert.ok(out.includes(PARKED), `${b.name} ændrede fraklippet`);
    assert.ok(out.includes('\n\n[^1]: Kilde  med  "tegn" ...\n\n'), `${b.name} ændrede fodnoten`);
    assert.ok(out.indexOf("[^1]:") < out.indexOf("<!-- gt:"), b.name);
    assert.ok(out.endsWith(`${PARKED}\n`), `${b.name} flyttede fraklippet`);
  }
  assert.equal(run("sort\ncase upper\ntidy\nellipsis\nquotes", text), `A »LINJE«\nB LINJE …\n\n[^1]: Kilde  med  "tegn" ...\n\n${PARKED}\n`);
});

test("en tekst, der kun er skjulte blokke, røres ikke", () => {
  assert.equal(run('wrap "(" ")"\ndim\nnote', `${PARKED}\n`), `${PARKED}\n`);
  assert.equal(run("quotes around", `\n${PARKED}`), `\n${PARKED}`);
});

test("noter, dæmpede mærker, fodnotehenvisninger og rettelser overlever alle klodser ordret", () => {
  const frozen = ['<!-- en  note med "tegn" ... -->', '{>> gammel  note "x" <<}', "[^kilde_1]", "{++nyt  her++}", "{~~gammelt  ~>nyt~~}"];
  const text = `Først ${frozen[0]} og  "midt" ${frozen[1]} ...\nNæste[^kilde_1] linje {--dæmpet  "tekst"--} med ${frozen[3]} og ${frozen[4]} slut`;
  for (const b of BLOCKS) {
    const line = formatStep(b.name, [...Array(b.texts).fill("x"), ...b.options.slice(0, b.min)]);
    const out = run(line, text);
    for (const f of frozen) assert.ok(out.includes(f), `${b.name} ændrede ${f}`);
    assert.equal(out.split("{--").length, out.split("--}").length, `${b.name} efterlod et halvt dæmpet mærke`);
  }
  // Mærkerne bliver, men det dæmpede er stadig tekst, der kan omformes.
  assert.equal(run("case upper", "før {--dæmpet--} efter <!-- note -->"), "FØR {--DÆMPET--} EFTER <!-- note -->");
  assert.equal(run('replace "--" "–"', "a -- b {--c--} <!-- d -->"), "a – b {--c--} <!-- d -->");
  assert.equal(run("strip format", "*a* {--*b*--} <!-- *c* -->"), "a {--b--} <!-- *c* -->");
});

test("protectedSpans: slags, rækkefølge og hele par", () => {
  const text = "a <!-- n --> {--b--} [^1] <!-- gt:parkeret id=p1\nx\n-->";
  assert.deepEqual(
    protectedSpans(text).map((s) => [s.kind, text.slice(s.from, s.to)]),
    [
      ["note", "<!-- n -->"],
      ["dim-open", "{--"],
      ["dim-close", "--}"],
      ["inline", "[^1]"],
      ["hidden", "<!-- gt:parkeret id=p1\nx\n-->"],
    ],
  );
  // Et dæmpet mærke, der begynder inde i en note, er ikke et par.
  assert.deepEqual(
    protectedSpans("<!-- {-- --> x --}").map((s) => s.kind),
    ["note"],
  );
});

test("CRLF i kæden", () => {
  const r = parseChain("tidy\r\nellipsis\r\n");
  assert.deepEqual(r.errors, []);
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[1].line, 2);
});

test("en tom kæde gør ingenting", () => {
  assert.deepEqual(parseChain(""), { steps: [], errors: [] });
  assert.deepEqual(applyChain([], "tekst", "da"), { text: "tekst", then: null });
});
