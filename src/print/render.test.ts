import { test } from "node:test";
import assert from "node:assert/strict";
import { articleHtml, danishDate, metaFor, pageCss, prepare, typography } from "./render.ts";
import { setLangForTest } from "../i18n.ts";

const doc = `# Sådan bruger du 120 milliarder

Statsministeren talte {--meget længe--} kl. 10 om 5 mia. kr.[^1]

<script>alert(1)</script>

Det er <u>vigtigt</u> - siger hun.

[^1]: Interview, september 2026.

<!-- gt:parkeret id=p1 dato=2026-10-02
Parkeret tekst
-->
`;

test("fraklip og dæmpet tekst kommer ikke med, med mindre det vælges", () => {
  const p = prepare(doc, false);
  assert.ok(!p.includes("Parkeret tekst"));
  assert.ok(!p.includes("meget længe"));
  assert.ok(prepare(doc, true).includes("meget længe"));
});

test("hårde mellemrum og tankestreg, men intervaller røres ikke", () => {
  assert.equal(typography("kl. 10"), "kl. 10");
  assert.equal(typography("5 mia. kr."), "5 mia. kr.");
  assert.equal(typography("ord - ord"), "ord – ord");
  assert.equal(typography("9-16 og mandag-fredag"), "9-16 og mandag-fredag");
  assert.equal(typography("- [ ] ring\n- [x] tjek"), "- ☐ ring\n- ☒ tjek");
});

test("HTML i teksten escapes, kun <u> slipper igennem, noter samles sidst", () => {
  const meta = metaFor(doc, "ARTIKEL.md", "Kim Skribent", new Date(2026, 9, 2));
  const html = articleHtml(doc, { template: "laeseudgave", includeDimmed: false }, meta);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("<u>vigtigt</u>"));
  assert.ok(html.includes('class="notes-title">Noter<'));
  assert.ok(!html.includes("↩"));
  assert.equal((html.match(/<h1/g) ?? []).length, 1, "titlen står én gang");
});

test("sidehoved og sidefod: forfatter og dato øverst, tal på første side, sidetal fra side 2 (9/10)", () => {
  const meta = metaFor(doc, "ARTIKEL.md", "Kim Skribent", new Date(2026, 9, 2));
  assert.equal(meta.title, "Sådan bruger du 120 milliarder");
  assert.equal(meta.date, "2. oktober 2026");
  assert.match(meta.countLine, /anslag inkl\. mellemrum \(.+ normalsider\) · .+ ord/);
  const css = pageCss("manuskript", meta);
  assert.match(css, /@top-center \{ content: "Kim Skribent · 2\. oktober 2026"/);
  assert.match(css, /@bottom-center \{ content: counter\(page\)/);
  assert.match(css, /@page :first \{ @bottom-center \{ content: ".*anslag/);
  const bare = pageCss("manuskript", meta, { byline: false, counts: false, pageNumbers: false });
  assert.doesNotMatch(bare, /@top-center|counter\(page\)|anslag/);
  assert.equal(danishDate(new Date(2026, 0, 31)), "31. januar 2026");
});

test("anførselstegn i forfatterens navn kan ikke bryde ud af CSS-strengen", () => {
  const meta = metaFor("Tekst.", "x.md", 'Kim "farlig" \\ Skribent');
  assert.match(pageCss("laeseudgave", meta), /content: "Kim \\"farlig\\" \\\\ Skribent · /);
});

test("titlen er tekstens egen overskrift, aldrig filnavnet, og ingen byline i teksten (9/10)", () => {
  const meta = metaFor(doc, "ARTIKEL.md", "Kim Skribent", new Date(2026, 9, 2));
  const html = articleHtml(doc, { template: "manuskript", includeDimmed: false }, meta);
  assert.match(html, /<header class="pv-head"><h1 class="pv-title">Sådan bruger du 120 milliarder<\/h1><\/header>/);
  assert.doesNotMatch(html, /Kim Skribent|anslag/);
  assert.doesNotMatch(articleHtml("Bare tekst.", { template: "manuskript", includeDimmed: false }, metaFor("Bare tekst.", "noter.md", "")), /pv-title|noter/);
});

test("billeder: figur med billedtekst, relative stier tilladt, og »Kun tekst« udelader dem (9/10)", () => {
  const md = "Før.\n\n![Havnen om morgenen](medier/havn.jpg)\n\nEfter.";
  const meta = metaFor(md, "x.md", "");
  const url = (src: string) => `asset://${src}`;
  const med = articleHtml(md, { template: "manuskript", includeDimmed: false }, meta, url);
  assert.match(med, /<figure class="pv-wide pv-fig"><img src="asset:\/\/medier\/havn\.jpg" alt="Havnen om morgenen"><em class="pv-cap">Havnen om morgenen<\/em><\/figure>/);
  const uden = articleHtml(md, { template: "manuskript", includeDimmed: false, images: false }, meta, url);
  assert.doesNotMatch(uden, /img|figure|<p><\/p>/);
  // Links må stadig ikke pege på andet end nettet, mail eller dokumentet.
  assert.doesNotMatch(articleHtml("[x](javascript:alert(1))", { template: "manuskript", includeDimmed: false }, meta), /href/);
});

test("tabeller står i en bred boks (9/10)", () => {
  const md = "| a | b |\n|---|---|\n| 1 | 2 |";
  assert.match(articleHtml(md, { template: "manuskript", includeDimmed: false }, metaFor(md, "x.md", "")), /<div class="pv-wide"><table>/);
});

test("en ekstra tom linje bliver et luft-afsnit i print, også ikke inde i kode", async () => {
  const { articleHtml, metaFor } = await import("./render.ts");
  const md = "Et.\n\n\nTo.\n\n```\na\n\n\nb\n```";
  const html = articleHtml(md, { template: "manuskript", includeDimmed: false } as never, metaFor(md, "x.md", ""));
  assert.equal((html.match(/<p class="luft"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /⁣/);
});

test("bogstavlister bliver til ordnede lister i print, med formatering i punkterne", async () => {
  const { articleHtml, metaFor } = await import("./render.ts");
  const html = (md: string) => articleHtml(md, { template: "manuskript", includeDimmed: false } as never, metaFor(md, "x.md", ""));
  const a = html("Indledning.\n\na. Første **fed**\nb. Anden\nc. Tredje");
  assert.match(a, /<ol type="a" data-type="a">/);
  assert.equal((a.match(/<li>/g) ?? []).length, 3);
  assert.match(a, /<strong>fed<\/strong>/);
  assert.match(html("a) Et\nb) To"), /<ol type="a" data-type="a" data-delim="\)">/);
  assert.match(html("i. Et\nii. To"), /<ol type="i" data-type="i">/);
  assert.doesNotMatch(html("A. P. Møller købte rederiet."), /<ol/);
});

test("en bogstavliste med »-« lige under bliver en liste i print, ikke en overskrift", async () => {
  const { articleHtml, metaFor } = await import("./render.ts");
  const md = "a. Et\nb. To\n-\nundskyldning.";
  const html = articleHtml(md, { template: "manuskript", includeDimmed: false } as never, metaFor(md, "x.md", ""));
  assert.match(html, /<ol type="a"/);
  assert.doesNotMatch(html, /<h2/);
});

test("på engelsk: dato, tællelinje og noter i print", () => {
  setLangForTest("en");
  try {
    const meta = metaFor(doc, "ARTIKEL.md", "Kim Skribent", new Date(2026, 9, 5));
    assert.equal(meta.date, "5 October 2026");
    assert.match(meta.countLine, /characters incl\. spaces \(.+ standard pages\) · .+ words/);
    const html = articleHtml(doc, { template: "manuskript", includeDimmed: false }, meta);
    assert.ok(html.includes('class="notes-title">Notes<'));
  } finally {
    setLangForTest("da");
  }
});
