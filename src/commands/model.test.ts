import { test } from "node:test";
import assert from "node:assert/strict";
import { setLangForTest } from "../i18n.ts";
import { fileNameFor, parseCommand, serializeCommand, validateCommand } from "./model.ts";
import type { Command, CommandError } from "./types.ts";

const TEMPLATE = `---
name: rettelse
kind: template
description: Rettelsesnote med dato
---
**Rettelse {{dato}}:** I en tidligere udgave stod der, at {{1:det forkerte}}. Det rigtige er, at {{2:det rigtige}}.
`;
const TRANSFORM = `---
name: ryd
kind: transform
description: Ryd op i indsat tekst
---
join-lines
tidy
ellipsis
quotes
`;
const CHECK = `---
name: husstil
kind: check
description: Ordene vi ikke bruger
---
pct. => procent
i forhold til => (skriv hvad du mener)
implementere => indføre
`;
const AI = `---
name: nylæser
kind: ai
description: Hvor falder en ny læser af?
aliases: nylaeser, newreader
scope: document
output: findings
shortcut: F8
lang: da
---
Læs teksten som en, der aldrig har hørt om emnet. Peg på de steder, hvor der bruges et fagord,
en forkortelse eller en forudsætning, som ikke er forklaret.
`;

function ok(text: string): Command {
  const r = parseCommand(text, "user");
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.errors));
  return r.command;
}
function errors(text: string): CommandError[] {
  const r = parseCommand(text, "user");
  assert.ok(!r.ok, "filen burde have fejl");
  return r.errors;
}
const lines = (e: CommandError[]) => e.map((x) => x.line);
const base = (over: Partial<Command> = {}): Command => ({ name: "min", kind: "template", description: "En test", aliases: [], scope: "selection", newfile: false, body: "Hej {{navn}}", source: "user", ...over });

test("de fire eksempler fra researchen læses", () => {
  assert.deepEqual(ok(TEMPLATE), {
    name: "rettelse",
    kind: "template",
    description: "Rettelsesnote med dato",
    aliases: [],
    scope: "selection",
    newfile: false,
    body: "**Rettelse {{dato}}:** I en tidligere udgave stod der, at {{1:det forkerte}}. Det rigtige er, at {{2:det rigtige}}.",
    source: "user",
  });
  assert.equal(ok(TRANSFORM).body, "join-lines\ntidy\nellipsis\nquotes");
  assert.equal(ok(CHECK).kind, "check");
  const ai = ok(AI);
  assert.deepEqual([ai.output, ai.scope, ai.shortcut, ai.lang], ["findings", "document", "F8", "da"]);
  assert.deepEqual(ai.aliases, ["nylaeser", "newreader"]);
});

test("kilde og sti følger med", () => {
  const r = parseCommand(TEMPLATE, "user", "C:\\Kommandoer\\rettelse.md");
  assert.ok(r.ok);
  assert.equal(r.command.path, "C:\\Kommandoer\\rettelse.md");
  assert.equal(r.command.source, "user");
  const b = parseCommand(TEMPLATE, "builtin");
  assert.ok(b.ok);
  assert.equal(b.command.source, "builtin");
  assert.ok(!("path" in b.command));
});

test("en fil skrevet af programmet kommer uændret ud efter en tur gennem begge", () => {
  for (const text of [TEMPLATE, TRANSFORM, CHECK, AI]) assert.equal(serializeCommand(ok(text)), text);
});

test("en kommando kommer uændret tilbage efter gem og læs", () => {
  const commands = [
    base(),
    base({ name: "møde-2", aliases: ["moede", "meeting"], newfile: true, body: "# {{1:Emne}}\n\n- {{markør}}\n\n---\n\nSlut", shortcut: "F5", lang: "en" }),
    base({ kind: "transform", body: 'wrap "TJEK: " ""\nnote', scope: "document" }),
    base({ kind: "check", body: "builtin: gaps" }),
    base({ kind: "ai", body: "Stil spørgsmål.\n\nKun spørgsmål.", output: "questions", description: "Kolon: og --- i beskrivelsen" }),
  ];
  for (const c of commands) {
    assert.deepEqual(validateCommand(c), [], c.name);
    const again = parseCommand(serializeCommand(c), "user");
    assert.ok(again.ok, again.ok ? "" : JSON.stringify(again.errors));
    assert.deepEqual(again.command, c);
  }
});

test("CRLF, BOM og tomme linjer om kroppen tåles", () => {
  const crlf = "\uFEFF" + TEMPLATE.replace(/\n/g, "\r\n");
  assert.deepEqual(ok(crlf), ok(TEMPLATE));
  assert.ok(!ok(crlf).body.includes("\r"));
  const airy = "\n---\nname: luft\n\nkind: template\ndescription:   Luft i hovedet  \n---\n\n\nLinje et\n\nLinje to\n\n\n";
  assert.equal(ok(airy).body, "Linje et\n\nLinje to");
  assert.equal(ok(airy).description, "Luft i hovedet");
  assert.equal(ok("---\nNAME: x\nKind: template\nDescription: d\nShortcut: f6\n---\ntekst").shortcut, "F6");
});

test("en fil med én ødelagt linje melder den rigtige linje", () => {
  assert.deepEqual(lines(errors("---\nname: x\nkind: template\nfarve: rød\ndescription: d\n---\ntekst")), [4]);
  assert.match(errors("---\nname: x\nkind: template\nfarve: rød\ndescription: d\n---\ntekst")[0].message, /»farve«/);
  assert.deepEqual(lines(errors("---\nname: x\nkind: template\nbare noget tekst\ndescription: d\n---\ntekst")), [4]);
  assert.deepEqual(lines(errors("---\nname: x\nkind: template\ndescription: d\nname: y\n---\ntekst")), [5]);
  assert.deepEqual(lines(errors("---\nname: x\nkind: template\ndescription: d\n---\nLinje et\n\nHer er {{ukendt}}")), [8]);
  assert.deepEqual(lines(errors("---\r\nname: x\r\nkind: transform\r\ndescription: d\r\n---\r\n\r\ntidy\r\nregex \"a\"\r\n")), [8]);
  assert.deepEqual(lines(errors("---\nname: x\nkind: check\ndescription: d\n---\na => b\nuden pil\n")), [7]);
});

test("flere fejl meldes samlet og i filens rækkefølge", () => {
  const e = errors("---\nname: Min Kommando\nkind: makro\ndescription: d\nlang: tysk\n---\ntekst");
  assert.deepEqual(lines(e), [2, 3, 5]);
});

test("navnet: små bogstaver med æøå, tal og bindestreg, højst 24 tegn", () => {
  for (const name of ["a", "møde", "år-2026", "3-ting", "æøå", "a".repeat(24)]) assert.deepEqual(validateCommand(base({ name })), [], name);
  for (const name of ["", "Møde", "to ord", "under_streg", "-streg", "a".repeat(25), "é", "a/b", "a.md"]) assert.equal(validateCommand(base({ name })).length, 1, name);
  assert.equal(validateCommand(base({ aliases: ["ok", "Ikke Ok"] })).length, 1);
});

test("beskrivelsen: påkrævet, én linje, højst 80 tegn", () => {
  assert.deepEqual(validateCommand(base({ description: "x".repeat(80) })), []);
  assert.match(validateCommand(base({ description: "x".repeat(81) }))[0].message, /81 tegn/);
  assert.equal(validateCommand(base({ description: "" })).length, 1);
  assert.equal(validateCommand(base({ description: "to\nlinjer" })).length, 1);
});

test("påkrævede nøgler: manglende navn, slags og beskrivelse meldes på hovedets første linje", () => {
  const e = errors("---\n---\ntekst");
  assert.equal(e.length, 3);
  assert.deepEqual(lines(e), [1, 1, 1]);
});

test("output: kun findings og questions, påkrævet for AI og kun for AI", () => {
  const ai = (output: string | null) => `---\nname: x\nkind: ai\ndescription: d\n${output === null ? "" : `output: ${output}\n`}---\nSe efter fejl.`;
  assert.equal(ok(ai("findings")).output, "findings");
  assert.equal(ok(ai("questions")).output, "questions");
  assert.deepEqual(lines(errors(ai("alternatives"))), [5]);
  assert.match(errors(ai("alternatives"))[0].message, /findings eller questions/);
  assert.deepEqual(lines(errors(ai("text"))), [5]);
  assert.equal(errors(ai(null)).length, 1);
  assert.deepEqual(lines(errors("---\nname: x\nkind: template\ndescription: d\noutput: findings\n---\ntekst")), [5]);
});

test("shortcut, lang, scope og newfile har faste værdier", () => {
  const head = (extra: string, kind = "template") => `---\nname: x\nkind: ${kind}\ndescription: d\n${extra}\n---\ntidy`;
  for (const key of ["F5", "F6", "F8", "F9"]) assert.equal(ok(head(`shortcut: ${key}`)).shortcut, key);
  for (const bad of ["shortcut: F1", "shortcut: F7", "shortcut: Ctrl+K", "lang: de", "scope: all", "newfile: ja"]) assert.deepEqual(lines(errors(head(bad))), [5], bad);
  assert.equal(ok(head("newfile: yes")).newfile, true);
  assert.equal(ok(head("newfile: no")).newfile, false);
  assert.equal(ok(head("scope: selection")).scope, "selection");
  assert.deepEqual(lines(errors(head("newfile: yes", "transform"))), [5], "kun skabeloner opretter filer");
});

test("kroppen valideres efter slagsen", () => {
  assert.equal(validateCommand(base({ body: "{{ukendt}}" }))[0].line, 1);
  assert.equal(validateCommand(base({ body: "ok\nok\n{{ukendt}}" }))[0].line, 3);
  assert.equal(validateCommand(base({ kind: "transform", body: "tidy\nfindesikke" }))[0].line, 2);
  assert.equal(validateCommand(base({ kind: "transform", body: Array(9).fill("tidy").join("\n") })).length, 1);
  assert.equal(validateCommand(base({ kind: "check", body: "a => b\nuden pil" }))[0].line, 2);
  assert.deepEqual(validateCommand(base({ kind: "check", body: "builtin: repeats" })), []);
  assert.match(validateCommand(base({ kind: "check", body: "builtin: stavning" }))[0].message, /stavning/);
  assert.deepEqual(validateCommand(base({ kind: "ai", output: "findings", body: "x".repeat(2000) })), []);
  assert.match(validateCommand(base({ kind: "ai", output: "findings", body: "x".repeat(2001) }))[0].message, /2001 tegn/);
  // En AI-instruks er bare tekst: klammer og klodsnavne i den er ikke fejl.
  assert.deepEqual(validateCommand(base({ kind: "ai", output: "questions", body: "Se efter {{felter}} og regex." })), []);
});

test("en tom krop er en fejl for alle fire slags", () => {
  for (const kind of ["template", "transform", "check", "ai"] as const) {
    const c = base({ kind, body: "  \n", ...(kind === "ai" ? { output: "findings" as const } : {}) });
    assert.equal(validateCommand(c).length, 1, kind);
    const e = errors(`---\nname: x\nkind: ${kind}\ndescription: d\n${kind === "ai" ? "output: findings\n" : ""}---\n\n`);
    assert.equal(e.length, 1, kind);
    assert.equal(e[0].line, kind === "ai" ? 6 : 5, "linjen med den afsluttende ---");
  }
});

test("validateCommand: 0 er hovedet, ellers linjen i kroppen", () => {
  const e = validateCommand(base({ name: "Forkert", body: "ok\n{{nej}}" }));
  assert.deepEqual(lines(e), [0, 2]);
});

test("validateCommand afviser det, typerne ikke kan fange ved kørsel (sprogmodellens forslag)", () => {
  const loose = { ...base(), kind: "macro", scope: "everything", output: "alternatives", shortcut: "F1", lang: "de" } as unknown as Command;
  assert.equal(validateCommand(loose).length, 5);
});

test("filen skal have et hoved", () => {
  assert.deepEqual(lines(errors("Bare en tekst uden hoved")), [1]);
  assert.deepEqual(lines(errors("")), [1]);
  assert.deepEqual(lines(errors("\n\nname: x\n---")), [3]);
  assert.deepEqual(lines(errors("---\nname: x\nkind: template\ndescription: d\ntekst uden afslutning")), [1]);
});

test("en fil over 20 KB afvises, før den læses", () => {
  const big = `---\nname: x\nkind: template\ndescription: d\n---\n${"æ".repeat(10_300)}`;
  const e = errors(big);
  assert.equal(e.length, 1);
  assert.match(e[0].message, /20 KB/);
  assert.equal(validateCommand(base({ body: "a".repeat(21_000) })).length, 1);
  assert.deepEqual(validateCommand(base({ body: "a".repeat(19_000) })), []);
});

test("filnavnet er navnet med æøå i behold", () => {
  assert.equal(fileNameFor(base({ name: "møde" })), "møde.md");
  assert.equal(fileNameFor(base({ name: "år-2026" })), "år-2026.md");
});

test("fejlbeskederne findes på engelsk og har hverken semikolon eller lang tankestreg", () => {
  const bad = ["---\nname: Min Kommando\nkind: makro\nfarve: rød\nlang: tysk\noutput: alternatives\nshortcut: F1\nscope: alt\nnewfile: ja\n---\n", "ingen hoved", "---\nname: x\nkind: transform\ndescription: d\n---\nnope\nwrap\nclip\ntidy", "---\nname: x\nkind: template\ndescription: d\n---\n{{nej}} {{dato", "---\nname: x\nkind: check\ndescription: d\n---\nuden pil\nbuiltin: x"];
  const collect = () => bad.flatMap((b) => errors(b).map((e) => e.message));
  const da = collect();
  setLangForTest("en");
  let en: string[];
  try {
    en = collect();
  } finally {
    setLangForTest("da");
  }
  assert.equal(da.length, en.length);
  assert.ok(da.length >= 15);
  da.forEach((m, i) => assert.notEqual(m, en[i], m));
  for (const m of [...da, ...en]) assert.ok(!/[;—]/.test(m), m);
});
