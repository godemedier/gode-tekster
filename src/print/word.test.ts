import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { wordDocument } from "./word.ts";
import { metaFor } from "./render.ts";

const bodyXml = async (md: string, book: boolean) => {
  const bytes = await wordDocument(md, metaFor(md, "x.md", ""), false, book);
  return (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
};

test("bogafsnit i Word: indryk kun på afsnit efter afsnit, ingen luft", async () => {
  const xml = await bodyXml("# Titel\n\nFørste afsnit.\n\nAndet afsnit.\n\n- punkt\n\nEfter listen.", true);
  assert.equal((xml.match(/w:firstLine="425"/g) ?? []).length, 1, "kun »Andet afsnit« rykkes ind");
  const andet = xml.slice(0, xml.indexOf("Andet afsnit"));
  assert.match(andet.slice(andet.lastIndexOf("<w:p>")), /w:firstLine="425"/);
});

test("luft imellem (standard): intet indryk", async () => {
  const xml = await bodyXml("Første.\n\nAndet.", false);
  assert.doesNotMatch(xml, /w:firstLine/);
});

test("en ekstra tom linje giver luft i Word, og næste afsnit står ude", async () => {
  const xml = await bodyXml("Første.\n\nAndet.\n\n\nTredje.\n\nFjerde.", true);
  assert.equal((xml.match(/w:firstLine="425"/g) ?? []).length, 2, "Andet og Fjerde, ikke Tredje");
  assert.doesNotMatch(xml, /⁣/, "mærket må ikke stå i dokumentet");
});

test("Word: bogstavliste og valgt punkttegn", async () => {
  const bytes = await wordDocument("a. Et\nb. To\n\n- punkt", metaFor("x", "x.md", ""), false, false, "–");
  const zip = await JSZip.loadAsync(bytes);
  const numbering = await zip.file("word/numbering.xml")!.async("string");
  assert.match(numbering, /w:numFmt w:val="lowerLetter"/);
  assert.match(numbering, /w:lvlText w:val="–"/);
});
