import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { wordDocument, wordFont, type WordOptions } from "./word.ts";
import { metaFor } from "./render.ts";

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
