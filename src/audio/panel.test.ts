import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioPanel } from "./panel.ts";

test("gemt transskription genåbnes uden ny fil efter et afvist filskift", async () => {
  const target = "C:\\test\\optagelse.transskription.md";
  let current = "C:\\test\\artikel.md", saves = 0, opens = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string) => {
      assert.equal(command, "save_transcript"); saves++; return target;
    } },
  } });
  // Prøv gemmeforløbet uden DOM. Filskiftet kan afslutte uden at åbne teksten.
  const panel = Object.assign(Object.create(AudioPanel.prototype), {
    id: "test", busy: false, partial: true, body: null, timer: null,
    savedPath: null, path: () => current,
    open: async () => { if (++opens === 2) current = target; },
  }) as { save(elsewhere?: boolean): Promise<void>; partial: boolean; status: string; savedPath: string | null; saveFailed: boolean };
  try {
    await panel.save();
    assert.equal(panel.partial, true);
    assert.equal(panel.savedPath, target);
    assert.equal(panel.saveFailed, true);
    assert.match(panel.status, /kunne ikke åbnes/);
    await panel.save();
    assert.equal(panel.partial, false);
    assert.equal(saves, 1);
    assert.equal(opens, 2);
    // En gemt fil kan siden være flyttet udefra. Et nyt valg skal altid nå Rust.
    await panel.save(true);
    assert.equal(saves, 2);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("nødkopi fra en tidligere session gemmes et nyt sted og kan slettes", async () => {
  const calls: string[] = [], opened: string[] = [];
  let recoveries = ["1-1760000000000-2", "1-1760000000001-3"];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: { id?: string }) => {
      calls.push(command);
      if (command === "audio_recover") { recoveries = recoveries.filter(r => r !== args.id); return "C:\test\møde.transskription.md"; }
      if (command === "audio_forget_recovery") { recoveries = recoveries.filter(r => r !== args.id); return null; }
      if (command === "audio_recoveries") return recoveries;
      throw new Error(command);
    } },
  } });
  const panel = Object.assign(Object.create(AudioPanel.prototype), {
    body: null, recoveries, open: async (path: string) => { opened.push(path); },
  }) as { recover(id: string): Promise<void>; forget(id: string): Promise<void>; recoveries: string[] };
  try {
    await panel.recover("1-1760000000000-2");
    // Den gemte kopi åbnes fra det sted, brugeren valgte, ikke fra den skjulte jobmappe.
    assert.deepEqual(opened, ["C:\test\møde.transskription.md"]);
    assert.deepEqual(panel.recoveries, ["1-1760000000001-3"]);
    await panel.forget("1-1760000000001-3");
    assert.deepEqual(panel.recoveries, []);
    assert.deepEqual(calls, ["audio_recover", "audio_recoveries", "audio_forget_recovery", "audio_recoveries"]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
