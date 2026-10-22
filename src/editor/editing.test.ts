import { test } from "node:test";
import assert from "node:assert/strict";
import { insertFootnote, setHeading, toggleLinePrefix, toggleWrap, wordRangeAt, wrapLink, type EditPlan } from "./editing.ts";

const apply = (t: string, p: EditPlan) => t.slice(0, p.start) + p.replacement + t.slice(p.end);

test("en fodnote lægges før tags, så de stadig er sidste synlige linje", () => {
  const doc = "Tekst.\n\n#klima #bog\n";
  const plan = insertFootnote(doc, 5, "Kilde");
  let result = doc;
  for (const c of [...plan.changes].reverse()) result = result.slice(0, c.from) + c.insert + result.slice(c.from);
  assert.match(result, /\[\^1\]: Kilde\n\n#klima #bog\n$/);
  assert.equal(result.slice(plan.cursor, plan.cursor + 5), "Kilde");
});

test("ordet omkring markøren, også med æøå", () => {
  const t = "en grøn æske";
  const r = wordRangeAt(t, 5);
  assert.equal(t.slice(r.start, r.end), "grøn");
});

test("fed slås til og fra, også uden markering", () => {
  assert.equal(apply("en grøn æske", toggleWrap("en grøn æske", 5, 5, "**")), "en **grøn** æske");
  assert.equal(apply("en **grøn** æske", toggleWrap("en **grøn** æske", 5, 9, "**")), "en grøn æske");
});

test("understregning og dæmpet tekst med forskellige tegn", () => {
  assert.equal(apply("ét ord", toggleWrap("ét ord", 3, 6, "<u>", "</u>")), "ét <u>ord</u>");
  assert.equal(apply("ét <u>ord</u>", toggleWrap("ét <u>ord</u>", 6, 9, "<u>", "</u>")), "ét ord");
  assert.equal(apply("måske ud", toggleWrap("måske ud", 0, 8, "{--", "--}")), "{--måske ud--}");
});

test("kursiv og fed over en liste: hvert punkt for sig, efter listetegnet (14/10)", () => {
  const t = "Indkøb:\n- æbler\n- 2 pærer\n\n1. ost\n";
  const from = t.indexOf("- æbler");
  const to = t.indexOf("ost") + 3;
  const on = apply(t, toggleWrap(t, from, to, "*"));
  assert.equal(on, "Indkøb:\n- *æbler*\n- *2 pærer*\n\n1. *ost*\n");
  // Igen: fjernes, også når markeringen nu dækker tegnene.
  const p = toggleWrap(on, on.indexOf("- *æbler"), on.indexOf("ost*") + 4, "*");
  assert.equal(apply(on, p), t);
  // Fed på punkter, hvoraf ét allerede er fed: kun det andet får tegnene.
  const mix = "- **a**\n- b";
  assert.equal(apply(mix, toggleWrap(mix, 0, mix.length, "**")), "- **a**\n- **b**");
  // Tredobbeltklik på ét punkt markerer linjeskiftet med: kun det punkt.
  const one = "- a\n- b";
  assert.equal(apply(one, toggleWrap(one, 0, 4, "*")), "- *a*\n- b");
  // Afkrydsning, citat og overskrift bliver også stående foran.
  assert.equal(apply("- [ ] gør det", toggleWrap("- [ ] gør det", 0, 13, "*")), "- [ ] *gør det*");
  assert.equal(apply("> sagt\n> igen", toggleWrap("> sagt\n> igen", 0, 13, "*")), "> *sagt*\n> *igen*");
  // Midt i et punkt: som før.
  assert.equal(apply("- en grøn æske", toggleWrap("- en grøn æske", 5, 9, "*")), "- en *grøn* æske");
});

test("lister erstatter hinanden og nummereres", () => {
  const t = "- a\n- b";
  assert.equal(apply(t, toggleLinePrefix(t, 0, t.length, "1. ")), "1. a\n2. b");
  assert.equal(apply("1. a\n2. b", toggleLinePrefix("1. a\n2. b", 0, 9, "1. ")), "a\nb");
  assert.equal(apply("a", toggleLinePrefix("a", 0, 0, "- [ ] ")), "- [ ] a");
  assert.equal(apply("- a", toggleLinePrefix("- a", 0, 0, "> ")), "> a");
});

test("overskriftsniveau skiftes, samme niveau igen fjerner det", () => {
  assert.equal(apply("Titel", setHeading("Titel", 0, 0, 2)), "## Titel");
  assert.equal(apply("## Titel", setHeading("## Titel", 3, 3, 1)), "# Titel");
  assert.equal(apply("## Titel", setHeading("## Titel", 3, 3, 2)), "Titel");
  assert.equal(apply("### Titel", setHeading("### Titel", 3, 3, 0)), "Titel");
});

test("link med markøren i parentesen", () => {
  const p = wrapLink("se her", 3, 6);
  assert.equal(apply("se her", p), "se [her]()");
  assert.equal(p.selStart, 9);
});

test("fodnote: næste nummer, definition før parkeret tekst", () => {
  const t = "Tekst[^1] mere.\n\n[^1]: Kilde.\n\n<!-- gt:parkeret id=p1\nx\n-->\n";
  const pos = t.indexOf(" mere");
  const { changes, cursor } = insertFootnote(t, pos);
  let out = t;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.from);
  assert.ok(out.includes("Tekst[^1][^2] mere."));
  assert.ok(out.includes("[^1]: Kilde.\n\n[^2]: \n\n<!-- gt:parkeret"));
  assert.equal(out.slice(cursor - 6, cursor), "[^2]: ");
});

test("gennemstregning af en markering med mellemrum til sidst: mellemrummet står udenfor (7/10)", () => {
  const t = "Skriv noveller. Send til forlag. Mere";
  const plan = toggleWrap(t, 0, 33, "~~");
  assert.equal(apply(t, plan), "~~Skriv noveller. Send til forlag.~~ Mere");
  assert.equal(apply(" fed ", toggleWrap(" fed ", 0, 5, "**")), " **fed** ");
  // Kun mellemrum: tegnene sættes stadig om, som før.
  assert.equal(apply("a   b", toggleWrap("a   b", 1, 4, "*")), "a*   *b");
});

test("Ctrl+I og Ctrl+B kender forskel på * og ** (fejljagt F1-B4, B5)", () => {
  // Kursiv på et fedt ord: fed og kursiv, ikke kun kursiv.
  assert.equal(apply("et **ord** her", toggleWrap("et **ord** her", 6, 6, "*")), "et ***ord*** her");
  assert.equal(apply("et ***ord*** her", toggleWrap("et ***ord*** her", 7, 7, "*")), "et **ord** her");
  assert.equal(apply("et *ord* her", toggleWrap("et *ord* her", 5, 5, "*")), "et ord her");
  // Fed lige efter et fedt ord: intet sker. Kursiv lige efter: ordet bliver også kursivt.
  const p = toggleWrap("et **ord**", 10, 10, "**");
  assert.equal(apply("et **ord**", p), "et **ord**");
  assert.equal(p.selStart, 10);
  assert.equal(apply("et **ord**", toggleWrap("et **ord**", 10, 10, "*")), "et ***ord***");
  // En markering over kanten af et par: parret udvides.
  assert.equal(apply("et **fedt** ord", toggleWrap("et **fedt** ord", 7, 13, "**")), "et **fedt o**rd");
  assert.equal(apply("et fe**dt ord**", toggleWrap("et fe**dt ord**", 3, 8, "**")), "et **fedt ord**");
});
