import { test } from "node:test";
import assert from "node:assert/strict";
import { imageInsert, isImage } from "./insertImage.ts";

test("billedet står på sin egen linje, med markøren i billedteksten", () => {
  const doc = "Første afsnit.\n\nAndet.";
  const mid = imageInsert(doc, 5, "medier/a-1.png");
  assert.equal(doc.slice(0, mid.from) + mid.insert + doc.slice(mid.from), "Første afsnit.\n\n![](medier/a-1.png)\n\nAndet.");
  assert.equal((doc.slice(0, mid.from) + mid.insert).slice(mid.cursor - 2, mid.cursor + 1), "![]");
  const empty = imageInsert(doc, 15, "medier/a-1.png");
  assert.deepEqual(empty, { from: 15, insert: "![](medier/a-1.png)", cursor: 17 });
});

test("iPhone-fotos og TIFF uden MIME-type tæller som billeder", () => {
  assert.equal(isImage({ name: "IMG_0412.HEIC", type: "" }), true);
  assert.equal(isImage({ name: "scan.tif", type: "" }), true);
  assert.equal(isImage({ name: "skærmbillede.png", type: "image/png" }), true);
  assert.equal(isImage({ name: "noter.txt", type: "text/plain" }), false);
});
