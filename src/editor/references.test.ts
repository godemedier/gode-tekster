import { test } from "node:test";
import assert from "node:assert/strict";

import {
  citationCounts,
  citationsIn,
  findCitations,
  findReferences,
  formatter,
  newReferenceId,
  REFERENCE_MARK,
  removeReference,
  referenceFromFootnote,
  resolveCitations,
  setReferences,
  upsertReference,
  type Reference,
} from "./references.ts";
import { withoutParked } from "./parked.ts";

function apply(doc: string, c: { from: number; to?: number; insert: string } | null): string {
  assert.ok(c);
  return doc.slice(0, c.from) + c.insert + doc.slice(c.to ?? c.from);
}

const hansen: Reference = {
  id: "hansen2024",
  type: "book",
  author: [{ family: "Hansen", given: "Jens Peter" }],
  issued: { "date-parts": [[2024]] },
  title: "Godt sprog i praksis",
  publisher: "Gyldendal",
  edition: "2",
};
const nielsen: Reference = {
  id: "nielsen2023",
  type: "article-journal",
  author: [{ family: "Nielsen", given: "Mette" }, { family: "Berg", given: "Karl-Erik" }],
  issued: { "date-parts": [[2023, 4]] },
  title: "Klarhed i forvaltningen",
  "container-title": "Nordisk Sprogjournal",
  volume: "14",
  issue: "2",
  page: "45-62",
  DOI: "10.1234/nsj.2023.14.45",
};

test("kilderne gemmes i filen og kan læses igen, også med farlige tegn i titlen", () => {
  const original = "# Tekst\n\nBrødtekst [@hansen2024].\n";
  const tricky: Reference = { ...nielsen, id: "x", title: "Slut --> og <!-- start --!> & æøå" };
  let doc = apply(original, upsertReference(original, hansen));
  doc = apply(doc, upsertReference(doc, tricky));
  assert.match(doc, /\n\n<!-- gt:kilder\n\[\n\{"id":"hansen2024"/);
  // Kun én kommentar: titlen kan ikke lukke blokken.
  assert.equal(doc.split("-->").length - 1, 1);
  const refs = findReferences(doc)?.refs ?? [];
  assert.deepEqual(refs.map((r) => r.id), ["hansen2024", "x"]);
  assert.equal(refs[1].title, tricky.title);
  assert.equal(withoutParked(doc).trimEnd(), original.trimEnd());
  // Ret på stedet, og slet til sidst den sidste kilde: blokken forsvinder helt.
  doc = apply(doc, upsertReference(doc, { ...hansen, title: "Ny titel" }));
  assert.equal(findReferences(doc)?.refs[0].title, "Ny titel");
  doc = apply(doc, removeReference(doc, "x"));
  doc = apply(doc, removeReference(doc, "hansen2024"));
  assert.equal(doc, original);
});

test("en beskadiget blok røres ikke", () => {
  const doc = "Tekst\n\n<!-- gt:kilder\n[{\"id\": \n-->\n";
  assert.equal(findReferences(doc)?.broken, true);
  assert.equal(setReferences(doc, [hansen]), null);
  assert.equal(upsertReference(doc, hansen), null);
});

test("fremmede felter og ugyldige id'er", () => {
  const doc = '<!-- gt:kilder\n[\n{"id":"a","type":"book","note":"behold"},\n{"id":"a","type":"book"},\n{"id":"","type":"book"},\n{"type":"book"},\n{"id":"b"}\n]\n-->\n';
  const refs = findReferences(doc)?.refs ?? [];
  assert.deepEqual(refs.map((r) => r.id), ["a", "b"]);
  assert.equal(refs[0].note, "behold");
  assert.equal(refs[1].type, "book");
});

test("henvisninger efter Pandocs syntaks", () => {
  const text = "Se [@hansen2024, s. 42] og [jf. @hansen2024; -@nielsen2023, kap. 2]. Ikke [mail a@b.dk], [link @x](https://e.dk), [^1] eller [@x]: def.";
  const cites = findCitations(text);
  assert.equal(cites.length, 2);
  assert.deepEqual(cites[0].items, [{ id: "hansen2024", prefix: "", locator: "s. 42", suppressAuthor: false }]);
  assert.deepEqual(cites[1].items, [
    { id: "hansen2024", prefix: "jf.", locator: "", suppressAuthor: false },
    { id: "nielsen2023", prefix: "", locator: "kap. 2", suppressAuthor: true },
  ]);
  assert.equal(text.slice(cites[0].from, cites[0].to), "[@hansen2024, s. 42]");
  // Nøgler med tegnsætning indeni, men ikke til sidst.
  assert.equal(findCitations("[@doe:2020.]")[0].items[0].id, "doe:2020");
});

test("henvisninger i kode og kommentarer tæller ikke", () => {
  const doc = "A [@a] `[@b]` <!-- [@c] -->\n\n```\n[@d]\n```\n[@a; @e]\n";
  assert.deepEqual(citationsIn(doc).map((c) => c.items.map((i) => i.id).join()), ["a", "a,e"]);
  assert.deepEqual([...citationCounts(doc)], [["a", 2], ["e", 1]]);
});

test("APA 7 i teksten", () => {
  const third: Reference = { id: "t", type: "report", author: [{ family: "A" }, { family: "B" }, { family: "C" }], title: "R" };
  const org: Reference = { id: "o", type: "report", author: [{ literal: "Dansk Sprognævn" }], issued: { "date-parts": [[2022]] }, title: "Retskrivning" };
  const f = formatter([hansen, nielsen, third, org], "da");
  const cite = (s: string) => f.cite(findCitations(s)[0]);
  assert.equal(cite("[@hansen2024, s. 42]"), "(Hansen, 2024, s. 42)");
  assert.equal(cite("[@nielsen2023]"), "(Nielsen & Berg, 2023)");
  assert.equal(cite("[@t]"), "(A et al., u.å.)");
  assert.equal(cite("[jf. @o; -@hansen2024]"), "(jf. Dansk Sprognævn, 2022; 2024)");
  assert.equal(cite("[@ukendt]"), null);
  assert.equal(formatter([third], "en").cite(findCitations("[@t]")[0]), "(A et al., n.d.)");
});

test("APA 7 i litteraturlisten", () => {
  const f = formatter([hansen, nielsen], "da");
  assert.equal(f.entry(hansen), "Hansen, J. P. (2024). *Godt sprog i praksis* (2. udg.). Gyldendal.");
  assert.equal(
    f.entry(nielsen),
    "Nielsen, M., & Berg, K.-E. (2023). Klarhed i forvaltningen. *Nordisk Sprogjournal*, *14*(2), 45–62. https://doi.org/10.1234/nsj.2023.14.45",
  );
  const web: Reference = { id: "w", type: "webpage", author: [{ literal: "Dansk Sprognævn" }], issued: { "date-parts": [[2024, 3, 5]] }, title: "Komma?", publisher: "dsn.dk", URL: "https://dsn.dk/komma" };
  assert.equal(f.entry(web), "Dansk Sprognævn. (2024, 5. marts). *Komma?* dsn.dk. https://dsn.dk/komma");
  const chapter: Reference = { id: "c", type: "chapter", author: [{ family: "Holm", given: "Lis" }], editor: [{ family: "Lund", given: "Ib" }], issued: { "date-parts": [[2020]] }, title: "Et kapitel", "container-title": "En bog", page: "1-20", publisher: "Forlaget" };
  assert.equal(f.entry(chapter), "Holm, L. (2020). Et kapitel. I I. Lund (Red.), *En bog* (s. 1–20). Forlaget.");
  const untitled: Reference = { id: "u", type: "book", title: "Uden *forfatter*", issued: { "date-parts": [[2019]] } };
  assert.equal(f.entry(untitled), "*Uden \\*forfatter\\**. (2019).");
});

test("samme forfatter samme år får a og b", () => {
  const a: Reference = { ...hansen, id: "h1", title: "Anden bog" };
  const b: Reference = { ...hansen, id: "h2", title: "Bog" };
  const f = formatter([b, a], "da");
  assert.equal(f.cite(findCitations("[@h2; @h1]")[0]), "(Hansen, 2024b; Hansen, 2024a)");
  assert.deepEqual(f.sorted([b, a]).map((r) => r.id), ["h1", "h2"]);
});

test("print og Word får formaterede henvisninger og kun de brugte kilder", () => {
  let doc = "Først [@nielsen2023, s. 3]. Så [@hansen2024]. Ukendt [@ingen].\n";
  doc = apply(doc, setReferences(doc, [hansen, nielsen, { ...hansen, id: "ubrugt", author: [{ family: "Aabye" }] }]));
  const out = resolveCitations(doc, withoutParked(doc), "da");
  assert.match(out, /^Først \(Nielsen & Berg, 2023, s\. 3\)\. Så \(Hansen, 2024\)\. Ukendt \[@ingen\]\./);
  assert.match(out, /\n\n## Litteratur\n\n/);
  const entries = out.split("## Litteratur\n\n")[1].trim().split("\n\n");
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.startsWith(REFERENCE_MARK)));
  assert.match(entries[0], /Hansen/);
  // Uden kilder i filen er teksten urørt.
  assert.equal(resolveCitations("A [@x].", "A [@x]."), "A [@x].");
});

test("nye id'er af efternavn og år", () => {
  assert.equal(newReferenceId({ author: [{ family: "Ærø Sørensen" }], issued: { "date-parts": [[2021]] } }, []), "aeroe2021");
  assert.equal(newReferenceId(hansen, ["hansen2024"]), "hansen2024b");
  assert.equal(newReferenceId({ title: "Rapport om klima" }, []), "rapport");
  assert.equal(newReferenceId({}, ["kilde"]), "kildeb");
});

test("henvisninger som fodnoter: hver bliver en fodnote med hele kilden, også med side", () => {
  let doc = "Først [@nielsen2023, s. 3]. Så [@hansen2024].\n\n[^1]: Se også [@hansen2024].\n";
  doc = apply(doc, setReferences(doc, [hansen, nielsen]));
  const out = resolveCitations(doc, withoutParked(doc), "da", "fodnoter");
  assert.match(out, /^Først \[\^gt-kilde-1\]\. Så \[\^gt-kilde-2\]\./);
  assert.match(out, /\n\[\^gt-kilde-1\]: Nielsen[^\n]*, s\. 3\.\n/);
  assert.match(out, /\n\[\^gt-kilde-2\]: Hansen[^\n]*\.\n/);
  // I en fodnote står kilden i noten selv, ikke som en fodnote i fodnoten.
  assert.match(out, /\[\^1\]: Se også Hansen[^\n]*[^.]\.\n/);
  assert.match(out, /## Litteratur/);
});

test("en kilde ud fra en fodnote: titel, adresse uden citathop og udgiveren foran kolonet", () => {
  assert.deepEqual(referenceFromFootnote("DR: [Rapporten om ordningen](https://dr.dk/a#:~:text=x%20y) (hentet 21/10)"), { id: "", type: "webpage", title: "Rapporten om ordningen", URL: "https://dr.dk/a", publisher: "DR" });
  assert.deepEqual(referenceFromFootnote("Beretning fra Rigsrevisionen https://rr.dk/b."), { id: "", type: "webpage", title: "Beretning fra Rigsrevisionen", URL: "https://rr.dk/b" });
});
