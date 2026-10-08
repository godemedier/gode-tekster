import { test } from "node:test";
import assert from "node:assert/strict";
import { isEvening, sunTimes } from "./theme.ts";

// Klokkeslæt i dansk tid uanset maskinens tidszone: Date bygges lokalt, offset og længde gives.
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);
const clock = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, "0")}`;

test("solens tider i Danmark ligger, hvor almanakken har dem (±15 min)", () => {
  const winter = sunTimes(at(2026, 12, 21, 12), 60, 10.5);
  const summer = sunTimes(at(2026, 6, 21, 12), 120, 10.5);
  // Aarhus: 21/12 op 8.52, ned 15.38. 21/6 op 4.30, ned 22.08.
  assert.ok(Math.abs(winter.rise - (8 * 60 + 52)) < 15, `vinter op ${clock(winter.rise)}`);
  assert.ok(Math.abs(winter.set - (15 * 60 + 38)) < 15, `vinter ned ${clock(winter.set)}`);
  assert.ok(Math.abs(summer.rise - (4 * 60 + 30)) < 15, `sommer op ${clock(summer.rise)}`);
  assert.ok(Math.abs(summer.set - (22 * 60 + 8)) < 15, `sommer ned ${clock(summer.set)}`);
});

test("aften begynder ved solnedgang, men aldrig før kl. 18, og slutter ved solopgang", () => {
  const dk = (d: Date, sommer: boolean) => isEvening(d, sommer ? 120 : 60, 10.5);
  assert.equal(dk(at(2026, 12, 21, 16), false), false, "decembereftermiddag er lys");
  assert.equal(dk(at(2026, 12, 21, 18, 30), false), true);
  assert.equal(dk(at(2026, 12, 22, 7), false), true, "før solopgang i december");
  assert.equal(dk(at(2026, 12, 22, 9, 30), false), false);
  assert.equal(dk(at(2026, 6, 21, 20), true), false, "sommeraften er lys til solnedgang");
  assert.equal(dk(at(2026, 6, 21, 22, 30), true), true);
  assert.equal(dk(at(2026, 6, 22, 4), true), true);
  assert.equal(dk(at(2026, 6, 22, 5), true), false);
});
