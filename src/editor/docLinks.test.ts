import { test } from "node:test";
import assert from "node:assert/strict";

import { linkLabel, relativeLink } from "./docLinks.ts";

test("henvisningens sti er relativ til den åbne tekst, med / og ../ (27/10)", () => {
  const here = "C:\\Users\\Kim\\Documents\\Udkast\\notat.md";
  assert.equal(relativeLink(here, "C:\\Users\\Kim\\Documents\\Udkast\\plan.md"), "plan.md");
  assert.equal(relativeLink(here, "C:\\Users\\Kim\\Documents\\Strategi\\2026-10-27 LinkedIn-plan.md"), "../Strategi/2026-10-27%20LinkedIn-plan.md");
  assert.equal(relativeLink(here, "C:\\Users\\Kim\\Documents\\Udkast\\Bilag\\Tal (2025).md"), "Bilag/Tal%20%282025%29.md");
  assert.equal(relativeLink(here, "c:\\users\\kim\\documents\\Øvrigt\\Æble.md"), "../Øvrigt/Æble.md", "store og små bogstaver i stien er det samme på Windows");
});

test("et andet drev giver den fulde sti", () => {
  assert.equal(relativeLink("C:\\Tekster\\a.md", "D:\\Arkiv\\b c.md"), "D:/Arkiv/b%20c.md");
});

test("linkets tekst er filens navn uden filtype", () => {
  assert.equal(linkLabel("C:\\Docs\\2026-10-27 LinkedIn-plan.md"), "2026-10-27 LinkedIn-plan");
  assert.equal(linkLabel("C:/Docs/noter.txt"), "noter");
  assert.equal(linkLabel("C:\\Docs\\ingen.endelse"), "ingen.endelse");
});
