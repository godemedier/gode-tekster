import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import { fold, insideNote, isQuery, matchTier, menuField, opensMenu, rankCommands, scoreCommand, setMenu } from "./slashMenu.ts";
import type { Command, Kind } from "./types.ts";

const cmd = (name: string, kind: Kind = "template", source: "builtin" | "user" = "builtin", aliases: string[] = []): Command => ({
  name,
  kind,
  description: "",
  aliases,
  scope: "selection",
  newfile: false,
  body: "",
  source,
});

test("»/« åbner i linjestart, efter blanktegn, startparentes og åbnende citationstegn", () => {
  for (const before of ["", "Tekst ", "\t", "- ", "> ", "# ", "(", "se (", "»", "han sagde “", 'og "']) {
    assert.equal(opensMenu(before), true, JSON.stringify(before));
  }
});

test("»/« åbner ikke midt i et ord, efter tal, kolon eller en anden skråstreg", () => {
  for (const before of ["og", "5", "https:", "https:/", "km", "a.", "ord,", "]", "100 %", "x)"]) {
    assert.equal(opensMenu(before), false, JSON.stringify(before));
  }
});

test("»/« åbner ikke foran et mellemrum eller et ord, men gerne foran en slutparentes", () => {
  assert.equal(opensMenu("10 ", " 2"), false);
  assert.equal(opensMenu("", "Hej"), false);
  assert.equal(opensMenu("og ", "/eller"), false);
  assert.equal(opensMenu("(", ")"), true);
  assert.equal(opensMenu("Tekst ", ""), true);
});

test("»/« åbner ikke i adresser, kode på linjen og fodnotedefinitioner", () => {
  assert.equal(opensMenu("[tekst]("), false);
  assert.equal(opensMenu("![billede](medier/ "), false);
  assert.equal(opensMenu("kør `npm "), false);
  assert.equal(opensMenu("kør `npm test` og "), true);
  assert.equal(opensMenu("[^1]: Se "), false);
});

test("en åben note eller skjult blok spærrer, en lukket gør ikke", () => {
  assert.equal(insideNote("Tekst <!-- husk "), true);
  assert.equal(insideNote("<!-- gt:parkeret id=p1 dato=2026-10-05\nEt klip "), true);
  assert.equal(insideNote("Tekst <!-- husk --> og "), false);
  assert.equal(insideNote("Tekst {>> spørg "), true);
  assert.equal(insideNote("Tekst {>> spørg <<} "), false);
});

test("det skrevne er et muligt navn, til der kommer et mellemrum eller et tegn", () => {
  assert.equal(isQuery(""), true);
  assert.equal(isQuery("møde-2"), true);
  assert.equal(isQuery("da to"), false);
  assert.equal(isQuery("kapitel.md"), false);
  assert.equal(isQuery("a".repeat(25)), false);
});

test("æ, ø og å kan skrives som ae, oe og aa", () => {
  assert.equal(fold("Læsetid"), "laesetid");
  assert.equal(matchTier("moede", "møde"), 5);
  assert.equal(matchTier("mø", "moede"), 4);
  assert.equal(matchTier("aar", "årsplan"), 4);
  assert.equal(matchTier("nylae", "nylæser"), 4);
});

test("et præfikstræf slår et træf midt i ordet, som slår et uskarpt", () => {
  assert.equal(matchTier("dato", "dato"), 5);
  assert.equal(matchTier("da", "dato"), 4);
  assert.equal(matchTier("kort", "dato-kort"), 3);
  assert.equal(matchTier("at", "dato"), 2);
  assert.equal(matchTier("intv", "interview"), 1);
  assert.equal(matchTier("x", "dato"), 0);
  // Uskarpt kræver samme forbogstav, så »/kapitel« ikke hænger fast i tilfældige navne.
  assert.equal(matchTier("nvw", "interview"), 0);
});

test("et alias finder kommandoen, men navnet vinder på samme trin", () => {
  const factbox = cmd("faktaboks", "template", "builtin", ["factbox"]);
  assert.ok(scoreCommand("factbox", factbox) > 0);
  assert.ok(scoreCommand("fakt", factbox) > scoreCommand("fact", factbox));
  assert.equal(scoreCommand("zzz", factbox), 0);
});

const library = [
  cmd("min-skabelon", "template", "user"),
  cmd("mit-tjek", "check", "user"),
  cmd("dato"),
  cmd("interview"),
  cmd("store", "transform"),
  cmd("citat", "transform"),
  cmd("mangler", "check"),
  cmd("nylæser", "ai"),
];
const names = (rows: { command: Command }[]) => rows.map((r) => r.command.name);

test("uden søgning: senest brugte (højst tre), egne, og så grupperne Skabeloner, Omform, Tjek, AI", () => {
  const rows = rankCommands(library, "", ["citat", "findes-ikke", "dato", "mit-tjek", "store"], false);
  assert.deepEqual(names(rows), ["citat", "dato", "min-skabelon", "mit-tjek", "interview", "store", "mangler", "nylæser"]);
  assert.deepEqual(
    rows.map((r) => r.section),
    ["recent", "recent", "own", "own", "template", "transform", "check", "ai"],
  );
});

test("med en markering står omformninger og AI først", () => {
  const rows = rankCommands(library, "", ["dato"], true);
  assert.deepEqual(names(rows), ["store", "citat", "nylæser", "dato", "min-skabelon", "interview", "mit-tjek", "mangler"]);
  assert.deepEqual(rows[0].section, "transform");
});

test("med søgning vinder det bedste træf, og senest brugte afgør resten", () => {
  assert.deepEqual(names(rankCommands(library, "m", [], false)), ["min-skabelon", "mit-tjek", "mangler"]);
  assert.deepEqual(names(rankCommands(library, "m", ["mangler"], false)), ["mangler", "min-skabelon", "mit-tjek"]);
  assert.deepEqual(names(rankCommands(library, "ci", [], false)), ["citat"]);
  assert.deepEqual(names(rankCommands(library, "nylaeser", [], false)), ["nylæser"]);
  assert.deepEqual(rankCommands(library, "qqq", [], false), []);
  // Et præfikstræf går forrest, også selv om et andet navn står tidligere i listen.
  assert.deepEqual(names(rankCommands(library, "te", [], false)), ["interview"]);
  assert.deepEqual(names(rankCommands(library, "st", [], false)), ["store"]);
});

// --- feltet: hvornår menuen er tændt ------------------------------------------------------------------

const start = (doc: string, anchor = doc.length) =>
  EditorState.create({ doc, selection: { anchor }, extensions: [menuField, markdown({ base: markdownLanguage })] });
/** Skriv teksten et tegn ad gangen, som tastaturet gør. */
function type(state: EditorState, text: string): EditorState {
  for (const ch of text) {
    const at = state.selection.main.head;
    state = state.update({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 }, userEvent: "input.type" }).state;
  }
  return state;
}
const armed = (s: EditorState) => s.field(menuField) !== null;

test("et tastet »/« tænder menuen, og navnet kan skrives videre", () => {
  let s = type(start("Tekst "), "/");
  assert.deepEqual(s.field(menuField), { mode: "slash", pos: 6 });
  s = type(s, "dat");
  assert.deepEqual(s.field(menuField), { mode: "slash", pos: 6 });
});

test("»og/eller«, »5/10«, »km/t« og en webadresse tænder ikke menuen", () => {
  assert.equal(armed(type(start(""), "og/")), false);
  assert.equal(armed(type(start(""), "5/")), false);
  assert.equal(armed(type(start(""), "km/")), false);
  assert.equal(armed(type(start(""), "https:/")), false);
  assert.equal(armed(type(start(""), "https://")), false);
});

test("mellemrum, et slettet »/« og en flyttet markør slukker menuen", () => {
  const s = type(start(""), "/da");
  assert.equal(armed(type(s, " ")), false);
  assert.equal(armed(s.update({ selection: { anchor: 0 } }).state), false);
  let back = s;
  for (let i = 0; i < 2; i++) {
    const at = back.selection.main.head;
    back = back.update({ changes: { from: at - 1, to: at }, selection: { anchor: at - 1 }, userEvent: "delete.backward" }).state;
  }
  assert.equal(armed(back), true, "»/« står der endnu");
  back = back.update({ changes: { from: 0, to: 1 }, selection: { anchor: 0 }, userEvent: "delete.backward" }).state;
  assert.equal(armed(back), false);
});

test("en afvist menu åbner ikke igen på samme skråstreg", () => {
  let s = type(start(""), "/d");
  s = s.update({ effects: setMenu.of(null) }).state;
  assert.equal(armed(type(s, "ato")), false);
});

test("indsat, trukket og fortrudt tekst tænder ikke menuen", () => {
  for (const userEvent of ["input.paste", "input.drop", "undo", "redo"]) {
    const s = start("").update({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 }, userEvent }).state;
    assert.equal(armed(s), false, userEvent);
  }
  const whole = start("").update({ changes: { from: 0, insert: "/dato" }, selection: { anchor: 5 }, userEvent: "input.type" }).state;
  assert.equal(armed(whole), false);
});

test("i en kodeblok, i en note og i en adresse er »/« bare tekst", () => {
  assert.equal(armed(type(start("```\nkode \n```", 9), "/")), false);
  assert.equal(armed(type(start("Almindelig tekst "), "/")), true);
  assert.equal(armed(type(start("Tekst <!-- husk "), "/")), false);
  assert.equal(armed(type(start("Se [her]("), "/")), false);
});

test("genvejsmenuen lever, til teksten eller markeringen ændres", () => {
  const s = start("Et afsnit.").update({ selection: { anchor: 0, head: 2 } }).state;
  const open = s.update({ effects: setMenu.of({ mode: "palette", query: "" }) }).state;
  assert.deepEqual(open.field(menuField), { mode: "palette", query: "" });
  assert.equal(open.selection.main.to, 2, "markeringen står");
  assert.equal(armed(open.update({ selection: { anchor: 5 } }).state), false);
  assert.equal(armed(open.update({ changes: { from: 0, to: 2 }, userEvent: "delete.selection" }).state), false);
});
