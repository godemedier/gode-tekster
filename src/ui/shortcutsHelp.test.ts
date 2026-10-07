import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GROUPS } from "./shortcutsHelp.ts";

test("hver genvej i editoren står i oversigten (F1)", () => {
  const source = readFileSync(new URL("../editor/shortcuts.ts", import.meta.url), "utf8");
  const listed = GROUPS.flatMap(([, rows]) => rows.map(([keys]) => keys)).join(" | ");
  for (const [, key] of source.matchAll(/key: "([^"]+)"/g)) {
    const shown = key
      .replace("Mod", "Ctrl")
      .split("-")
      .map((p) => (p.length === 1 ? p.toUpperCase() : p))
      .join("+");
    const ok = /^Ctrl\+[123]$/.test(shown) ? listed.includes("Ctrl+1 til 3") : listed.includes(shown);
    assert.ok(ok, `${key} (${shown}) mangler i genvejsoversigten`);
  }
});
