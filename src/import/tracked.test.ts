import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptXml, markComments, placeComments, readComments, rejectXml } from "./tracked.ts";

const xml =
  '<w:p><w:r><w:t>Prisen var </w:t></w:r>' +
  '<w:del w:id="1" w:author="Red"><w:r><w:delText>5</w:delText></w:r></w:del>' +
  '<w:ins w:id="2" w:author="Red"><w:r><w:t>6</w:t></w:r></w:ins>' +
  '<w:r><w:t> mia.</w:t></w:r><w:commentRangeEnd w:id="7"/></w:p>' +
  '<w:p><w:pPr><w:rPr><w:ins w:id="3" w:author="Red"/></w:rPr></w:pPr><w:r><w:t>Slut.</w:t></w:r></w:p>';

const text = (x: string) => [...x.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");

test("afvist: teksten, som redaktøren fik den", () => {
  assert.equal(text(rejectXml(xml)), "Prisen var 5 mia.Slut.");
});

test("godtaget: med redaktørens ændringer", () => {
  assert.equal(text(acceptXml(xml)), "Prisen var 6 mia.Slut.");
});

test("kommentarer bliver noter, dér hvor de står", () => {
  const marked = text(markComments(rejectXml(xml)));
  assert.equal(marked, "Prisen var 5 mia.⟦GTK7⟧Slut.");
  const comments = readComments('<w:comments><w:comment w:id="7" w:author="Anne &amp; Bo"><w:p><w:r><w:t>Kilde?</w:t></w:r></w:p></w:comment></w:comments>');
  assert.equal(placeComments("Prisen var 5 mia.⟦GTK7⟧", comments), "Prisen var 5 mia. <!-- Anne & Bo: Kilde? -->");
});

test("ende til ende: en Word-fil med en sporet ændring og en kommentar", async () => {
  const JSZip = (await import("jszip")).default;
  const { wordDocument } = await import("../print/word.ts");
  const { metaFor } = await import("../print/render.ts");
  const { docxToMarkdown } = await import("./docx.ts");
  const { inspect, versions, placeComments } = await import("./tracked.ts");
  const md = "Prisen var 5 milliarder kroner.\n";
  const made = await wordDocument(md, metaFor(md, "x.md", "Kim Skribent"), false);
  const zip = await JSZip.loadAsync(made);
  let doc = await zip.file("word/document.xml")!.async("string");
  // Redaktøren retter 5 til 6 og skriver en kommentar efter »kroner.«.
  doc = doc.replace(
    "Prisen var 5 milliarder kroner.",
    'Prisen var </w:t></w:r><w:del w:id="1" w:author="Red"><w:r><w:delText>5</w:delText></w:r></w:del><w:ins w:id="2" w:author="Red"><w:r><w:t>6</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> milliarder kroner.</w:t></w:r><w:commentRangeEnd w:id="9"/><w:r><w:t xml:space="preserve">',
  );
  zip.file("word/document.xml", doc);
  zip.file("word/comments.xml", '<w:comments><w:comment w:id="9" w:author="Red"><w:p><w:r><w:t>Kilde?</w:t></w:r></w:p></w:comment></w:comments>');
  const bytes = await zip.generateAsync({ type: "arraybuffer" });
  const t = await inspect(bytes);
  assert.equal(t.changes, 2);
  assert.equal(t.comments.size, 1);
  const v = await versions(bytes);
  const before = placeComments((await docxToMarkdown(v.rejected)).markdown, t.comments);
  const after = placeComments((await docxToMarkdown(v.accepted)).markdown, t.comments);
  assert.match(before, /Prisen var 5 milliarder kroner\. <!-- Red: Kilde\? -->/);
  assert.match(after, /Prisen var 6 milliarder kroner\./);
});
