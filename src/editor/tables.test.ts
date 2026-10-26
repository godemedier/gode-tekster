import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import { escapeCell, formatDelimiter, formatRow, formatTable, inlineParts, modelOf, moveColumn, moveRow, parseTable, placeholderSpaces, repairPastedTable, splitRow, tablePreview } from "./tables.ts";

test("en række deles ved lodrette streger, også uden streg yderst, og \\| er en streg i teksten", () => {
  assert.deepEqual(splitRow("| A | B |", 0), [
    { text: "A", from: 2 },
    { text: "B", from: 6 },
  ]);
  assert.deepEqual(
    splitRow("A | B", 10).map((c) => c.text),
    ["A", "B"],
  );
  assert.deepEqual(
    splitRow("| x \\| y |  | z |", 0).map((c) => c.text),
    ["x | y", "", "z"],
    "tomme celler tæller med",
  );
});

test("tabellen læses med overskrift, justering og rækker", () => {
  const lines = ["| Måling | Vægt | Midt |", "|---|---:|:-:|", "| Læst dybt | 24 % | ja |", "| Videre | 16 % |"];
  let from = 0;
  const t = parseTable(lines.map((text) => ({ text, from: (from += text.length + 1) - text.length - 1 })));
  assert.ok(t);
  assert.deepEqual(
    t.header.map((c) => c.text),
    ["Måling", "Vægt", "Midt"],
  );
  assert.deepEqual(t.align, ["left", "right", "center"]);
  assert.deepEqual(
    t.rows.map((r) => r.map((c) => c.text)),
    [
      ["Læst dybt", "24 %", "ja"],
      ["Videre", "16 %"],
    ],
  );
  assert.equal(t.rows[0][0].from, lines[0].length + 1 + lines[1].length + 1 + 2, "cellen ved, hvor den står");
});

test("fed, kursiv, kode og links i en celle", () => {
  assert.deepEqual(inlineParts("Et **stort** tal, *måske* `kode` og [link](https://a.dk)"), [
    { kind: "text", text: "Et " },
    { kind: "strong", text: "stort", mark: "**" },
    { kind: "text", text: " tal, " },
    { kind: "em", text: "måske", mark: "*" },
    { kind: "text", text: " " },
    { kind: "code", text: "kode" },
    { kind: "text", text: " og " },
    { kind: "link", text: "link", href: "https://a.dk" },
  ]);
  assert.deepEqual(inlineParts("24 % * 2"), [{ kind: "text", text: "24 % * 2" }]);
});

test("tekst, der begynder med [, * eller _, er tekst og ikke et link eller kursiv (19/10)", () => {
  // »[ret] …« blev et link med hele cellen som adresse, og et tegn forsvandt ved hvert gem.
  assert.deepEqual(inlineParts("[ret] Samtykke er den holdbare vej"), [{ kind: "text", text: "[ret] Samtykke er den holdbare vej" }]);
  assert.deepEqual(inlineParts("[ret] Se **art. 21** [kilde](https://a.dk) _og_ mere"), [
    { kind: "text", text: "[ret] Se " },
    { kind: "strong", text: "art. 21", mark: "**" },
    { kind: "text", text: " " },
    { kind: "link", text: "kilde", href: "https://a.dk" },
    { kind: "text", text: " " },
    { kind: "em", text: "og", mark: "_" },
    { kind: "text", text: " mere" },
  ]);
  assert.deepEqual(inlineParts("**fed**_x"), [
    { kind: "strong", text: "fed", mark: "**" },
    { kind: "text", text: "_x" },
  ]);
});

test("<br> er et linjeskift i cellen, også skrevet <br/> og <BR />, og ikke tegnene (15/10)", () => {
  assert.deepEqual(inlineParts("☐ Et<br>☐ **To**<br/>tre<BR />"), [
    { kind: "text", text: "☐ Et" },
    { kind: "br", text: "" },
    { kind: "text", text: "☐ " },
    { kind: "strong", text: "To", mark: "**" },
    { kind: "br", text: "" },
    { kind: "text", text: "tre" },
    { kind: "br", text: "" },
  ]);
});

const doc = "Før.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nEfter.";
const state = (anchor: number) => {
  let s = EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ base: markdownLanguage }), tablePreview] });
  ensureSyntaxTree(s, s.doc.length, 5000);
  // Dispatch an empty update so state fields that depend on the syntax tree can recompute
  return s.update({}).state;
};
const shown = (s: EditorState) => {
  const out: { from: number; to: number }[] = [];
  s.field(tablePreview).deco.between(0, s.doc.length, (from, to) => void out.push({ from, to }));
  return out;
};

test("tabellen vises altid som tabel, også med markøren i kanten eller en markering hen over den", () => {
  const from = doc.indexOf("| A");
  const to = doc.indexOf("2 |") + 3;
  for (const anchor of [0, from, doc.indexOf("1 |"), doc.length]) assert.deepEqual(shown(state(anchor)), [{ from, to }], String(anchor));
  const all = state(0).update({ selection: { anchor: 0, head: doc.length } }).state;
  assert.deepEqual(shown(all), [{ from, to }]);
});

test("en ændring i teksten finder tabellen igen, og visningen ændrer aldrig filen", () => {
  const typed = state(0).update({ changes: { from: 0, insert: "Ny linje.\n" }, selection: { anchor: 0 } }).state;
  assert.equal(shown(typed)[0].from, doc.indexOf("| A") + "Ny linje.\n".length);
  assert.equal(state(0).doc.toString(), doc);
});

test("cellerne skrives tilbage som markdown: streger escapes, justeringen bevares, tomme celler står tomme", () => {
  assert.equal(escapeCell("a | b\nc"), "a \\| b c");
  assert.equal(escapeCell("allerede \\| escapet"), "allerede \\| escapet");
  assert.equal(formatRow(["Måling", "", "**fed**"]), "| Måling |  | **fed** |");
  assert.equal(formatDelimiter(["left", "center", "right"]), "|---|:-:|--:|");
  const lines = ["| A | B |", "|---|--:|", "| 1 |", "| x \\| y | 2 | ekstra |"];
  let at = 0;
  const t = parseTable(lines.map((text) => ({ text, from: (at += text.length + 1) - text.length - 1 })));
  assert.ok(t);
  const m = modelOf(t);
  assert.deepEqual(m.header, ["A", "B", ""], "alle rækker får lige mange celler");
  assert.deepEqual(m.rows, [["1", "", ""], ["x | y", "2", "ekstra"]]);
  assert.equal(formatTable(m), "| A | B |  |\n|---|--:|---|\n| 1 |  |  |\n| x \\| y | 2 | ekstra |");
  // Det, der skrives, læses igen som den samme tabel.
  const again = formatTable(m).split("\n");
  let pos = 0;
  const back = parseTable(again.map((text) => ({ text, from: (pos += text.length + 1) - text.length - 1 })));
  assert.ok(back);
  assert.deepEqual(modelOf(back), m);
});

test("rækker og kolonner flyttes med deres celler og justering (26/10)", () => {
  const m = { header: ["A", "B", "C"], align: ["left", "center", "right"] as ("left" | "center" | "right")[], rows: [["1", "2", "3"], ["4", "5", "6"], ["7"]] };
  assert.deepEqual(moveRow(m, 0, 2).rows, [["4", "5", "6"], ["7"], ["1", "2", "3"]]);
  assert.deepEqual(moveRow(m, 2, 0).rows, [["7"], ["1", "2", "3"], ["4", "5", "6"]]);
  assert.deepEqual(moveRow(m, 1, 1), m, "på samme plads er intet ændret");
  const c = moveColumn(m, 0, 2);
  assert.deepEqual(c.header, ["B", "C", "A"]);
  assert.deepEqual(c.align, ["center", "right", "left"]);
  assert.deepEqual(c.rows, [["2", "3", "1"], ["5", "6", "4"], ["", "", "7"]], "en kort række fyldes ud, så cellerne bliver i deres kolonne");
  assert.equal(formatTable(moveColumn(m, 2, 1)), "| A | C | B |\n|---|--:|:-:|\n| 1 | 3 | 2 |\n| 4 | 6 | 5 |\n| 7 |  |  |");
});

// En rigtig tabel fra 6/10, kopieret fra en terminal: rykket ind og med brudte rækker.
const PASTED = [
  "| Måling | Hvad den tæller | Vægt | Hvorfor | Datagrundlag, typisk artikel |",
  "    | --- | --- | --- | --- | --- |",
  "    | Læst dybt | Besøg, der nåede halvvejs ned | 24 % | Tættest på »blev den læst?«. Men lange",
  "  artikler taber: under 300 ord læses 54 procent dybt | 16 læst dybt af 47 besøg uden mur og",
  "  får ingen score her |",
  "    | Fastholdelse | Besøg, der blev mindst 15 sekunder | 16 % | Viser, om rubrik og indledning holder. | 91 af 140 besøg |",
  "    | Shop-besøg | Besøg, der åbnede en abonnementsside | 8 % | Et salgstal.",
  "  Derfor den relativt lave vægt. | 1 af 140 besøg |",
].join("\n");

test("en tabel fra en terminal bliver en tabel: indrykningen væk og de brudte rækker samlet", () => {
  const fixed = repairPastedTable(PASTED);
  const lines = fixed.split("\n");
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => l.startsWith("| ") && l.endsWith("|")), fixed);
  assert.equal(lines[2], "| Læst dybt | Besøg, der nåede halvvejs ned | 24 % | Tættest på »blev den læst?«. Men lange artikler taber: under 300 ord læses 54 procent dybt | 16 læst dybt af 47 besøg uden mur og får ingen score her |");
  let at = 0;
  const t = parseTable(lines.map((text) => ({ text, from: (at += text.length + 1) - text.length - 1 })));
  assert.ok(t);
  assert.equal(t.header.length, 5);
  assert.deepEqual(
    t.rows.map((r) => r.length),
    [5, 5, 5],
  );
  // Og skrivefladen ser den som en tabel.
  const s = EditorState.create({ doc: `Før.\n\n${fixed}\n\nEfter.`, extensions: [markdown({ base: markdownLanguage }), tablePreview] });
  let found = 0;
  s.field(tablePreview).deco.between(0, s.doc.length, () => void found++);
  assert.equal(found, 1);
});

test("tekst uden en tabel sættes ind, som den er, også med lodrette streger og indrykning", () => {
  for (const text of ["Almindelig tekst.\n    kode her", "| ikke en tabel |\n  fordi der ingen skillelinje er", "a | b\nc | d", ""]) assert.equal(repairPastedTable(text), text);
  // Tekst omkring tabellen røres ikke.
  const mixed = "Indledning\n    | A | B |\n    |---|---|\n    | 1 | 2 |\nSlut\n    kode";
  assert.equal(repairPastedTable(mixed), "Indledning\n| A | B |\n|---|---|\n| 1 | 2 |\nSlut\n    kode");
  // En brudt linje med en lodret streg forrest, der ikke hører til en tabel, bliver, som den var.
  const loose = "  | løs linje uden slut\n  fortsat\n\n| A | B |\n|---|---|";
  assert.equal(repairPastedTable(loose), "  | løs linje uden slut\n  fortsat\n\n| A | B |\n|---|---|");
});

test("understreg inde i et ord er ikke kursiv, og markøren huskes (fejljagt 19/10)", () => {
  assert.deepEqual(inlineParts("fil_navn_ny.txt"), [{ kind: "text", text: "fil_navn_ny.txt" }]);
  assert.deepEqual(inlineParts("a__b__c"), [{ kind: "text", text: "a__b__c" }]);
  assert.deepEqual(inlineParts("__init__"), [{ kind: "strong", text: "init", mark: "__" }]);
  assert.deepEqual(inlineParts("et _ord_ her"), [
    { kind: "text", text: "et " },
    { kind: "em", text: "ord", mark: "_" },
    { kind: "text", text: " her" },
  ]);
  assert.deepEqual(inlineParts("æ_ø_"), [{ kind: "text", text: "æ_ø_" }]);
});

test("NBSP og BOM i en celle bliver stående (fejljagt 19/10)", () => {
  assert.deepEqual(splitRow("| 10 kr. | ﻿x |", 0).map((c) => c.text), ["10 kr.", "﻿x"]);
  assert.equal(escapeCell("10 kr."), "10 kr.");
  assert.equal(escapeCell("﻿x"), "﻿x");
  assert.equal(placeholderSpaces("10 kr."), "10 kr.");
  assert.equal(placeholderSpaces("a   b "), "a   b ");
  assert.equal(placeholderSpaces(" a"), " a");
});
