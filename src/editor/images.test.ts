import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveImage } from "./images.ts";

test("relative billedstier slås op fra tekstens mappe", () => {
  assert.equal(resolveImage("billeder/graf.png", "C:\\Tekster\\Artikler"), "C:\\Tekster\\Artikler\\billeder\\graf.png");
  assert.equal(resolveImage("../fælles/logo%20ny.png", "C:\\Tekster\\Artikler"), "C:\\Tekster\\fælles\\logo ny.png");
  assert.equal(resolveImage("C:/Fotos/a.jpg", "C:\\x"), "C:\\Fotos\\a.jpg");
});

test("billeder fra nettet vises ikke", () => {
  assert.equal(resolveImage("https://example.com/a.png", "C:\\x"), null);
  assert.equal(resolveImage("data:image/png;base64,AAAA", "C:\\x"), null);
});
