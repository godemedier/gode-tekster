import { test } from "node:test";
import assert from "node:assert/strict";

import { countLine } from "./versionLine.ts";

test("versionens linje med ord: nye, fjernede og små rettelser (9/10)", () => {
  assert.equal(countLine({ place: "Hvad koster det?", added: 84, removed: 12 }), "+84 nye ord, 12 fjernet");
  assert.equal(countLine({ place: "", added: 1, removed: 0 }), "+1 nyt ord");
  assert.equal(countLine({ place: "", added: 0, removed: 12 }), "12 ord fjernet");
  assert.equal(countLine({ place: "", added: 0, removed: 1 }), "1 ord fjernet");
  assert.equal(countLine({ place: "", added: 0, removed: 0 }), "Små rettelser");
});
