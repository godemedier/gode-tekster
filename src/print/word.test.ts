import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { encodeMarkup, wordDocument, wordFont, type WordOptions } from "./word.ts";
import { metaFor } from "./render.ts";
import { defaultLayout } from "./layout.ts";

test("Word bevarer kommentarer inde i begge sider af et forslag", () => {
  const result = encodeMarkup("Start {~~gammel <!-- før -->~>ny <!-- efter -->~~} slut");
  assert.deepEqual(result.notes, ["før", "efter"]);
  assert.equal(result.md, "Start \uE004gammel\uE0000\uE001\uE005ny\uE0001\uE001\uE006 slut");
  assert.equal(encodeMarkup("{++ny <!-- note -->++}").md, "\uE002ny\uE0000\uE001\uE003");
});

const zipOf = async (md: string, opts: Partial<WordOptions> = {}) =>
  JSZip.loadAsync(await wordDocument(md, metaFor(md, "x.md", ""), { includeDimmed: false, ...opts }));
const part = async (md: string, file: string, opts: Partial<WordOptions> = {}) => (await zipOf(md, opts)).file(file)!.async("string");
const bodyXml = (md: string, book: boolean) => part(md, "word/document.xml", { book });

// Manuskript med indryk: 1,5 em af 10,5 pt = 315 twips.
test("bogafsnit i Word: indryk kun på afsnit efter afsnit, ingen luft", async () => {
  const xml = await bodyXml("# Titel\n\nFørste afsnit.\n\nAndet afsnit.\n\n- punkt\n\nEfter listen.", true);
  assert.equal((xml.match(/w:firstLine="315"/g) ?? []).length, 1, "kun »Andet afsnit« rykkes ind");
  const andet = xml.slice(0, xml.indexOf("Andet afsnit"));
  assert.match(andet.slice(andet.lastIndexOf("<w:p>")), /w:firstLine="315"/);
});

test("luft imellem (standard): intet indryk", async () => {
  const xml = await bodyXml("Første.\n\nAndet.", false);
  assert.doesNotMatch(xml, /w:firstLine/);
});

test("en ekstra tom linje giver luft i Word, og næste afsnit står ude", async () => {
  const xml = await bodyXml("Første.\n\nAndet.\n\n\nTredje.\n\nFjerde.", true);
  assert.equal((xml.match(/w:firstLine="315"/g) ?? []).length, 2, "Andet og Fjerde, ikke Tredje");
  assert.doesNotMatch(xml, /⁣/, "mærket må ikke stå i dokumentet");
});

test("Word: bogstavliste og valgt punkttegn", async () => {
  const numbering = await part("a. Et\nb. To\n\n- punkt", "word/numbering.xml", { bullet: "–" });
  assert.match(numbering, /w:numFmt w:val="lowerLetter"/);
  assert.match(numbering, /w:lvlText w:val="–"/);
});

test("Manuskript følger skriften fra Indstillinger, med en skrift Office har", async () => {
  assert.equal(wordFont("IBM Plex Serif"), "Georgia");
  assert.equal(wordFont("IBM Plex Mono"), "Consolas");
  assert.equal(wordFont("Recursive Halvmono"), "Consolas");
  assert.equal(wordFont("Literata"), "Georgia");
  assert.equal(wordFont("Schibsted Grotesk"), "Calibri");
  assert.equal(wordFont("iA Writer Duo"), "Consolas");
  assert.equal(wordFont("ukendt"), "Consolas");
  const styles = await part("Tekst.", "word/styles.xml", { font: "IBM Plex Serif" });
  assert.match(styles, /w:ascii="Georgia"/);
  // 10,5 pt brødtekst, linjeafstand mindst 1,75 × 10,5 pt = 368 twips.
  assert.match(styles, /<w:sz w:val="21"\/>/);
  assert.match(styles, /w:line="368" w:lineRule="atLeast"/);
});

test("Manuskript: brede margener som i print, citat med streg til venstre", async () => {
  const zip = await zipOf("> »Et citat.«\n\nTekst.");
  const doc = await zip.file("word/document.xml")!.async("string");
  // 4,5 cm = 2.552 twips til hver side (render.ts MARGINS).
  assert.match(doc, /w:left="2552"/);
  assert.match(doc, /w:right="2552"/);
  const styles = await zip.file("word/styles.xml")!.async("string");
  const citat = styles.slice(styles.indexOf('w:styleId="Citat"'));
  assert.match(citat.slice(0, citat.indexOf("</w:style>")), /<w:left w:val="single"/);
});

test("Læseudgave: Georgia 11, orddeling og indryk på hvert afsnit efter afsnit", async () => {
  const zip = await zipOf("Første.\n\nAndet.", { template: "laeseudgave", font: "IBM Plex Mono" });
  const styles = await zip.file("word/styles.xml")!.async("string");
  assert.match(styles, /w:ascii="Georgia"/);
  assert.match(styles, /<w:sz w:val="22"\/>/);
  const settings = await zip.file("word/settings.xml")!.async("string");
  assert.match(settings, /w:autoHyphenation/);
  const doc = await zip.file("word/document.xml")!.async("string");
  assert.equal((doc.match(/w:firstLine="220"/g) ?? []).length, 1, "kun det andet afsnit");
});

test("Word med noter og forslag: kommentarer og sporede ændringer (7/10)", async () => {
  const md = "Prisen var 5 kroner.<!-- tjek prisen -->\n\nDet var {~~dyrt~>billigt~~} og {++helt++} fint.\n\n<!-- en note for sig -->\n";
  const zip = await zipOf(md, { markup: true });
  const doc = await zip.file("word/document.xml")!.async("string");
  const comments = await zip.file("word/comments.xml")!.async("string");
  assert.match(comments, /tjek prisen/);
  assert.match(comments, /en note for sig/);
  assert.equal((doc.match(/<w:commentReference /g) ?? []).length, 2);
  assert.match(doc, /<w:del [^>]*>[\s\S]*?<w:delText[^>]*>dyrt<\/w:delText>/);
  assert.match(doc, /<w:ins [^>]*>[\s\S]*?<w:t[^>]*>billigt<\/w:t>/);
  assert.match(doc, /<w:ins [^>]*>[\s\S]*?<w:t[^>]*>helt<\/w:t>/);
  assert.doesNotMatch(doc, /[\uE000-\uE006]/, "mærkerne må ikke stå i dokumentet");
});

test("Word uden noter og forslag: den rene udgave med den oprindelige tekst", async () => {
  const md = "Prisen var 5 kroner.<!-- tjek prisen -->\n\nDet var {~~dyrt~>billigt~~} og {++helt++} fint.\n";
  const zip = await zipOf(md, { markup: false });
  const doc = await zip.file("word/document.xml")!.async("string");
  assert.equal(zip.file("word/comments.xml"), null);
  assert.doesNotMatch(doc, /<w:ins |<w:del |tjek prisen|billigt|helt/);
  assert.match(doc, /dyrt/);
});

test("Word følger side-designeren: tabulatorstop, første side for sig, margener og titel", async () => {
  const md = "# Havnebadet\n\nTekst.";
  const layout = {
    ...defaultLayout("manuskript"),
    margins: { top: 3, right: 3, bottom: 2.5, left: 3 },
    title: false,
    pages: { "top-left": [{ kind: "author" as const }], "top-right": [{ kind: "date" as const }], "bottom-right": [{ kind: "pageNumber" as const }] },
    first: { "bottom-center": [{ kind: "text" as const, text: "Til redaktionen" }] },
  };
  const zip = await JSZip.loadAsync(await wordDocument(md, metaFor(md, "x.md", "Kim Skribent", new Date(2026, 9, 9)), { includeDimmed: false, layout }));
  const doc = await zip.file("word/document.xml")!.async("string");
  // 3 cm = 1.701 twips. Tekstbredden er 11.906 − 2 × 1.701 = 8.504: midten 4.252, højre 8.504.
  assert.match(doc, /w:left="1701"/);
  assert.doesNotMatch(doc, /Havnebadet/, "titlen er slået fra");
  const files = Object.keys(zip.files);
  const read = (re: RegExp) => Promise.all(files.filter((f) => re.test(f)).map((f) => zip.file(f)!.async("string")));
  const headers = await read(/^word\/header\d+\.xml$/);
  const footers = await read(/^word\/footer\d+\.xml$/);
  const head = headers.find((x) => x.includes("Kim Skribent"));
  assert.ok(head);
  assert.match(head, /<w:tab w:val="center" w:pos="4252"\/>/);
  assert.match(head, /<w:tab w:val="right" w:pos="8504"\/>/);
  assert.match(head, /Kim Skribent<\/w:t>[\s\S]*<w:tab\/>[\s\S]*<w:tab\/>[\s\S]*9\. oktober 2026/);
  assert.ok(footers.some((x) => x.includes("Til redaktionen") && /w:jc w:val="center"/.test(x)), "første side: centreret som før");
  assert.ok(footers.some((x) => /PAGE/.test(x) && /w:val="right"/.test(x)), "de andre sider: sidetal til højre");
});

test("Word: designerens skrift afløser skabelonens", async () => {
  const styles = await part("Tekst.", "word/styles.xml", { template: "laeseudgave", layout: { ...defaultLayout("laeseudgave"), font: "grotesk" } });
  assert.match(styles, /w:ascii="Calibri"/);
  const same = await part("Tekst.", "word/styles.xml", { template: "laeseudgave", layout: defaultLayout("laeseudgave") });
  assert.match(same, /w:ascii="Georgia"/);
});
