import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, expandTemplate, FIELD_NAMES, formatDate, formatNumber, isoWeek, validateTemplate } from "./fields.ts";
import type { FieldContext } from "./types.ts";

// Mandag 5. oktober 2026 kl. 14.32, lokal tid.
const ctx = (over: Partial<FieldContext> = {}): FieldContext => ({
  now: new Date(2026, 9, 5, 14, 32),
  lang: "da",
  name: "Kim Skribent",
  filename: "ARTIKEL",
  title: "En rubrik",
  selection: "",
  words: 1180,
  characters: 7412,
  readingMinutes: 5.4,
  ...over,
});
const da = (body: string, over: Partial<FieldContext> = {}) => expandTemplate(body, ctx(over)).text;
const en = (body: string, over: Partial<FieldContext> = {}) => expandTemplate(body, ctx({ lang: "en", ...over })).text;

test("/dato: dagens dato på dansk og engelsk, med begge sprogs feltnavne", () => {
  assert.equal(da("{{dato}}"), "5. oktober 2026");
  assert.equal(da("{{date}}"), "5. oktober 2026");
  assert.equal(en("{{dato}}"), "5 October 2026");
  assert.equal(en("{{date}}"), "5 October 2026");
});

test("datoformater: kort og iso", () => {
  assert.equal(da("{{dato:kort}}"), "5. okt. 2026");
  assert.equal(en("{{date:short}}"), "5 Oct 2026");
  assert.equal(da("{{date:short}}"), "5. okt. 2026");
  assert.equal(da("{{dato:iso}}"), "2026-10-05");
  assert.equal(en("{{dato:iso}}"), "2026-10-05");
  assert.equal(da("{{dato:lang}}"), "5. oktober 2026");
});

test("datoregning: frem, tilbage og sammen med format", () => {
  assert.equal(da("{{dato+7}}"), "12. oktober 2026");
  assert.equal(da("{{dato-3:kort}}"), "2. okt. 2026");
  assert.equal(en("{{date+7}}"), "12 October 2026");
  assert.equal(da("{{dato + 7 : iso}}"), "2026-10-12");
});

test("datoregning hen over måned, år og skuddag", () => {
  assert.equal(da("{{dato+27}}"), "1. november 2026");
  assert.equal(da("{{dato-5}}"), "30. september 2026");
  assert.equal(da("{{dato+88:iso}}"), "2027-01-01");
  assert.equal(da("{{dato:iso}}", { now: new Date(2026, 11, 31, 23, 59) }), "2026-12-31");
  assert.equal(da("{{dato+1:iso}}", { now: new Date(2026, 11, 31, 23, 59) }), "2027-01-01");
  assert.equal(da("{{dato-1:iso}}", { now: new Date(2027, 0, 1, 0, 5) }), "2026-12-31");
  assert.equal(da("{{dato+1:iso}}", { now: new Date(2028, 1, 28, 12, 0) }), "2028-02-29");
  // Sommertid slutter 25. oktober 2026: dagen må ikke blive talt to gange.
  assert.equal(da("{{dato+1:iso}}", { now: new Date(2026, 9, 24, 23, 30) }), "2026-10-25");
  assert.equal(da("{{dato+2:iso}}", { now: new Date(2026, 9, 24, 23, 30) }), "2026-10-26");
  assert.equal(addDays(new Date(2026, 2, 28, 2, 30), 1).getDate(), 29);
});

test("ugedag, uge og år følger sproget og kan regnes med", () => {
  assert.equal(da("{{ugedag}}"), "mandag");
  assert.equal(en("{{weekday}}"), "Monday");
  assert.equal(da("{{ugedag+1}}"), "tirsdag");
  assert.equal(da("{{uge}}"), "41");
  assert.equal(en("{{week}}"), "41");
  assert.equal(da("{{år}}"), "2026");
  assert.equal(en("{{year}}"), "2026");
  assert.equal(da("{{år+100}}"), "2027");
});

test("ISO-uge: uge 1 og uge 53 ved årsskiftet", () => {
  assert.equal(isoWeek(new Date(2026, 9, 5)), 41);
  assert.equal(isoWeek(new Date(2026, 0, 1)), 1, "torsdag 1/1-2026 er uge 1");
  assert.equal(isoWeek(new Date(2026, 11, 31)), 53, "2026 har 53 uger");
  assert.equal(isoWeek(new Date(2027, 0, 1)), 53, "fredag 1/1-2027 hører til uge 53 i 2026");
  assert.equal(isoWeek(new Date(2027, 0, 4)), 1);
  assert.equal(isoWeek(new Date(2024, 11, 30)), 1, "mandag 30/12-2024 er uge 1 i 2025");
  assert.equal(isoWeek(new Date(2021, 0, 3)), 53, "søndag 3/1-2021 er uge 53 i 2020");
  assert.equal(isoWeek(new Date(2025, 11, 28)), 52);
});

test("klokkeslæt: punktum på dansk, kolon på engelsk, altid 24 timer", () => {
  assert.equal(da("{{tid}}"), "14.32");
  assert.equal(en("{{time}}"), "14:32");
  assert.equal(da("{{tid}}", { now: new Date(2026, 9, 5, 7, 5) }), "07.05");
  assert.equal(da("{{dato}} kl. {{tid}}"), "5. oktober 2026 kl. 14.32");
  assert.equal(en("{{date}}, {{time}}"), "5 October 2026, 14:32");
});

test("tal om teksten: tusindtal efter sproget", () => {
  assert.equal(da("{{ord}}"), "1.180");
  assert.equal(en("{{words}}"), "1,180");
  assert.equal(da("{{anslag}}"), "7.412");
  assert.equal(en("{{characters}}"), "7,412");
  assert.equal(da("{{læsetid}}"), "5");
  assert.equal(da("{{readingtime}}", { readingMinutes: 0.2 }), "1");
  assert.equal(formatNumber(1234567, "da"), "1.234.567");
  assert.equal(formatNumber(999, "en"), "999");
  assert.equal(formatNumber(1000, "en"), "1,000");
});

test("navn, filnavn, titel og markering", () => {
  assert.equal(da("Af {{navn}}"), "Af Kim Skribent");
  assert.equal(en("By {{name}}"), "By Kim Skribent");
  assert.equal(da("{{filnavn}} / {{titel}}"), "ARTIKEL / En rubrik");
  assert.equal(da("»{{markering}}«", { selection: "det markerede" }), "»det markerede«");
  assert.equal(da("»{{selection}}«"), "»«");
});

test("feltnavne er ligeglade med store bogstaver og luft", () => {
  assert.equal(da("{{ Dato }}"), "5. oktober 2026");
  assert.equal(da("{{ÅR}}"), "2026");
});

test("det markerede læses aldrig som felter", () => {
  assert.equal(da("{{markering}}", { selection: "{{dato}} og {{ukendt}}" }), "{{dato}} og {{ukendt}}");
  assert.equal(da("{{navn}}", { name: "{{tid}}" }), "{{tid}}");
});

test("markørstop: nummer, standardtekst og positioner", () => {
  const r = expandTemplate("# {{1:Rubrik}}\n\n{{2:Manchet}}", ctx());
  assert.equal(r.text, "# Rubrik\n\nManchet");
  assert.deepEqual(r.stops, [
    { index: 1, from: 2, to: 8 },
    { index: 2, from: 10, to: 17 },
  ]);
  assert.equal(r.cursor, null);
  for (const s of r.stops) assert.ok(r.text.slice(s.from, s.to).length > 0);
});

test("samme nummer er samme stop: hver forekomst meldes med samme index", () => {
  const r = expandTemplate("{{1:navn}} sagde, at {{1:navn}} ville. {{2:mere}} {{1}}", ctx());
  assert.equal(r.text, "navn sagde, at navn ville. mere navn");
  assert.deepEqual(
    r.stops.map((s) => s.index),
    [1, 1, 2, 1],
  );
  assert.deepEqual(
    r.stops.filter((s) => s.index === 1).map((s) => r.text.slice(s.from, s.to)),
    ["navn", "navn", "navn"],
  );
});

test("stop uden tekst er et tomt stop, og stop efter et felt står rigtigt", () => {
  const r = expandTemplate("{{dato}}: {{1}} og {{9:sidst}}", ctx());
  assert.equal(r.text, "5. oktober 2026: " + " og sidst");
  assert.deepEqual(r.stops[0], { index: 1, from: 17, to: 17 });
  assert.equal(r.text.slice(r.stops[1].from, r.stops[1].to), "sidst");
});

test("standardteksten må have kolon og tegn i sig", () => {
  const r = expandTemplate("{{2:Manchet: hvad er nyt, og hvorfor?}}", ctx());
  assert.equal(r.text, "Manchet: hvad er nyt, og hvorfor?");
  assert.equal(expandTemplate("{{5:fx reportage, 6.000 anslag}}", ctx()).text, "fx reportage, 6.000 anslag");
});

test("{{markør}} og {{cursor}}: her ender markøren", () => {
  const r = expandTemplate("## Noter\n\n{{markør}}\n\nSlut", ctx());
  assert.equal(r.text, "## Noter\n\n\n\nSlut");
  assert.equal(r.cursor, 10);
  assert.equal(expandTemplate("- {{cursor}}", ctx({ lang: "en" })).cursor, 2);
});

test("omvendt skråstreg giver to bogstavelige klammer", () => {
  assert.equal(da("Skriv \\{{dato}} for at få {{dato:iso}}"), "Skriv {{dato}} for at få 2026-10-05");
  assert.deepEqual(validateTemplate("\\{{hvad som helst"), []);
  assert.deepEqual(validateTemplate("\\{{ukendt}}"), []);
});

test("et ukendt felt er en fejl med linjenummer", () => {
  const errors = validateTemplate("Linje et\n{{dato}}\nHer er {{udklip}} og {{dato:pæn}}\n{{uge:kort}}");
  assert.deepEqual(
    errors.map((e) => e.line),
    [3, 3, 4],
  );
  assert.match(errors[0].message, /\{\{udklip\}\}/);
  assert.equal(validateTemplate("{{0:nul}}").length, 1, "stop går fra 1 til 9");
  assert.equal(validateTemplate("{{10:ti}}").length, 1);
  assert.equal(validateTemplate("{{dato+}}").length, 1);
  assert.equal(validateTemplate("{{}}").length, 1);
  assert.equal(validateTemplate("{{vælg:a|b}}").length, 1, "valglister er til senere");
});

test("et felt uden afslutning er en fejl, også når klammerne først lukkes på næste linje", () => {
  assert.equal(validateTemplate("Her {{dato").length, 1);
  const errors = validateTemplate("ok\n{{1:tekst\n}}");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 2);
});

test("højst én markør", () => {
  const errors = validateTemplate("{{markør}}\n{{cursor}}");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 2);
});

test("en ugyldig skabelon udfoldes ikke halvt: der kastes en fejl", () => {
  assert.throws(() => expandTemplate("{{dato}} og {{ukendt}}", ctx()), /ukendt/);
});

test("CRLF i skabelonen bliver til almindelige linjeskift", () => {
  const r = expandTemplate("A\r\n{{1:b}}\r\nC", ctx());
  assert.equal(r.text, "A\nb\nC");
  assert.deepEqual(r.stops, [{ index: 1, from: 2, to: 3 }]);
  assert.equal(validateTemplate("A\r\n{{nej}}")[0].line, 2);
});

test("hvert felt i listen til formularen er gyldigt på begge sprog", () => {
  for (const f of FIELD_NAMES) {
    assert.deepEqual(validateTemplate(`{{${f.da}}}`), [], f.da);
    assert.deepEqual(validateTemplate(`{{${f.en}}}`), [], f.en);
    if (!f.da.startsWith("1:")) assert.equal(da(`{{${f.da}}}`), da(`{{${f.en}}}`), `${f.da} og ${f.en} er samme felt`);
  }
  assert.equal(formatDate(new Date(2026, 4, 1), "short", "da"), "1. maj 2026");
  assert.equal(formatDate(new Date(2026, 8, 1), "short", "da"), "1. sept. 2026");
});
