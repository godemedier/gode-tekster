import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSelection, EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";

import { hiddenBlocks } from "../editor/hidden.ts";
import { EMPTY_TABLE, planCommand, readableSlice, stopField, tabStops, visibleSegments, type Plan } from "./run.ts";
import type { Command, Kind } from "./types.ts";

const file = { name: "Kim", filename: "ARTIKEL", title: "Broen" };
const now = new Date(2026, 9, 5, 14, 32);

const cmd = (kind: Kind, body: string, extra: Partial<Command> = {}): Command => ({
  name: "prøve",
  kind,
  description: "En prøve",
  aliases: [],
  scope: "selection",
  newfile: false,
  body,
  source: "user",
  ...(kind === "ai" ? { output: "findings" as const } : {}),
  ...extra,
});

const parked = "<!-- gt:parkeret id=p1 dato=2026-10-05\nEt klip med ordet afsnit.\n-->";

function state(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [hiddenBlocks, tabStops(), history()] });
}

/** Planen udført: den nye tilstand og teksten. */
function run(s: EditorState, plan: Plan): EditorState {
  assert.ok(plan.spec, plan.notice ?? "planen ændrer intet");
  return s.update(plan.spec).state;
}

/** En tilstand, hvor »/navn« lige er skrevet sidst i `before`. */
function typed(before: string, after = ""): { s: EditorState; replace: { from: number; to: number } } {
  const typedText = "/prøve";
  const doc = before + typedText + after;
  return { s: state(doc, before.length + typedText.length), replace: { from: before.length, to: before.length + typedText.length } };
}

// --- skabeloner ------------------------------------------------------------------------------------------

test("en skabelon erstatter det skrevne i én transaktion, og ét fortryd bringer det tilbage", () => {
  const { s, replace } = typed("Skrevet ", "\n");
  const plan = planCommand(s, cmd("template", "{{dato:iso}}"), file, replace, now);
  assert.equal(plan.ran, true);
  let after = run(s, plan);
  assert.equal(after.doc.toString(), "Skrevet 2026-10-05\n");
  assert.equal(after.selection.main.head, "Skrevet 2026-10-05".length);
  // Ét Ctrl+Z: både datoen og fjernelsen af »/prøve« går tilbage.
  undo({ state: after, dispatch: (tr) => (after = tr.state) });
  assert.equal(after.doc.toString(), "Skrevet /prøve\n");
});

test("felterne får navn, filnavn, titel og tal uden det skrevne »/navn«", () => {
  const { s, replace } = typed("Et to tre. ");
  const after = run(s, planCommand(s, cmd("template", "{{navn}} {{filnavn}} {{titel}} {{ord}}"), file, replace, now));
  assert.equal(after.doc.toString(), "Et to tre. Kim ARTIKEL Broen 3");
});

test("markørstop: det første er markeret, og `{{markør}}` er slutstedet", () => {
  const { s, replace } = typed("");
  const plan = planCommand(s, cmd("template", "# {{1:Rubrik}}\n\n{{2:Manchet}}\n\n{{markør}}Slut"), file, replace, now);
  const after = run(s, plan);
  assert.equal(after.doc.toString(), "# Rubrik\n\nManchet\n\nSlut");
  assert.deepEqual([after.selection.main.from, after.selection.main.to], [2, 8]);
  const stops = after.field(stopField);
  assert.ok(stops);
  assert.equal(stops.end, "# Rubrik\n\nManchet\n\n".length);
  assert.deepEqual(
    stops.ranges.map((r) => after.sliceDoc(r.from, r.to)),
    ["Rubrik", "Manchet"],
  );
});

test("samme nummer udfyldes samlet, og stoppene følger med teksten", () => {
  const { s, replace } = typed("");
  let after = run(s, planCommand(s, cmd("template", "{{1:navn}} siger. {{2:titel}}. Mere om {{1}}."), file, replace, now));
  assert.equal(after.doc.toString(), "navn siger. titel. Mere om navn.");
  // Skriv oven i det markerede første stop, et tegn ad gangen.
  const sel = after.selection.main;
  after = after.update({ changes: { from: sel.from, to: sel.to, insert: "A" }, selection: { anchor: sel.from + 1 }, userEvent: "input.type" }).state;
  after = after.update({ changes: { from: 1, insert: "b" }, selection: { anchor: 2 }, userEvent: "input.type" }).state;
  assert.equal(after.doc.toString(), "Ab siger. titel. Mere om Ab.");
  const stops = after.field(stopField);
  assert.ok(stops);
  assert.deepEqual(
    stops.ranges.map((r) => after.sliceDoc(r.from, r.to)),
    ["Ab", "titel", "Ab"],
  );
  // Slet i stoppet: spejlet følger med.
  after = after.update({ changes: { from: 1, to: 2 }, selection: { anchor: 1 }, userEvent: "delete.backward" }).state;
  assert.equal(after.doc.toString(), "A siger. titel. Mere om A.");
});

test("stoppene slukker, når markøren forlader dem, og ved fortryd", () => {
  const { s, replace } = typed("", "\n\nEt andet afsnit.");
  const after = run(s, planCommand(s, cmd("template", "{{1:Rubrik}} og {{2:mere}}"), file, replace, now));
  assert.ok(after.field(stopField));
  assert.equal(after.update({ selection: { anchor: after.doc.length } }).state.field(stopField), null);
  let undone = after;
  undo({ state: after, dispatch: (tr) => (undone = tr.state) });
  assert.equal(undone.field(stopField), null);
  assert.equal(undone.doc.toString(), "/prøve\n\nEt andet afsnit.");
});

test("en skabelon erstatter kun markeringen, når den selv bruger den", () => {
  const doc = "Et vigtigt ord her.";
  const s = state(doc, 3, 10);
  assert.equal(run(s, planCommand(s, cmd("template", "»{{markering}}«"), file, undefined, now)).doc.toString(), "Et »vigtigt« ord her.");
  assert.equal(run(s, planCommand(s, cmd("template", " (tjek)"), file, undefined, now)).doc.toString(), "Et vigtigt (tjek) ord her.");
});

test("en skabelon med newfile sætter intet ind, men fjerner det skrevne", () => {
  const { s, replace } = typed("Tekst ");
  const plan = planCommand(s, cmd("template", "# {{1:Rubrik}}", { newfile: true }), file, replace, now);
  assert.equal(plan.newFile?.text, "# Rubrik");
  assert.equal(run(s, plan).doc.toString(), "Tekst ");
});

// --- omformninger ---------------------------------------------------------------------------------------

test("en omformning virker på markeringen og er ét fortryd-trin", () => {
  const doc = "Første afsnit.\n\nAndet afsnit.";
  const s = state(doc, 0, 6);
  let after = run(s, planCommand(s, cmd("transform", "case upper"), file));
  assert.equal(after.doc.toString(), "FØRSTE afsnit.\n\nAndet afsnit.");
  assert.deepEqual([after.selection.main.from, after.selection.main.to], [0, 6]);
  undo({ state: after, dispatch: (tr) => (after = tr.state) });
  assert.equal(after.doc.toString(), doc);
});

test("uden markering virker den på afsnittet, uden det skrevne »/navn« og uden mellemrummet foran", () => {
  const { s, replace } = typed("Første afsnit.\n\nAndet afsnit. ", "\n\nTredje.");
  const after = run(s, planCommand(s, cmd("transform", "case upper"), file, replace));
  assert.equal(after.doc.toString(), "Første afsnit.\n\nANDET AFSNIT.\n\nTredje.");
});

test("en omformning rører aldrig fraklip, heller ikke med scope: document eller Ctrl+A", () => {
  const doc = `Et afsnit.\n\nEt til.\n${parked}\n`;
  const whole = state(doc, 0);
  const viaScope = run(whole, planCommand(whole, cmd("transform", "case upper", { scope: "document" }), file));
  assert.equal(viaScope.doc.toString(), `ET AFSNIT.\n\nET TIL.\n${parked}\n`);
  const all = state(doc, 0, doc.length);
  assert.equal(run(all, planCommand(all, cmd("transform", "case upper"), file)).doc.toString(), `ET AFSNIT.\n\nET TIL.\n${parked}\n`);
});

test("afsnittet ved markøren stopper før en skjult blok", () => {
  const doc = `Sidste afsnit.\n${parked}\n`;
  const s = state(doc, 3);
  assert.equal(run(s, planCommand(s, cmd("transform", "case upper"), file)).doc.toString(), `SIDSTE AFSNIT.\n${parked}\n`);
});

test("på en tom linje sker der intet, ud over at det skrevne fjernes", () => {
  const { s, replace } = typed("Et afsnit.\n\n");
  const plan = planCommand(s, cmd("transform", "case upper"), file, replace);
  assert.equal(plan.ran, false);
  assert.ok(plan.notice);
  assert.equal(run(s, plan).doc.toString(), "Et afsnit.\n\n");
});

test("clip sidst i kæden flytter resultatet til Fraklip", () => {
  const doc = `Behold dette.\n\nFlyt dette.\n${parked}\n`;
  const from = doc.indexOf("Flyt");
  const s = state(doc, from, from + "Flyt dette.".length);
  const plan = planCommand(s, cmd("transform", "case upper\nclip"), file);
  assert.deepEqual(plan.moved, { to: "clip" });
  const after = run(s, plan).doc.toString();
  assert.ok(after.startsWith("Behold dette.\n\n\n"), after);
  assert.ok(after.includes(parked), "det gamle klip står urørt");
  assert.match(after, /<!-- gt:parkeret id=p2 dato=\S+\nFLYT DETTE\.\n-->\n$/);
});

test("footnote sidst i kæden gør markeringen til en fodnote før fraklippet", () => {
  const doc = `En påstand (Danmarks Statistik 2024) står her.[^1]\n\n[^1]: Den første.\n${parked}\n`;
  const from = doc.indexOf("(");
  const to = doc.indexOf(")") + 1;
  const s = state(doc, from, to);
  const plan = planCommand(s, cmd("transform", "footnote"), file);
  assert.deepEqual(plan.moved, { to: "footnote", label: "2" });
  const after = run(s, plan);
  const text = after.doc.toString();
  assert.ok(text.startsWith("En påstand [^2] står her.[^1]"), text);
  assert.ok(text.includes("[^2]: (Danmarks Statistik 2024)"), text);
  assert.ok(text.indexOf("[^2]:") < text.indexOf("<!-- gt:parkeret"), text);
  assert.ok(text.includes(parked));
  assert.equal(after.selection.main.head, from + "[^2]".length);
});

// --- tjek og AI -----------------------------------------------------------------------------------------

test("et tjek skriver intet, og fundene står på dokumentets positioner", () => {
  const doc = "Første afsnit.\n\nHer mangler TK noget.";
  const s = state(doc, 0);
  const plan = planCommand(s, cmd("check", "builtin: gaps", { scope: "document" }), file);
  assert.equal(plan.spec, undefined);
  assert.equal(plan.result?.kind, "findings");
  const findings = plan.result?.kind === "findings" ? plan.result.findings : [];
  assert.ok(findings.length >= 1);
  for (const f of findings) assert.equal(doc.slice(f.from, f.to), f.excerpt);
  assert.ok(findings.some((f) => f.excerpt.includes("TK")));
});

test("et tjek skrevet med »/« fjerner kun det skrevne, og positionerne gælder teksten bagefter", () => {
  const { s, replace } = typed("", "\n\nHer mangler TK noget.");
  const plan = planCommand(s, cmd("check", "builtin: gaps", { scope: "document" }), file, replace);
  const after = run(s, plan).doc.toString();
  assert.equal(after, "\n\nHer mangler TK noget.");
  const findings = plan.result?.kind === "findings" ? plan.result.findings : [];
  assert.ok(findings.length >= 1);
  for (const f of findings) assert.equal(after.slice(f.from, f.to), f.excerpt);
});

test("tjek og AI ser hverken fraklip eller noter", () => {
  const doc = `Tekst med <!-- TK i en note --> ord.\n${parked}\n`;
  const s = state(doc, 0);
  const text = readableSlice(s, { from: 0, to: doc.length });
  assert.equal(text.length, doc.length);
  assert.ok(!text.includes("TK") && !text.includes("klip"));
  assert.ok(text.startsWith("Tekst med ") && text.includes(" ord."));
  const check = planCommand(s, cmd("check", "builtin: gaps", { scope: "document" }), file);
  assert.deepEqual(check.result?.kind === "findings" ? check.result.findings : null, []);
  assert.ok(check.result?.note);
  const ai = planCommand(s, cmd("ai", "Peg på det uklare.", { scope: "document" }), file);
  assert.equal(ai.spec, undefined);
  assert.equal(ai.ai?.offset, 0);
  assert.ok(ai.ai && !ai.ai.text.includes("klip") && ai.ai.text.startsWith("Tekst med"));
});

test("en AI-kommando får markeringen og dens plads i dokumentet", () => {
  const doc = "Første afsnit.\n\nAndet afsnit.";
  const from = doc.indexOf("Andet");
  const s = state(doc, from, doc.length);
  assert.deepEqual(planCommand(s, cmd("ai", "Peg på det uklare."), file).ai, { text: "Andet afsnit.", offset: from });
});

// --- fejl -------------------------------------------------------------------------------------------------

test("en kommando med fejl køres ikke, og det skrevne bliver stående", () => {
  const { s, replace } = typed("");
  for (const broken of [cmd("template", "{{findes-ikke}}"), cmd("transform", "ukendt-klods")]) {
    const plan = planCommand(s, broken, file, replace, now);
    assert.equal(plan.ran, false);
    assert.equal(plan.spec, undefined);
    assert.match(plan.notice ?? "", /^\/prøve kan ikke køres: ./);
  }
});

// --- hjælperne ----------------------------------------------------------------------------------------------

test("de synlige stykker går uden om skjulte blokke og blanktegn i kanterne", () => {
  const doc = `  Et afsnit.  \n[^1]: En note.\nMere tekst.\n${parked}\n`;
  const s = state(doc, 0);
  assert.deepEqual(
    visibleSegments(s, { from: 0, to: doc.length }).map((p) => doc.slice(p.from, p.to)),
    ["Et afsnit.", "Mere tekst."],
  );
});

// --- /tabel (6/10) ---------------------------------------------------------------------------------------

test("/tabel uden markering sætter en tom tabel ind på sine egne linjer og peger på den", () => {
  const tabel = cmd("transform", "table");
  // Skrevet alene på en linje under et afsnit: en tom linje imellem, så markdown ser en tabel.
  const a = typed("Et afsnit.\n");
  const plan = planCommand(a.s, tabel, file, a.replace);
  const after = run(a.s, plan).doc.toString();
  assert.equal(after, `Et afsnit.\n\n${EMPTY_TABLE}`);
  assert.equal(plan.table, "Et afsnit.\n\n".length);
  // Skrevet midt i en linje: tabellen kommer på egne linjer, og teksten bliver stående.
  const b = typed("Før ", " efter");
  const mid = run(b.s, planCommand(b.s, tabel, file, b.replace)).doc.toString();
  assert.equal(mid, `Før\n\n${EMPTY_TABLE}\n\nefter`);
});

test("/tabel med markering laver linjerne om til en tabel", () => {
  const doc = "navn;titel\nMette;kontorchef";
  const s = state(doc, 0, doc.length);
  const after = run(s, planCommand(s, cmd("transform", "table"), file)).doc.toString();
  assert.equal(after, "| navn | titel |\n|---|---|\n| Mette | kontorchef |");
});
