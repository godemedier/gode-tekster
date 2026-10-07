import { test } from "node:test";
import assert from "node:assert/strict";
import type { Lang } from "../i18n.ts";
import { applyChain, parseChain } from "./blocks.ts";
import { builtinCommands, builtinProblems, offersDimming, withoutDanishLetters } from "./builtin.ts";
import { runCheck } from "./checks.ts";
import { expandTemplate } from "./fields.ts";
import { parseCommand, serializeCommand, validateCommand } from "./model.ts";
import type { FieldContext } from "./types.ts";

const LANGS: Lang[] = ["da", "en"];
const ctx = (lang: Lang): FieldContext => ({ now: new Date(2026, 9, 5, 14, 32), lang, name: "Kim Skribent", filename: "ARTIKEL", title: "En rubrik", selection: "", words: 1180, characters: 7412, readingMinutes: 5 });
const get = (lang: Lang, name: string) => {
  const c = builtinCommands(lang).find((x) => x.name === name || x.aliases.includes(name));
  assert.ok(c, `/${name} mangler på ${lang}`);
  return c;
};

test("alle indbyggede kan læses og er gyldige på begge sprog", () => {
  assert.deepEqual(builtinProblems(), []);
  for (const lang of LANGS) {
    for (const c of builtinCommands(lang)) {
      assert.deepEqual(validateCommand(c), [], `/${c.name} (${lang})`);
      assert.equal(c.source, "builtin");
      assert.equal(c.path, undefined);
      // »Tilpas« lægger en kopi i brugerens mappe: den skal kunne læses igen som brugerens egen.
      const copy = parseCommand(serializeCommand(c), "user");
      assert.ok(copy.ok, `/${c.name} (${lang}) kan ikke gemmes og læses`);
      assert.deepEqual({ ...copy.command, source: "builtin" }, c);
    }
  }
});

test("startbiblioteket er 12 kommandoer: 3 skabeloner, 5 omformninger, 1 tjek og 3 AI", () => {
  for (const lang of LANGS) {
    const all = builtinCommands(lang);
    const count = (kind: string) => all.filter((c) => c.kind === kind).length;
    assert.deepEqual([all.length, count("template"), count("transform"), count("check"), count("ai")], [12, 3, 5, 1, 3], lang);
  }
  assert.deepEqual(
    builtinCommands("da").map((c) => c.name),
    ["dato", "tabel", "møde", "brev", "ryd", "liste", "sorter", "citat", "tjek", "nylæser", "redaktør", "halver"],
  );
  assert.deepEqual(
    builtinCommands("en").map((c) => c.name),
    ["date", "table", "meeting", "letter", "tidy", "list", "sort", "quote", "check", "newreader", "editor", "half"],
  );
});

test("navne er entydige på hvert sprog, og intet alias rammer en anden kommando", () => {
  for (const lang of LANGS) {
    const all = builtinCommands(lang);
    const names = all.map((c) => c.name);
    assert.equal(new Set(names).size, names.length, lang);
    const seen = new Map<string, string>();
    for (const c of all) {
      for (const n of [c.name, ...c.aliases]) {
        assert.ok(!seen.has(n), `${n} peger både på /${seen.get(n)} og /${c.name} (${lang})`);
        seen.set(n, c.name);
      }
      assert.ok(!c.aliases.includes(c.name));
    }
  }
});

test("AI formulerer aldrig tekst: kun findings og questions, og ingen rubrikker eller manchet", () => {
  for (const lang of LANGS) {
    for (const c of builtinCommands(lang)) {
      if (c.kind === "ai") assert.ok(c.output === "findings" || c.output === "questions", c.name);
      else assert.equal(c.output, undefined, c.name);
      for (const gone of ["rubrikker", "headlines", "manchet", "standfirst", "mellemrubrikker", "subheads"]) assert.ok(c.name !== gone && !c.aliases.includes(gone), gone);
    }
  }
  assert.equal(get("da", "redaktør").output, "questions");
  assert.equal(get("da", "nylæser").output, "findings");
  assert.equal(get("da", "halver").output, "findings");
  assert.ok(offersDimming(get("da", "halver")));
  assert.ok(offersDimming(get("en", "half")));
  assert.ok(!offersDimming(get("da", "nylæser")));
  assert.ok(!offersDimming({ ...get("da", "halver"), source: "user" }), "en tilpasset kopi er brugerens egen");
});

test("det andet sprogs navn er alias, og æøå kan skrives med ae, oe og aa", () => {
  assert.equal(get("en", "brev").name, "letter", "/brev virker i den engelske udgave");
  assert.match(get("en", "brev").body, /Kind regards/, "og giver den engelske tekst");
  assert.equal(get("da", "letter").name, "brev");
  assert.equal(get("da", "check").name, "tjek");
  assert.equal(get("en", "tjek").name, "check");
  assert.equal(get("da", "moede").name, "møde");
  assert.equal(get("da", "nylaeser").name, "nylæser");
  assert.equal(get("da", "redaktoer").name, "redaktør");
  assert.equal(get("en", "møde").name, "meeting");
  assert.equal(get("en", "moede").name, "meeting");
  assert.equal(withoutDanishLetters("blåbærgrød"), "blaabaergroed");
});

test("ingen indbygget er låst til ét sprog, og hvert kald giver nye objekter", () => {
  for (const lang of LANGS) for (const c of builtinCommands(lang)) assert.equal(c.lang, undefined, c.name);
  const first = builtinCommands("da");
  first[0].aliases.push("ødelagt");
  first[0].name = "ødelagt";
  assert.equal(builtinCommands("da")[0].name, "dato");
  assert.ok(!builtinCommands("da")[0].aliases.includes("ødelagt"));
});

test("/dato og /brev som tekst på begge sprog", () => {
  assert.equal(expandTemplate(get("da", "dato").body, ctx("da")).text, "5. oktober 2026");
  assert.equal(expandTemplate(get("en", "date").body, ctx("en")).text, "5 October 2026");
  const brev = expandTemplate(get("da", "brev").body, ctx("da"));
  assert.equal(brev.text, "5. oktober 2026\n\nKære navn\n\n\n\nVenlig hilsen\nKim Skribent");
  assert.equal(brev.text.slice(brev.stops[0].from, brev.stops[0].to), "navn");
  assert.equal(brev.cursor, brev.text.indexOf("\n\nVenlig"), "markøren står, hvor brevet skal skrives");
});

test("/tabel er en omformning med klodsen table på begge sprog", () => {
  for (const lang of LANGS) {
    const c = get(lang, "tabel");
    assert.equal(c.kind, "transform");
    assert.equal(c.body.trim(), "table");
  }
});

test("alle skabeloner kan udfoldes uden rester af felter", () => {
  for (const lang of LANGS) {
    for (const c of builtinCommands(lang).filter((x) => x.kind === "template")) {
      const r = expandTemplate(c.body, ctx(lang));
      assert.ok(!r.text.includes("{{") && !r.text.includes("}}"), `/${c.name} (${lang})`);
      assert.ok(r.text.length > 0);
    }
  }
  assert.ok(expandTemplate(get("da", "møde").body, ctx("da")).text.startsWith("# Møde: emne, 5. oktober 2026\n"));
});

test("omformningerne som tekst: ryd, liste, sorter og citat", () => {
  const run = (lang: Lang, name: string, text: string) => applyChain(parseChain(get(lang, name).body).steps, text, lang);
  assert.deepEqual(run("da", "citat", "Det er for dyrt"), { text: "»Det er for dyrt«", then: null });
  assert.deepEqual(run("en", "quote", "It costs too much"), { text: "“It costs too much”", then: null });
  assert.equal(run("en", "citat", "Too much").text, "“Too much”", "det danske navn giver den engelske udgave");
  assert.equal(run("da", "ryd", 'Han  sagde "nej\ntak" ...').text, "Han sagde »nej tak« …");
  assert.equal(run("da", "ryd", "Det er  en tekst ,som\ner indsat...").text, "Det er en tekst, som er indsat…");
  assert.equal(run("da", "sorter", "Åse\nAnna\nØrum").text, "Anna\nØrum\nÅse");
  assert.equal(run("da", "liste", "a\nb").text, "- a\n- b");
});

test("en omformning rører ikke fraklip og noter i det markerede", () => {
  const parked = "<!-- gt:parkeret id=p1 dato=2026-10-05\nEt  \"klip\" ...\n-->";
  const text = `B  "linje" ... <!-- min  "note" ... -->\nA linje\n\n${parked}\n`;
  for (const lang of LANGS) {
    for (const c of builtinCommands(lang).filter((x) => x.kind === "transform")) {
      const out = applyChain(parseChain(c.body).steps, text, lang).text;
      assert.ok(out.endsWith(`\n\n${parked}\n`), `/${c.name} rørte fraklippet`);
      assert.ok(out.includes('<!-- min  "note" ... -->'), `/${c.name} rørte noten`);
    }
  }
});

test("/tjek samler huller, navne, tal og gentagelser og skriver intet", () => {
  const text = "Hansen sagde TK. Senere sagde Hanssen det det igen. Der var 40 deltagere, siden 45 deltagere. <!-- TJEK: navnet -->";
  const before = text.slice();
  for (const [lang, name] of [["da", "tjek"], ["en", "check"]] as const) {
    assert.deepEqual(
      runCheck(get(lang, name), text, lang).map((f) => f.excerpt),
      ["Hansen", "TK", "Hanssen", "det det", "40", "45", "<!-- TJEK: navnet -->"],
      lang,
    );
  }
  assert.equal(text, before);
});
