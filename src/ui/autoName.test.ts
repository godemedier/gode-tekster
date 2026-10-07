import { test } from "node:test";
import assert from "node:assert/strict";
import { hasDefaultName, titleFromText } from "./autoName.ts";

test("kun programmets egne navne omdøbes", () => {
  assert.ok(hasDefaultName("C:\\T\\Uden titel.md"));
  assert.ok(hasDefaultName("C:\\T\\Uden titel 3.md"));
  assert.ok(hasDefaultName("C:\\T\\Untitled 2.md"));
  assert.ok(!hasDefaultName("C:\\T\\ARTIKEL.md"));
  assert.ok(!hasDefaultName("C:\\T\\Uden titel om noget.md"));
});

test("navnet kommer fra første færdige linje, uden markdown (5/10)", () => {
  assert.equal(titleFromText("Broen over Bæltet"), null);
  assert.equal(titleFromText("# Broen over **Bæltet**\n"), "Broen over Bæltet");
  assert.equal(titleFromText("\n\n- Interview med Mikkel: skak?\nnoget"), "Interview med Mikkel skak");
  assert.equal(titleFromText("Se [kilden](https://x.dk) her.\n"), "Se kilden her");
  assert.equal(titleFromText("   \n"), null);
  const long = titleFromText(`${"ord ".repeat(30)}\n`) ?? "";
  assert.ok(long.length <= 60 && !long.endsWith(" "));
});
