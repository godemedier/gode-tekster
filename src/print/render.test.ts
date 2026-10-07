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

test("metadata og sidehoved", () => {
  const meta = metaFor(doc, "ARTIKEL.md", "Kim Skribent", new Date(2026, 9, 2));
  assert.equal(meta.title, "Sådan bruger du 120 milliarder");
  assert.equal(meta.date, "2. oktober 2026");
  assert.match(meta.countLine, /anslag inkl\. mellemrum \(.+ normalsider\) · .+ ord/);
  assert.match(pageCss("manuskript", meta), /"Skribent · Sådan bruger du 120 milliarder"/);
  assert.equal(danishDate(new Date(2026, 0, 31)), "31. januar 2026");
});

test("anførselstegn i titlen kan ikke bryde ud af CSS-strengen", () => {
  const meta = metaFor('# Et "farligt" \\ navn', "x.md", "T K");
  assert.match(pageCss("laeseudgave", meta), /content: "ET \\"FARLIGT\\" \\\\ NAVN"/);
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
