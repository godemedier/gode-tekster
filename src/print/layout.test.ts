import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultLayout,
  layoutFrom,
  nextTarget,
  PAGE,
  pageRows,
  parseCm,
  place,
  placed,
  remove,
  slotParts,
  templatesFrom,
  withFirstDifferent,
  withTemplate,
  type PageLayout,
} from "./layout.ts";
import { metaFor, pageCss, pageMargins } from "./render.ts";

const values = { author: "Kim Skribent", date: "9. oktober 2026", title: "Havnebadet", countLine: "4.210 anslag · 700 ord" };

test("en plads: tekst ved siden af tekst bliver én streng, »Indhold« vælger fra", () => {
  assert.deepEqual(slotParts([{ kind: "author" }, { kind: "date" }], values), ["Kim Skribent · 9. oktober 2026"]);
  assert.deepEqual(slotParts([{ kind: "author" }, { kind: "pageNumber" }], values), ["Kim Skribent · ", PAGE]);
  assert.deepEqual(slotParts([{ kind: "text", text: "Side" }, { kind: "pageNumber" }], values), ["Side ", PAGE]);
  assert.deepEqual(slotParts([{ kind: "author" }, { kind: "date" }], values, { byline: false }), []);
  assert.deepEqual(slotParts([{ kind: "counts" }], values, { counts: false }), []);
  assert.deepEqual(slotParts([{ kind: "pageNumber" }], values, { pageNumbers: false }), []);
  // Uden forfatternavn står datoen alene, uden prik foran.
  assert.deepEqual(slotParts([{ kind: "author" }, { kind: "date" }], { ...values, author: "" }), ["9. oktober 2026"]);
});

test("standardopsætningen giver sidehoved og sidefod som før side-designeren", () => {
  const meta = metaFor("# Titel\n\nTekst.", "x.md", "Kim Skribent", new Date(2026, 9, 9));
  for (const t of ["manuskript", "laeseudgave"] as const) {
    assert.equal(pageCss(t, meta, {}, defaultLayout(t)), pageCss(t, meta));
    assert.deepEqual(pageMargins(t, defaultLayout(t)), pageMargins(t));
  }
  const css = pageCss("manuskript", meta);
  assert.match(css, /^@page \{ size: A4; margin: 3\.5cm 2\.5cm 3cm 2\.5cm; @top-center \{ content: "Kim Skribent · 9\. oktober 2026"; [^}]*\} @bottom-center \{ content: counter\(page\);/);
  // Første side: kun sidefoden er anderledes (tallene i stedet for sidetal).
  assert.match(css, /\n@page :first \{ @bottom-center \{ content: "[^"]*anslag[^"]*"; [^}]*\} \}$/);
  // Tal fravalgt: første side står uden sidetal, som før.
  assert.match(pageCss("manuskript", meta, { counts: false }), /@page :first \{ @bottom-center \{ content: none;/);
});

test("egen opsætning: pladser, margener og første side for sig i @page", () => {
  const meta = metaFor("# Titel\n\nTekst.", "x.md", "Kim Skribent", new Date(2026, 9, 9));
  const l: PageLayout = {
    margins: { top: 3, right: 3.5, bottom: 2.5, left: 3.5 },
    font: "grotesk",
    title: true,
    firstDifferent: true,
    pages: { "top-left": [{ kind: "author" }], "top-right": [{ kind: "date" }], "bottom-right": [{ kind: "text", text: "Side" }, { kind: "pageNumber" }] },
    first: { "top-left": [{ kind: "author" }], "bottom-center": [{ kind: "counts" }] },
  };
  const css = pageCss("laeseudgave", meta, {}, l);
  // Siden er 2 cm smallere i siderne end teksten (udfaldet), og venstre og højre plads flugter med teksten.
  assert.match(css, /margin: 3cm 1\.5cm 2\.5cm 1\.5cm;/);
  assert.match(css, /@top-left \{ content: "Kim Skribent"; [^}]*padding-left: 2cm; \}/);
  assert.match(css, /@top-right \{ content: "9\. oktober 2026"; [^}]*padding-right: 2cm; \}/);
  assert.match(css, /@bottom-right \{ content: "Side " counter\(page\);/);
  const first = css.slice(css.indexOf("@page :first"));
  assert.doesNotMatch(first, /@top-left/, "samme som de andre sider: står ikke igen");
  assert.match(first, /@top-right \{ content: none;/);
  assert.match(first, /@bottom-right \{ content: none;/);
  assert.match(first, /@bottom-center \{ content: "[^"]*anslag/);
  assert.deepEqual(pageMargins("laeseudgave", l), { top: 3, right: 1.5, bottom: 2.5, left: 1.5 });
  // Samme pladser på alle sider: ingen :first.
  assert.doesNotMatch(pageCss("laeseudgave", meta, {}, { ...l, firstDifferent: false }), /:first/);
});

test("Words sidehoved og sidefod: venstre, midte og højre, første side for sig", () => {
  const rows = pageRows(defaultLayout("manuskript"), values);
  assert.deepEqual(rows.pages.header, { left: [], center: ["Kim Skribent · 9. oktober 2026"], right: [] });
  assert.deepEqual(rows.pages.footer.center, [PAGE]);
  assert.deepEqual(rows.first.footer.center, ["4.210 anslag · 700 ord"]);
  const l = place(defaultLayout("manuskript"), "pages", { kind: "title" }, "top-right");
  const own = pageRows({ ...l, firstDifferent: false }, values, { pageNumbers: false });
  assert.deepEqual(own.pages.header.right, ["Havnebadet"]);
  assert.deepEqual(own.first, own.pages, "uden »Første side anderledes« er første side som de andre");
  assert.deepEqual(own.pages.footer, { left: [], center: [], right: [] });
});

test("træk og slip: læg, flyt og fjern brikker", () => {
  const d = defaultLayout("manuskript");
  // Fra listen til en tom plads.
  let l = place(d, "pages", { kind: "title" }, "top-left");
  assert.deepEqual(l.pages["top-left"], [{ kind: "title" }]);
  assert.deepEqual(d.pages["top-left"], undefined, "originalen røres ikke");
  // Flyt dato fra midten til højre.
  l = place(l, "pages", { kind: "date" }, "top-right", { view: "pages", target: "top-center", index: 1 });
  assert.deepEqual(l.pages["top-center"], [{ kind: "author" }]);
  assert.deepEqual(l.pages["top-right"], [{ kind: "date" }]);
  // Samme brik to gange på én plads: nej. Egen tekst uden tekst: nej.
  assert.equal(place(l, "pages", { kind: "author" }, "top-center").pages["top-center"]?.length, 1);
  assert.equal(place(l, "pages", { kind: "text", text: "  " }, "top-left").pages["top-left"]?.length, 1);
  // Trukket ud: væk, og en tom plads forsvinder helt.
  l = remove(l, { view: "pages", target: "top-right", index: 0 });
  assert.equal(l.pages["top-right"], undefined);
  // Titlen: kun Titel-brikken passer, og trukket ud slås den fra.
  assert.equal(place(d, "first", { kind: "author" }, "title"), d);
  const noTitle = remove(d, { view: "first", target: "title", index: 0 });
  assert.equal(noTitle.title, false);
  assert.equal(place(noTitle, "first", { kind: "title" }, "title").title, true);
  assert.equal(placed(noTitle, "first", "title"), false);
  assert.equal(placed(d, "first", "counts"), true);
  assert.equal(placed(d, "pages", "counts"), false);
  assert.equal(placed(d, "pages", "title"), false, "titlen øverst i teksten står kun på første side");
});

test("»Første side anderledes« starter fra de andre siders pladser", () => {
  const l = withFirstDifferent({ ...defaultLayout("manuskript"), firstDifferent: false, first: {} }, true);
  assert.deepEqual(l.first, l.pages);
  // Har første side allerede sine egne, beholdes de.
  assert.deepEqual(withFirstDifferent(defaultLayout("manuskript"), true).first["bottom-center"], [{ kind: "counts" }]);
});

test("piletasterne går mellem pladserne, titlen kun med Titel-brikken", () => {
  assert.equal(nextTarget("top-center", "ArrowLeft", false), "top-left");
  assert.equal(nextTarget("top-left", "ArrowLeft", false), "top-left");
  assert.equal(nextTarget("top-right", "ArrowDown", false), "bottom-right");
  assert.equal(nextTarget("top-right", "ArrowDown", true), "title");
  assert.equal(nextTarget("title", "ArrowDown", true), "bottom-center");
  assert.equal(nextTarget("title", "ArrowRight", true), "title");
  assert.equal(nextTarget("bottom-left", "ArrowUp", false), "top-left");
});

test("margener skrives med komma, og gemte værdier tjekkes", () => {
  assert.equal(parseCm("3,5", 1, 8), 3.5);
  assert.equal(parseCm("3.25 cm", 1, 8), 3.3);
  assert.equal(parseCm("0,5", 1, 8), null);
  assert.equal(parseCm("bred", 1, 8), null);
  assert.equal(parseCm("", 1, 8), null);
  const l = layoutFrom({ margins: { top: 2, left: 1, right: "x" }, font: "comic", title: false, firstDifferent: true, pages: { "top-left": [{ kind: "author" }, { kind: "script" }], nowhere: [] }, first: {} }, "laeseudgave");
  assert.deepEqual(l.margins, { top: 2, right: 4, bottom: 3, left: 4 }, "venstre under 2,5 cm og et ikke-tal afvises");
  assert.equal(l.font, "newsreader");
  assert.equal(l.title, false);
  assert.deepEqual(l.pages, { "top-left": [{ kind: "author" }] });
  assert.deepEqual(layoutFrom(null, "manuskript"), defaultLayout("manuskript"));
});

test("skabeloner: gem under et navn, samme navn overskriver, rod i localStorage ignoreres", () => {
  const a = { name: "Kronik", base: "laeseudgave" as const, layout: defaultLayout("laeseudgave") };
  let list = withTemplate([], a);
  list = withTemplate(list, { ...a, layout: { ...a.layout, title: false } });
  assert.equal(list.length, 1);
  assert.equal(list[0].layout.title, false);
  const read = templatesFrom([{ name: "Kronik", base: "laeseudgave", layout: list[0].layout }, { name: "" }, "x", { name: "Kronik" }, { name: "Andet", base: "noget" }]);
  assert.deepEqual(read.map((t) => [t.name, t.base]), [["Kronik", "laeseudgave"], ["Andet", "manuskript"]]);
  assert.equal(read[0].layout.title, false);
  assert.deepEqual(templatesFrom("ikke en liste"), []);
});
