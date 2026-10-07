import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeCommands, visibleCommands, withRecent } from "./store.ts";
import type { Command, CommandFile, ParseResult } from "./types.ts";

function command(name: string, extra: Partial<Command> = {}): Command {
  return { name, kind: "template", description: name, aliases: [], scope: "selection", newfile: false, body: "x", source: "builtin", ...extra };
}

/** En lille parser til testen: første linje er navnet, »FEJL« giver en fejl i linje 3, »lang:en« sætter sproget. */
function parse(text: string, source: "user", path: string): ParseResult {
  if (text.startsWith("FEJL")) return { ok: false, errors: [{ line: 3, message: "ukendt felt" }] };
  const [name, flag] = text.split("\n");
  return { ok: true, command: command(name, { source, path, lang: flag === "lang:en" ? "en" : undefined }) };
}

const file = (fileName: string, text: string): CommandFile => ({ path: `C:\\K\\${fileName}`, fileName, text });

test("egne står først og skygger for en indbygget med samme navn", () => {
  const m = mergeCommands([command("dato"), command("ryd")], [file("ryd.md", "ryd")], parse, [], "da");
  assert.deepEqual(m.entries.map((e) => `${e.command.name}:${e.command.source}`), ["ryd:user", "dato:builtin"]);
  assert.equal(m.entries[0].command.path, "C:\\K\\ryd.md");
  assert.equal(m.broken.length, 0);
});

test("slåede fra står i fanen, men ikke i menuen", () => {
  const m = mergeCommands([command("dato"), command("ryd")], [], parse, ["ryd"], "da");
  assert.deepEqual(m.entries.map((e) => e.enabled), [true, false]);
  assert.deepEqual(visibleCommands(m.entries, "da").map((c) => c.name), ["dato"]);
});

test("sprog: indbyggede til det andet sprog udelades, egne med lang vises i fanen, men ikke i menuen", () => {
  const m = mergeCommands([command("stil", { lang: "da" }), command("dato")], [file("mine.md", "mine\nlang:en")], parse, [], "en");
  assert.deepEqual(m.entries.map((e) => e.command.name), ["mine", "dato"]);
  assert.deepEqual(visibleCommands(m.entries, "en").map((c) => c.name), ["mine", "dato"]);
  const da = mergeCommands([command("stil", { lang: "da" })], [file("mine.md", "mine\nlang:en")], parse, [], "da");
  assert.deepEqual(da.entries.map((e) => e.command.name), ["mine", "stil"]);
  assert.deepEqual(visibleCommands(da.entries, "da").map((c) => c.name), ["stil"]);
});

test("en fil med fejl lægges til side med linjenummer og ødelægger ikke de andre", () => {
  const m = mergeCommands([command("dato")], [file("a.md", "FEJL"), file("b.md", "husstil")], parse, [], "da");
  assert.deepEqual(m.broken, [{ path: "C:\\K\\a.md", fileName: "a.md", errors: [{ line: 3, message: "ukendt felt" }] }]);
  assert.deepEqual(m.entries.map((e) => e.command.name), ["husstil", "dato"]);
});

test("en fil, Rust ikke kunne læse, lægges til side med Rusts besked", () => {
  const m = mergeCommands([], [{ ...file("stor.md", ""), error: "Filen er for stor." }], parse, [], "da");
  assert.deepEqual(m.broken, [{ path: "C:\\K\\stor.md", fileName: "stor.md", errors: [{ line: 0, message: "Filen er for stor." }] }]);
  assert.equal(m.entries.length, 0);
});

test("to filer med samme navn: den første gælder, den anden lægges til side", () => {
  const m = mergeCommands([], [file("b.md", "ens"), file("a.md", "ens")], parse, [], "da", (n) => `findes: ${n}`);
  assert.deepEqual(m.entries.map((e) => e.command.path), ["C:\\K\\a.md"]);
  assert.deepEqual(m.broken, [{ path: "C:\\K\\b.md", fileName: "b.md", errors: [{ line: 1, message: "findes: ens" }] }]);
});

test("senest brugte: nyeste først, ingen gentagelser, højst tre", () => {
  assert.deepEqual(withRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
  assert.deepEqual(withRecent(["a", "b", "c"], "d"), ["d", "a", "b"]);
});
