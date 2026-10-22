import { test } from "node:test";
import assert from "node:assert/strict";
import { findStatus, findTagLine, statusChange, tagsOf, withoutTagLine } from "./textStatus.ts";
import { withoutParked } from "./parked.ts";

test("tags fjerner aldrig en kommentar på samme linje eller indhold i kode", () => {
  assert.equal(withoutTagLine("Tekst\n#tag <!-- vigtig note -->"), "Tekst\n#tag <!-- vigtig note -->");
  assert.equal(findTagLine("```\n#tag\n```"), null);
});

const apply = (doc: string, c: { from: number; to: number; insert: string }) => doc.slice(0, c.from) + c.insert + doc.slice(c.to);

test("status sættes, skiftes og fjernes øverst i teksten", () => {
  const a = apply("# Titel\n\nTekst.", statusChange("# Titel\n\nTekst.", "igang"));
  assert.equal(a, "<!-- gt:status vaerdi=igang -->\n# Titel\n\nTekst.");
  assert.equal(findStatus(a)?.id, "igang");
  const b = apply(a, statusChange(a, "faerdig"));
  assert.equal(findStatus(b)?.id, "faerdig");
  assert.equal(apply(b, statusChange(b, null)), "# Titel\n\nTekst.");
  assert.equal(findStatus("# Titel\n<!-- gt:status vaerdi=igang -->\n"), null);
});

test("tags kun på sidste synlige linje og kun hashtags", () => {
  assert.deepEqual(tagsOf("#klima #kronik"), ["klima", "kronik"]);
  assert.equal(tagsOf("# Overskrift"), null);
  assert.equal(tagsOf("#klima og mere"), null);
  assert.deepEqual(findTagLine("Tekst.\n\n#a #b\n\n<!-- gt:maal type=hoejst antal=7400 enhed=anslag -->\n")?.tags, ["a", "b"]);
  assert.equal(findTagLine("#a\n\nTekst bagefter."), null);
});

test("status og tags tæller ikke og kommer ikke med ud", () => {
  const doc = "<!-- gt:status vaerdi=igang -->\nTekst her.\n\n#klima #kronik\n";
  assert.equal(withoutTagLine(doc).includes("#klima"), false);
  const out = withoutParked(doc);
  assert.equal(out.includes("gt:status"), false);
  assert.equal(out.includes("#klima"), false);
  assert.ok(out.includes("Tekst her."));
});

test("notens farve står skjult sidst, skiftes på stedet og kommer ikke med ud", async () => {
  const { colorChange, findColor } = await import("./textStatus.ts");
  const a = apply("Ring før kl. 12", colorChange("Ring før kl. 12", "blaa"));
  assert.equal(a, "Ring før kl. 12\n\n<!-- gt:farve vaerdi=blaa -->\n");
  assert.equal(findColor(a)?.color, "blaa");
  const b = apply(a, colorChange(a, "rosa"));
  assert.equal(findColor(b)?.color, "rosa");
  assert.equal(withoutParked(b).includes("gt:farve"), false);
});
