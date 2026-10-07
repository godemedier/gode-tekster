import { test } from "node:test";
import assert from "node:assert/strict";
import { daysLeft, findGoal, goalChange, goalLine, progress, type Goal } from "./goal.ts";
import { withoutParked } from "./parked.ts";
import { count } from "./count.ts";

const kronik: Goal = { kind: "hoejst", n: 7400, unit: "anslag", deadline: "2026-10-10" };

test("målet står som én skjult linje og læses tilbage", () => {
  const doc = `# Kronik\n\nTekst.\n\n${goalLine(kronik)}`;
  const g = findGoal(doc);
  assert.deepEqual({ ...g, from: undefined, to: undefined }, { ...kronik, from: undefined, to: undefined });
  assert.equal(findGoal("Ingen mål her."), null);
  assert.equal(findGoal("<!-- gt:maal type=noget antal=5 enhed=ord -->"), null);
});

test("et mål sættes sidst, skiftes på stedet og fjernes", () => {
  const apply = (doc: string, c: { from: number; to: number; insert: string }) => doc.slice(0, c.from) + c.insert + doc.slice(c.to);
  const a = apply("Tekst.", goalChange("Tekst.", kronik));
  assert.equal(a, `Tekst.\n\n${goalLine(kronik)}`);
  const b = apply(a, goalChange(a, { kind: "mindst", n: 500, unit: "ord", deadline: null }));
  assert.equal(b, "Tekst.\n\n<!-- gt:maal type=mindst antal=500 enhed=ord -->\n");
  assert.equal(apply(b, goalChange(b, null)), "Tekst.\n\n");
});

test("målet tæller ikke med og kommer ikke med ud", () => {
  const doc = `Fire ord i alt.\n\n${goalLine(kronik)}`;
  assert.equal(count(doc).words, 4);
  assert.doesNotMatch(withoutParked(doc), /gt:maal/);
});

test("fremdrift: højst, mindst og cirka", () => {
  const c = (chars: number, words = 0) => ({ chars, words, pages: chars / 2400, minutes: 0 });
  assert.equal(progress(c(6000), kronik).state, "ok");
  assert.equal(progress(c(7100), kronik).state, "naer");
  assert.equal(progress(c(7401), kronik).state, "over");
  assert.equal(progress(c(0, 499), { kind: "mindst", n: 500, unit: "ord", deadline: null }).state, "under");
  assert.equal(progress(c(0, 500), { kind: "mindst", n: 500, unit: "ord", deadline: null }).state, "ok");
  const cirka: Goal = { kind: "cirka", n: 2, unit: "sider", deadline: null };
  assert.equal(progress(c(4400), cirka).state, "ok");
  assert.equal(progress(c(5400), cirka).state, "over");
});

test("dage til fristen", () => {
  assert.equal(daysLeft("2026-10-10", new Date(2026, 9, 7, 23, 30)), 3);
  assert.equal(daysLeft("2026-10-07", new Date(2026, 9, 7, 8)), 0);
  assert.equal(daysLeft("2026-10-06", new Date(2026, 9, 7)), -1);
});
