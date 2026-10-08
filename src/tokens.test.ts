// Kontrasten mellem farvetokens i styles.css, i lys, mørk og aften (personatjek 2/10: mørk tilstand kunne
// ikke læses flere steder, fordi farverne stod direkte i reglerne). Tekst mindst 4,5:1 (WCAG AA),
// dæmpet tekst mindst 3:1, fordi den bevidst skal træde tilbage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function tokens(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("}", start));
  return new Map([...block.matchAll(/--([\wæøå-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = ["blæk", "svag", "link", "fejl", "ok", "manchet", "ai-tekst", "wc-n", "wc-v", "wc-a", "wc-d", "wc-c"];
const SURFACES = ["flade", "panel", "kort"];

for (const [mode, selectors] of [
  ["lys", [":root"]],
  ["mørk", [":root", "body.dark"]],
  ["aften", [":root", "body.dark", "body.dark.aften"]],
] as const) {
  const t = new Map(selectors.flatMap((s) => [...tokens(s)]));
  test(`${mode}: al tekst står mindst 4,5:1 på flade, panel og kort`, () => {
    for (const fg of TEXT) {
      for (const bg of SURFACES) {
        const r = contrast(t.get(fg)!, t.get(bg)!);
        assert.ok(r >= 4.5, `--${fg} på --${bg}: ${r.toFixed(2)}:1`);
      }
    }
  });
  test(`${mode}: kode og AI-tekst på deres egne flader, dæmpet tekst mindst 3:1`, () => {
    assert.ok(contrast(t.get("kode-tekst")!, t.get("kode-flade")!) >= 4.5, "kode");
    assert.ok(contrast(t.get("ai-tekst")!, t.get("ai-flade")!) >= 4.5, "AI-tekst");
    assert.ok(contrast(t.get("note-tekst")!, t.get("note-flade")!) >= 4.5, `note ${contrast(t.get("note-tekst")!, t.get("note-flade")!).toFixed(2)}:1`);
    assert.ok(contrast(t.get("dæmpet")!, t.get("flade")!) >= 3, `dæmpet ${contrast(t.get("dæmpet")!, t.get("flade")!).toFixed(2)}:1`);
    assert.ok(contrast(t.get("link-tekst")!, t.get("link")!) >= 4.5, "knap med link-farve");
    // Accenten er en streg og en markør: grafik, ikke tekst (WCAG 1.4.11, mindst 3:1).
    assert.ok(contrast(t.get("accent")!, t.get("flade")!) >= 3, `accent ${contrast(t.get("accent")!, t.get("flade")!).toFixed(2)}:1`);
  });
}
