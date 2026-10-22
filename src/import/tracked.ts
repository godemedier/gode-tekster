// Redaktørens Word-rettelser (valgt efter research 2/10). mammoth godtager sporede ændringer uden
// at vise dem og taber kommentarerne. Her laves to udgaver af Word-filen: én med alle ændringer
// afvist (teksten, som redaktøren fik den) og én med alle godtaget. Forskellen mellem de to bliver
// til rettelser i CriticMarkup (editor/critic.ts), som brugeren godtager eller afviser ét ad gangen.
// Kommentarerne bliver til noter <!-- Navn: tekst -->, dér hvor de står.
//
// Word-XML'en ændres med regulære udtryk. Den er regelmæssig nok til det: w:ins og w:del ligger
// ikke inden i hinanden, og et w:del-mærke uden indhold markerer kun et slettet afsnitsskift.

import JSZip from "jszip";

export type Comment = { author: string; text: string };
export type Tracked = { changes: number; comments: Map<string, Comment> };

const marker = (id: string) => `⟦GTK${id}⟧`;

/** Alle ændringer afvist: indsat tekst væk, slettet tekst tilbage. */
export function rejectXml(xml: string): string {
  return xml
    .replace(/<w:(ins|del)\b[^>]*\/>/g, "")
    .replace(/<w:ins\b[^>]*>[\s\S]*?<\/w:ins>/g, "")
    .replace(/<w:moveTo\b[^>]*>[\s\S]*?<\/w:moveTo>/g, "")
    .replace(/<w:del\b[^>]*>([\s\S]*?)<\/w:del>/g, "$1")
    .replace(/<w:moveFrom\b[^>]*>([\s\S]*?)<\/w:moveFrom>/g, "$1")
    .replace(/<w:delText\b([^>]*)>/g, "<w:t$1>")
    .replace(/<\/w:delText>/g, "</w:t>");
}

/** Alle ændringer godtaget: slettet tekst væk, indsat tekst bliver. */
export function acceptXml(xml: string): string {
  return xml
    .replace(/<w:(ins|del)\b[^>]*\/>/g, "")
    .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, "")
    .replace(/<w:moveFrom\b[^>]*>[\s\S]*?<\/w:moveFrom>/g, "")
    .replace(/<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>/g, "$1")
    .replace(/<w:moveTo\b[^>]*>([\s\S]*?)<\/w:moveTo>/g, "$1");
}

/** Et mærke efter hver kommentars slutning, så noten kan sættes ind dér bagefter. */
export function markComments(xml: string): string {
  return xml.replace(/<w:commentRangeEnd w:id="(\d+)"\s*\/>/g, (m, id: string) => `${m}<w:r><w:t xml:space="preserve">${marker(id)}</w:t></w:r>`);
}

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function readComments(xml: string): Map<string, Comment> {
  const out = new Map<string, Comment>();
  for (const m of xml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const id = /w:id="(\d+)"/.exec(m[1])?.[1];
    if (!id) continue;
    const author = decode(/w:author="([^"]*)"/.exec(m[1])?.[1] ?? "");
    const paragraphs = [...m[2].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => [...p[0].matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map((t) => decode(t[1])).join(""));
    out.set(id, { author, text: paragraphs.join(" ").trim() });
  }
  return out;
}

/** Hvor mange sporede ændringer og kommentarer Word-filen har (0 og 0 = en almindelig fil). */
export async function inspect(bytes: ArrayBuffer): Promise<Tracked> {
  const zip = await JSZip.loadAsync(bytes);
  const doc = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const comments = readComments((await zip.file("word/comments.xml")?.async("string")) ?? "");
  const changes = (doc.match(/<w:(ins|del|moveFrom|moveTo)\b[^>]*>(?!\s*<\/)/g) ?? []).filter((t) => !t.endsWith("/>")).length;
  return { changes, comments };
}

/** De to udgaver af Word-filen, begge med kommentarmærker. */
export async function versions(bytes: ArrayBuffer): Promise<{ rejected: ArrayBuffer; accepted: ArrayBuffer }> {
  const make = async (transform: (xml: string) => string) => {
    const zip = await JSZip.loadAsync(bytes);
    const doc = (await zip.file("word/document.xml")?.async("string")) ?? "";
    zip.file("word/document.xml", markComments(transform(doc)));
    return zip.generateAsync({ type: "arraybuffer" });
  };
  return { rejected: await make(rejectXml), accepted: await make(acceptXml) };
}

/** Sæt kommentarerne ind som noter, dér hvor deres mærker står. Ukendte mærker fjernes. */
export function placeComments(md: string, comments: Map<string, Comment>): string {
  return md.replace(/⟦GTK(\d+)⟧/g, (_m, id: string) => {
    const c = comments.get(id);
    if (!c?.text) return "";
    return ` <!-- ${c.author ? `${c.author}: ` : ""}${c.text.replace(/-->/g, "-- >")} -->`;
  });
}
