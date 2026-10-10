// Acceptkriterie 6 i plan 1, »intet hopper«: når markøren går ind i en linje, vises markdown-
// tegnene, men linjen må ikke skifte højde, og teksten under må ikke flytte sig. Kører kun med
// GT_MEASURE=1 og skriver resultatet i programmets log. Rører ikke filen.

import { invoke } from "@tauri-apps/api/core";
import { settings } from "./settings.ts";
import { EditorView } from "@codemirror/view";
import { notify } from "./ui/banner.ts";

const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

function lineBox(view: EditorView, pos: number): DOMRect | null {
  const { node } = view.domAtPos(pos);
  const el = (node instanceof HTMLElement ? node : node.parentElement)?.closest(".cm-line");
  return el ? el.getBoundingClientRect() : null;
}

export async function measureJumps(view: EditorView): Promise<void> {
  const doc = view.state.doc;
  const results: string[] = [];
  let worst = 0;
  const rest = doc.length;
  for (let n = 1; n < doc.lines; n++) {
    const line = doc.line(n);
    if (!/^(#{1,6} |> |\s*[-*+] |\s*\d+\. )|\*\*|\*|\[|~~|\{--/.test(line.text)) continue;
    const next = doc.line(n + 1);
    // Markøren et andet sted, rul linjen ind, mål.
    view.dispatch({ selection: { anchor: rest }, effects: [] });
    view.dom.querySelector(".cm-scroller")?.scrollTo({ top: Math.max(0, view.lineBlockAt(line.from).top - 200) });
    await frame();
    const before = lineBox(view, line.from);
    const beforeNext = lineBox(view, next.from);
    // Markøren ind i linjen.
    view.dispatch({ selection: { anchor: line.from + Math.min(2, line.length) } });
    await frame();
    const after = lineBox(view, line.from);
    const afterNext = lineBox(view, next.from);
    if (!before || !after || !beforeNext || !afterNext) continue;
    const dh = Math.abs(after.height - before.height);
    const dNext = Math.abs(afterNext.top - beforeNext.top);
    worst = Math.max(worst, dh, dNext);
    if (dh > 0.5 || dNext > 0.5) results.push(`linje ${n} »${line.text.slice(0, 30)}«: højde ${dh.toFixed(1)} px, næste linje ${dNext.toFixed(1)} px`);
  }
  await invoke("log_line", { text: `måling, intet hopper: største flytning ${worst.toFixed(1)} px` });
  // Billeder gennem asset-protokollen: indlæst = naturalWidth over 0. De tegnes kun i synsfeltet.
  view.dispatch({ selection: { anchor: doc.length }, scrollIntoView: true });
  await frame();
  await new Promise((r) => setTimeout(r, 800));
  const imgs = [...view.dom.querySelectorAll<HTMLImageElement>(".gt-img img")];
  const missing = view.dom.querySelectorAll(".gt-img-missing").length;
  await invoke("log_line", { text: `måling, billeder: ${imgs.filter((i) => i.naturalWidth > 0).length} vist, ${missing} ikke fundet` });
  for (const r of results.slice(0, 20)) await invoke("log_line", { text: `måling: ${r}` });
}

/** Fast rulning: står linjen med markøren i midten, også i tekstens begyndelse og slutning? */
export async function measureTypewriter(view: EditorView): Promise<void> {
  const { setModes } = await import("./editor/modes.ts");
  setModes(view, { focus: false, typewriter: true });
  const settle = () => new Promise((r) => setTimeout(r, 700));
  await settle();
  const offsets: string[] = [];
  for (const [name, pos] of [["start", 0], ["midt", Math.floor(view.state.doc.length / 2)], ["slut", view.state.doc.length]] as const) {
    view.dispatch({ selection: { anchor: pos }, userEvent: "select" });
    await settle();
    const c = view.coordsAtPos(pos);
    const box = view.scrollDOM.getBoundingClientRect();
    offsets.push(c ? `${name} ${((c.top + c.bottom) / 2 - (box.top + box.height / 2)).toFixed(1)} px` : `${name} ikke tegnet`);
  }
  // Et linjeskift i slutningen: linjen må ikke vippe.
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\n" }, selection: { anchor: view.state.doc.length + 1 }, userEvent: "input.type" });
  await settle();
  const c = view.coordsAtPos(view.state.selection.main.head);
  const box = view.scrollDOM.getBoundingClientRect();
  if (c) offsets.push(`efter linjeskift ${((c.top + c.bottom) / 2 - (box.top + box.height / 2)).toFixed(1)} px`);
  view.dispatch({ changes: { from: view.state.doc.length - 1, to: view.state.doc.length } });
  await invoke("log_line", { text: `måling, fast rulning fra midten: ${offsets.join(", ")}` });
}

// --- ydelse på en stor tekst (STOR.md, ca. 200 sider) -------------------------------------------

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];

/** Hvor lang tid tager et tastetryk, og hvor lange er de lange opgaver bagefter? Rører kun hukommelsen; skrevet tekst fjernes igen. */
export async function measurePerf(view: EditorView): Promise<void> {
  const log = (t: string) => invoke("log_line", { text: `ydelse: ${t}` });
  const long: number[] = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration))).observe({ type: "longtask", buffered: false });
  const doc = view.state.doc.toString();
  const time = (f: () => unknown, n = 5) => {
    const t: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = performance.now();
      f();
      t.push(performance.now() - a);
    }
    return median(t).toFixed(0);
  };
  const { analyze, setStyleCheck, currentLix } = await import("./editor/styleCheck.ts");
  const { count } = await import("./editor/count.ts");
  const { headings } = await import("./editor/outline.ts");
  const { withoutParked } = await import("./editor/parked.ts");
  const { setModes } = await import("./editor/modes.ts");
  const { setWordClasses } = await import("./editor/wordclasses.ts");
  await log(`${doc.length} tegn, ${view.state.doc.lines} linjer`);
  await log(
    `hele teksten: toString ${time(() => view.state.doc.toString())} ms, ordtal ${time(() => count(doc))} ms, disposition ${time(() => headings(doc))} ms, ` +
      `withoutParked ${time(() => withoutParked(doc))} ms, stiltjek ${time(() => analyze(doc), 3)} ms`,
  );

  const type = async (label: string, n = 150) => {
    const line = view.state.doc.line(Math.floor(view.state.doc.lines / 2));
    view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
    await new Promise((r) => setTimeout(r, 1500));
    long.length = 0;
    const sync: number[] = [];
    const frames: number[] = [];
    const start = view.state.selection.main.head;
    for (let i = 0; i < n; i++) {
      const head = view.state.selection.main.head;
      const a = performance.now();
      view.dispatch({ changes: { from: head, insert: i % 6 === 5 ? " " : "e" }, selection: { anchor: head + 1 }, userEvent: "input.type" });
      const b = performance.now();
      await new Promise((r) => requestAnimationFrame(r));
      frames.push(performance.now() - a);
      sync.push(b - a);
    }
    // Den efterfølgende ro: stiltjek (400 ms), ordtal, autosave (1,5 s).
    await new Promise((r) => setTimeout(r, 2500));
    view.dispatch({ changes: { from: start, to: start + n } });
    await log(
      `${label}: tastetryk median ${median(sync).toFixed(1)} ms, p95 ${p95(sync).toFixed(1)}, max ${Math.max(...sync).toFixed(1)}; ` +
        `til næste billede median ${median(frames).toFixed(1)} ms, p95 ${p95(frames).toFixed(1)}; ` +
        `lange opgaver ${long.length} stk, længste ${long.length ? Math.max(...long).toFixed(0) : 0} ms`,
    );
  };

  await type("ren skriveflade");
  setStyleCheck(view, true);
  await type("med stiltjek");
  const lix = currentLix();
  await log(`stiltjek fra worker: ${lix ? `LIX ${Math.round(lix.lix)}, ${view.dom.querySelectorAll(".gt-style").length} markeringer i synsfeltet` : "intet svar"}`);
  setStyleCheck(view, false);
  await setWordClasses(view, true);
  await type("med ordklasser");
  await setWordClasses(view, false);
  setModes(view, { focus: true, typewriter: true });
  await type("med fokus og fast rulning");
  setModes(view, { focus: false, typewriter: false });
  // Rul hele vejen igennem: tegning af linjer, billeder og fodnoter.
  long.length = 0;
  const a = performance.now();
  for (let y = 0; y < view.scrollDOM.scrollHeight; y += 900) {
    view.scrollDOM.scrollTop = y;
    await new Promise((r) => requestAnimationFrame(r));
  }
  await log(`rul gennem hele teksten: ${(performance.now() - a).toFixed(0)} ms, lange opgaver ${long.length}, længste ${long.length ? Math.max(...long).toFixed(0) : 0} ms`);
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  if (mem) await log(`JS-hukommelse ${(mem.usedJSHeapSize / 1e6).toFixed(0)} MB`);
  await log("færdig");
}

/** Dispositionen og træk til Fraklip, prøvet med syntetiske hændelser. Alt fortrydes igen. */
export async function measureUi(view: EditorView): Promise<void> {
  const log = (t: string) => invoke("log_line", { text: `brugerflade: ${t}` });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const before = view.state.doc.toString();
  // Tilbage til teksten fra før, uanset hvad der er sket (fortryd kunne ramme en tidligere tests ændring).
  const restore = () => {
    if (view.state.doc.toString() !== before) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: before } });
  };
  const body = document.body.classList;

  // Ctrl+J åbner venstre spalte på dispositionen med fokus i den aktuelle sektion.
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("Tidligere havde") } });
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ctrlKey: true, bubbles: true }));
  await wait(400);
  const rows = [...document.querySelectorAll<HTMLElement>(".outline-row")];
  const active = document.querySelector(".outline-row.active")?.textContent;
  await log(`Ctrl+J: spalte ${body.contains("left-open") ? "åben" : "LUKKET"}, ${rows.length} overskrifter, aktiv »${active}«, fokus på ${document.activeElement?.className}`);
  // Skriv en ny overskrift: dispositionen skal opdatere sig, mens den vises.
  const at = view.state.doc.toString().indexOf("Tidligere havde");
  view.dispatch({ changes: { from: at, insert: "## Ny overskrift under skrivning\n\n" }, userEvent: "input.type" });
  await wait(600);
  const after = document.querySelectorAll(".outline-row").length;
  await log(`disposition efter ny overskrift: ${after} rækker (før ${rows.length}): ${after === rows.length + 1 ? "opdateret" : "IKKE OPDATERET"}`);
  restore();
  await wait(400);
  await invoke("log_line", { text: "brugerflade: skærmbillede nu" });
  await wait(2500);

  // Træk den sidste overskrift op foran den første.
  const dt = new DataTransfer();
  const fresh = [...document.querySelectorAll<HTMLElement>(".outline-row")];
  const src = fresh[fresh.length - 1];
  const dst = fresh[0];
  src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
  const r = dst.getBoundingClientRect();
  dst.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true, clientY: r.top + 2 }));
  dst.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientY: r.top + 2 }));
  src.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
  const moved = view.state.doc.toString();
  const firstHeading = /^#{1,6} (.+)$/m.exec(moved)?.[1];
  await log(`træk sektion: »${src.textContent}« er nu første overskrift: ${firstHeading === src.textContent ? "ja" : `NEJ (${firstHeading})`}, samme længde: ${moved.length === before.length}`);
  restore();
  await log(`fortryd: teksten som før: ${view.state.doc.toString() === before ? "ja" : "NEJ"}`);

  // Escape lukker spalten og giver fokus tilbage til teksten.
  document.querySelector<HTMLElement>(".outline-row")?.focus();
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(300);
  await log(`Esc: spalte ${body.contains("left-open") ? "STADIG ÅBEN" : "lukket"}, fokus i teksten: ${view.hasFocus || document.activeElement === view.contentDOM}`);

  // Træk tekst mod højre kant: spalten glider frem på en anden fane end Fraklip; slip giver et fraklip.
  (document.querySelector('.panel-right .rp-tab:nth-child(2)') as HTMLElement | null)?.click();
  const text = new DataTransfer();
  text.setData("text/plain", "Et stykke tekst trukket ind fra en anden app.");
  document.getElementById("zone-right")?.dispatchEvent(new DragEvent("dragenter", { dataTransfer: text, bubbles: true }));
  await wait(300);
  const opened = body.contains("right-open");
  const right = document.getElementById("right") as HTMLElement;
  right.dispatchEvent(new DragEvent("dragover", { dataTransfer: text, bubbles: true, cancelable: true }));
  right.dispatchEvent(new DragEvent("drop", { dataTransfer: text, bubbles: true, cancelable: true }));
  await wait(300);
  const tab = document.querySelector('.panel-right .rp-tab[aria-selected="true"]')?.textContent;
  const card = [...document.querySelectorAll(".rp-card-text")].some((c) => c.textContent?.includes("trukket ind fra en anden app"));
  await log(`træk til højre kant: spalte ${opened ? "glider frem" : "BLEV SKJULT"}, fane efter slip »${tab}«, kortet findes: ${card ? "ja" : "NEJ"}`);
  restore();
  await wait(200);
  await log(`fortryd: teksten som før: ${view.state.doc.toString() === before ? "ja" : "NEJ"}`);
}

/** Blinker markøren med timeren, og kun det (ingen CSS-animation)? */
export async function measureCaret(view: EditorView): Promise<void> {
  view.focus();
  view.dispatch({ selection: { anchor: 0 } });
  let flips = 0;
  const obs = new MutationObserver(() => flips++);
  obs.observe(view.dom, { attributes: true, attributeFilter: ["class"] });
  await new Promise((r) => setTimeout(r, 2200));
  obs.disconnect();
  const anim = getComputedStyle(view.dom.querySelector(".cm-cursorLayer") as Element).animationName;
  await invoke("log_line", { text: `markør: fokus ${view.hasFocus}, ${flips} skift på 2,2 s, CSS-animation »${anim}«` });
}

/** Til skærmbilleder: indstillingerne og forhåndsvisningen (Ctrl+R) et par sekunder hver. */
export async function measureLook(): Promise<void> {
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, ctrlKey: true, bubbles: true }));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  key(",");
  await wait(600);
  await invoke("log_line", { text: "udseende: indstillinger nu" });
  await wait(2500);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  (document.querySelector(".settings [aria-label^='Luk']") as HTMLElement | null)?.click();
  await wait(400);
  key("p");
  await wait(1500);
  await invoke("log_line", { text: "udseende: print nu" });
  await wait(2500);
  // Ctrl+P igen ville udskrive (9/10): forhåndsvisningen lukkes med »Luk«.
  document.querySelector<HTMLElement>(".pv-bar .pv-quiet")?.click();
  await invoke("log_line", { text: "udseende: færdig" });
}

// --- scenarier til testprotokollen (GT_SCENARIE=navn) --------------------------------------------
// Et script uden for programmet dræber, ændrer filen udefra, gør den skrivebeskyttet eller omdøber
// den, og læser resultatet i loggen og på disken. Kører kun på kopier i tests/private.

const say = (t: string) => invoke("log_line", { text: `scenarie: ${t}` });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const banner = () => (document.getElementById("banner")?.hidden ? "(ingen besked)" : (document.getElementById("banner")?.textContent ?? "").slice(0, 200));
const append = (view: EditorView, text: string) => view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: "input.type" });

export async function runScenario(name: string, view: EditorView, path: string | null = null): Promise<void> {
  await say(`start ${name}, ${view.state.doc.length} tegn`);
  if (name === "audit") {
    window.addEventListener("error", (e) => void say(`audit ERROR ${e.message}`));
    try {
      const check = async (ok: boolean, label: string) => {
        if (!ok) throw new Error(label);
        await say(`audit OK ${label}`);
      };
      const { findRevisions, resolvePending } = await import("./editor/critic.ts");
      const { insertFootnote } = await import("./editor/editing.ts");
      const { headings } = await import("./editor/outline.ts");
      const { findTagLine } = await import("./editor/textStatus.ts");
      const original = view.state.doc.toString();
      append(view, "\n\nAUDIT-GEMT");
      window.dispatchEvent(new Event("gt-save-now"));
      await pause(2000);
      const saved = await invoke<{ text: string }>("open_document", { path });
      await check(saved.text.includes("AUDIT-GEMT"), "gemning på disk");
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "<!-- gt:status kladde -->\n# Titel\n\nTekst\n\n#tag" } });
      await check(headings(view.state.doc.toString()).length === 1, "overskrift efter status");
      const plan = insertFootnote(view.state.doc.toString(), view.state.doc.toString().indexOf("Tekst") + 5);
      view.dispatch({ changes: plan.changes, selection: { anchor: plan.cursor } });
      const doc = view.state.doc.toString();
      await check(doc.indexOf("[^1]:") < (findTagLine(doc)?.from ?? -1), "fodnote før tags");
      await check(findRevisions("```\n{++kode++}\n```\n{++forslag++}").length === 1, "kode er data");
      await check(resolvePending("{~~gammel <!-- note -->~>ny~~}") === "gammel", "kommentar i rettelse");
      window.dispatchEvent(new Event("gt-open-settings"));
      await pause(350);
      const sheet = document.querySelector<HTMLElement>(".settings:not(.feedback)")!;
      const tab = sheet.querySelector<HTMLButtonElement>("#st-tab-tekst")!;
      await check(!!tab && !sheet.hidden, "indstillinger åbnet");
      tab.click();
      const width = sheet.querySelector<HTMLInputElement>('input[type="range"]')!;
      width.focus();
      width.value = "72";
      width.dispatchEvent(new Event("change"));
      await pause(800);
      await check(document.activeElement === sheet.querySelector('input[type="range"]'), "indstillinger bevarer fokus efter ændring");
      const { focusable } = await import("./ui/focus.ts");
      const controls = focusable(sheet);
      controls.at(-1)!.focus();
      const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      controls.at(-1)!.dispatchEvent(forward);
      await check(forward.defaultPrevented && document.activeElement === controls[0], "Tab bliver i dialogen");
      const backward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      controls[0].dispatchEvent(backward);
      await check(backward.defaultPrevented && document.activeElement === controls.at(-1), "Shift+Tab bliver i dialogen");
      sheet.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await pause(300);
      await check(view.hasFocus && !document.body.classList.contains("settings-open"), "Esc gendanner skrivefokus");
      const beforeTab = view.state.doc.toString();
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
      const escapeTab = new KeyboardEvent("keydown", { key: "Tab", keyCode: 9, bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(escapeTab);
      await check(!escapeTab.defaultPrevented && view.state.doc.toString() === beforeTab, "Esc så Tab forlader editoren");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F6", bubbles: true, cancelable: true }));
      await check(document.getElementById("left")!.contains(document.activeElement), "F6 åbner biblioteket med fokus");
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await check(view.hasFocus, "Esc fra panel til tekst");
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original + "\n\nAUDIT-GEMT" } });
      window.dispatchEvent(new Event("gt-save-now"));
      await pause(2000);
      const hits = await invoke<{ path: string; snippet: string }[]>("search_library", { query: "syntetisk" });
      await check(hits.some((hit) => hit.path.toLowerCase() === path?.toLowerCase()), "indekseret biblioteksøgning via IPC");
      const again = await invoke<{ path: string }[]>("search_library", { query: "syntetisk" });
      await check(again.length === hits.length, "søgeindeks genbruges");
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original + "\n\nAUDIT-GEMT" } });
      window.dispatchEvent(new Event("gt-save-now"));
      await pause(2000);
      const { emitTo } = await import("@tauri-apps/api/event");
      await invoke("note_new");
      await pause(2000);
      await emitTo("note-1", "gt-test-note", { text: "AUDIT-NOTE\n\n" + "Lang note til rulning.\n".repeat(80), audit: true });
      await pause(1500);
      await emitTo("note-1", "gt-test-note", { close: true });
      await pause(500);
      await say("audit PASS");
    } catch (e) {
      await say(`audit FAIL ${String(e)}`);
    }
  } else if (name === "skriv") {
    append(view, "\n\nSCENARIE-SKREVET midt i en sætning");
    await say("skrevet");
  } else if (name === "skriv-ekstern") {
    // Bliv ved med at skrive i 5 s (så autosave venter), mens scriptet ændrer filen udefra.
    append(view, "\n\nLOKAL-ÆNDRING");
    await say("skriver");
    for (let i = 0; i < 16; i++) {
      append(view, ".");
      await pause(300);
    }
    await pause(4000);
    const doc = view.state.doc.toString();
    await say(`efter: lokal ${doc.includes("LOKAL-ÆNDRING") ? "ja" : "NEJ"}, ekstern ${doc.includes("EKSTERN-ÆNDRING") ? "ja" : "NEJ"}; besked: ${banner()}`);
  } else if (name === "skrivebeskyttet") {
    append(view, "\n\nSKAL-IKKE-KUNNE-GEMMES");
    await pause(4000);
    await say(`besked: ${banner()}`);
  } else if (name === "omdoeb") {
    await say("klar til omdøbning");
    await pause(3000);
    append(view, "\n\nEFTER-OMDØBNING");
    await pause(4000);
    await say(`besked: ${banner()}; titel: ${document.title}`);
  } else if (name === "tegnsaet") {
    await pause(500);
    await say(`første linje: »${view.state.doc.line(1).text.slice(0, 60)}«; besked: ${banner()}`);
    append(view, "\nTilføjet: Grøn æble på åen.");
    await pause(3000);
    await say(`efter gem: besked: ${banner()}`);
  } else if (name === "stor") {
    view.dispatch({ changes: { from: 0, insert: "START-RETTET " }, userEvent: "input.type" });
    await pause(4000);
    await say(`gemt, ${view.state.doc.length} tegn, sidste linje »${view.state.doc.line(view.state.doc.lines).text.slice(-40)}«`);
  } else if (name === "fortryd") {
    const before = view.state.doc.toString();
    const { undo, redo } = await import("@codemirror/commands");
    const { cmd } = await import("./editor/shortcuts.ts");
    const steps: string[] = [];
    append(view, "\n\nEt nyt afsnit");
    await pause(600);
    view.dispatch({ selection: { anchor: view.state.doc.length - 5, head: view.state.doc.length } });
    cmd.bold(view);
    await pause(600);
    const line = view.state.doc.line(3);
    view.dispatch({ changes: { from: line.from, to: line.to + 1 }, userEvent: "delete" });
    await pause(2500); // et gem imellem
    for (let i = 0; i < 10; i++) steps.push(String(undo(view)));
    const back = view.state.doc.toString() === before;
    for (let i = 0; i < 10; i++) redo(view);
    await say(`fortryd 10: tilbage til start ${back ? "ja" : "NEJ"}; gentag giver ${view.state.doc.toString().includes("**fsnit**") ? "fed tekst igen" : "IKKE fed"}`);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: before } });
  } else if (name === "spring") {
    // Disposition i en lang tekst: lander overskriften øverst i vinduet?
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ctrlKey: true, bubbles: true }));
    await pause(600);
    const rows = [...document.querySelectorAll<HTMLElement>(".outline-row")];
    const out: string[] = [];
    for (const i of [Math.floor(rows.length * 0.8), Math.floor(rows.length * 0.3), rows.length - 1]) {
      const row = document.querySelectorAll<HTMLElement>(".outline-row")[i];
      if (!row) continue;
      const text = row.textContent ?? "";
      row.click();
      await pause(700);
      const sel = view.state.selection.main.head;
      const c = view.coordsAtPos(sel);
      const box = view.scrollDOM.getBoundingClientRect();
      const line = view.state.doc.lineAt(sel).text;
      out.push(`»${text.slice(0, 20)}«: ${line.includes(text.slice(0, 15)) ? "rigtig linje" : "FORKERT linje"}, ${c ? Math.round(c.top - box.top) : "?"} px fra toppen`);
    }
    await say(`spring: ${out.join("; ")}`);
  } else if (name.startsWith("skift:")) {
    await switchStress(view, name.slice("skift:".length).split("|"));
  } else if (name === "indsaet") {
    await pasteStress(view);
  } else if (name === "fraklip") {
    await parkStress(view);
  } else if (name === "renskriv") {
    await cleanStress(view);
  } else if (name.startsWith("vinduer:")) {
    await windowsScenario(name.slice("vinduer:".length));
  } else if (name === "runde6") {
    // 4/10: trippelklik, Sprog-fanen, »tænker«-visningen og licenserne, med billeder udefra.
    const doc = view.state.doc;
    let line = doc.line(1);
    for (let n = 2; n <= doc.lines; n++) if (doc.line(n).length > 60 && !doc.line(n).text.startsWith("#") && !doc.line(n).text.startsWith("|")) { line = doc.line(n); break; }
    view.dispatch({ selection: { anchor: 0 }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    await pause(500);
    const c = view.coordsAtPos(line.from + 10);
    if (c) {
      const x = c.left + 1, y = (c.top + c.bottom) / 2;
      const target = document.elementFromPoint(x, y) ?? view.contentDOM;
      const fire = (type: string, detail: number) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1, detail, view: window }));
      for (const d of [1, 2, 3]) {
        fire("mousedown", d);
        fire("mouseup", d);
        await pause(120);
      }
      await pause(500);
      const s = view.state.selection.main;
      await say(`trippelklik: markeret ${s.from}-${s.to}, linjen er ${line.from}-${line.to}, ${s.to === line.to ? "slutter ved linjens ende (rigtigt)" : s.to === line.to + 1 ? "TAGER LINJESKIFTET MED" : "andet"}`);
    }
    await pause(1500);
    // Sprog-fanen med begge dele slået til, kun i hukommelsen (testen deler brugerens indstillingsfil).
    Object.assign(settings(), { wordClasses: true, styleCheck: true });
    const { setWordClasses } = await import("./editor/wordclasses.ts");
    const { setStyleCheck } = await import("./editor/styleCheck.ts");
    await setWordClasses(view, true);
    setStyleCheck(view, true);
    window.dispatchEvent(new CustomEvent("gt-test-tab", { detail: "sprog" }));
    await pause(2500);
    window.dispatchEvent(new Event("gt-style"));
    await pause(800);
    await say(`sprog: fanen vist, ${document.querySelectorAll(".lp-legend").length} rækker i forklaringen`);
    await pause(2000);
    // Licenserne: kommandoen skal åbne filen (Windows' program til .txt), ikke fejle.
    try {
      await invoke("open_licenses");
      await say("licenser: åbnet uden fejl");
    } catch (e) {
      await say(`licenser: FEJL ${String(e)}`);
    }
    await pause(1500);
    // »Tænker« med Claude på en markering.
    view.dispatch({ selection: { anchor: line.from, head: Math.min(line.to, line.from + 80) } });
    window.dispatchEvent(new CustomEvent("gt-claude", { detail: "factcheck" }));
    for (let i = 0; i < 120; i++) {
      await pause(250);
      const send = [...(document.getElementById("banner")?.querySelectorAll("button") ?? [])].find((x) => x.textContent === "Send");
      if (send) send.click();
      if (document.querySelector(".cl-running")) break;
    }
    await pause(5000);
    await say("taenker: vises");
    await pause(2500);
    void invoke("claude_cancel");
    await say("færdig-runde6");
  } else if (name === "runde7") {
    // 5/10: lister (punkttegn, indrykning, a./a)/i.), Enter i en bogstavliste, Ret stavefejl,
    // ordklasser med én slået fra, print og indstillinger. Indstillinger kun i hukommelsen.
    const click = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)?.click();
    click("Disposition");
    // Enter i slutningen af »b. Anden«.
    const doc = view.state.doc;
    let n = 1;
    while (n <= doc.lines && doc.line(n).text !== "b. Anden") n++;
    view.dispatch({ selection: { anchor: doc.line(n).to } });
    view.focus();
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
    await pause(200);
    view.dispatch(view.state.replaceSelection("Tredje"));
    await say(`enter: linjen efter »b. Anden« er »${view.state.doc.line(n + 1).text}«`);
    // Sprog med ordklasser (navneord slået fra) og stavning.
    Object.assign(settings(), { wordClasses: true, styleCheck: false, hiddenWordClasses: ["n"] });
    const { setWordClasses, setHiddenWordClasses } = await import("./editor/wordclasses.ts");
    await setWordClasses(view, true);
    setHiddenWordClasses(view, ["n"]);
    window.dispatchEvent(new CustomEvent("gt-test-tab", { detail: "sprog" }));
    await pause(1500);
    click("Ret stavefejl");
    for (let i = 0; i < 40 && !document.querySelector(".lp-spell-word"); i++) await pause(250);
    await say(`stavning: ${document.querySelector(".lp-spell-word")?.textContent ?? "INGEN"} · forslag: ${[...document.querySelectorAll(".lp-chip")].map((b) => b.textContent).join(", ")}`);
    await pause(2500);
    (document.querySelector(".lp-chip") as HTMLButtonElement | null)?.click();
    await pause(1500);
    await say(`stavning efter ret: »${view.state.doc.toString().match(/Her er en [^,]*/)?.[0]}«, nu: ${document.querySelector(".lp-spell-word")?.textContent ?? "ingen flere"}`);
    await pause(1500);
    Object.assign(settings(), { wordClasses: false, hiddenWordClasses: [] });
    await setWordClasses(view, false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", code: "KeyP", ctrlKey: true, bubbles: true, cancelable: true }));
    await pause(2500);
    await say("print: vist");
    await pause(2000);
    document.querySelector<HTMLElement>(".pv-bar .pv-quiet")?.click();
    await pause(800);
    window.dispatchEvent(new Event("gt-open-settings"));
    await pause(1500);
    await say("indstillinger: vist");
    await pause(2000);
    await say("færdig-runde7");
  } else if (name === "portabel") {
    // Den flytbare udgave (5/10), kørt fra en mappe uden uninstall.exe: ingen »Start med Windows«,
    // og licenserne kan åbnes uden resources-mappen ved siden af.
    const portable = await invoke<boolean>("portable");
    window.dispatchEvent(new Event("gt-open-settings"));
    await pause(1200);
    const autostart = document.querySelector(".settings")?.textContent?.includes("Start med Windows");
    await say(`portabel: ${portable} · Start med Windows vist: ${autostart}`);
    const lic = await invoke("open_licenses").then(() => "åbnet", (e) => `FEJL ${e}`);
    await say(`licenser: ${lic}`);
    await say("færdig-portabel");
  } else if (name === "indstillinger") {
    // Det nye design af Indstillinger (6/10): hver fane, lys og mørk. Skærmbillederne tages
    // udefra (PowerShell er et par sekunder om at starte). Mørk sættes kun i hukommelsen.
    window.dispatchEvent(new Event("gt-open-settings"));
    await pause(1200);
    const tabs = [...document.querySelectorAll<HTMLButtonElement>(".settings [role='tab']")];
    await say(`indstillinger: ${tabs.length} faner: ${tabs.map((t) => t.textContent).join(", ")} · fokus på »${document.activeElement?.textContent}«`);
    for (const dark of [false, true]) {
      document.body.classList.toggle("dark", dark);
      for (const t of tabs) {
        t.click();
        await pause(800);
        const panel = document.getElementById(t.getAttribute("aria-controls") ?? "");
        const box = document.querySelector<HTMLElement>(".settings-box");
        await say(`indstillinger: skærmbillede ${dark ? "moerk" : "lys"}-${t.id.replace("st-tab-", "")} · vinduet ${box?.offsetWidth}x${box?.offsetHeight}, ${panel?.querySelectorAll(".st-row").length} linjer`);
        await pause(6000);
      }
    }
    document.body.classList.remove("dark");
    tabs[0]?.click();
    await say("færdig-indstillinger");
  } else if (name === "kommando-ai") {
    // Et rigtigt AI-kald med en indbygget kommando (/nylæser) på prøveteksten: samtykke, prompt, svar.
    const { runCommand } = await import("./commands/run.ts");
    const { allCommands } = await import("./commands/store.ts");
    const { getCommandHooks } = await import("./editor/setup.ts");
    const hooks = getCommandHooks();
    const c = allCommands().find((x) => x.name === "nylæser" || x.aliases.includes("nylæser"));
    if (!hooks || !c) return void (await say("kommando-ai: FEJL kommandoen findes ikke"));
    const before = view.state.doc.toString();
    view.dispatch({ selection: { anchor: 0 } });
    runCommand(view, c, hooks);
    const click = (re: RegExp) => [...document.querySelectorAll<HTMLButtonElement>("#right button")].find((b) => re.test(b.textContent?.trim() ?? ""))?.click();
    const message = () => document.querySelector("#right .cl-message")?.textContent?.slice(0, 220) ?? "";
    await pause(1500);
    await say(`kommando-ai: først: ${message() || "intet spørgsmål"}`);
    await pause(2000);
    click(/^Send$/);
    await pause(1500);
    // Første gang vises også selve instruksen med Send.
    if (message()) await say(`kommando-ai: derefter: ${message()}`);
    await pause(1500);
    click(/^Send$/);
    for (let i = 0; i < 150 && !document.querySelector(".cr-result"); i++) await pause(1000);
    const result = document.querySelector(".cr-result");
    await say(
      `kommando-ai: svar ${result ? "vist" : "INTET"}, fund ${document.querySelectorAll(".cr-result .cl-card").length}, teksten uændret ${view.state.doc.toString() === before} · ${(result?.textContent ?? document.getElementById("banner")?.textContent ?? "").slice(0, 300)}`,
    );
    await pause(2500);
    await say("færdig-kommando-ai");
  } else if (name === "kommandoer") {
    // Kommandoer med »/« (5/10, strammet op 6/10). Tastning efterlignes som i editoren: hvert
    // tegn går gennem editorens input-handlere (som »/« med markering bruger) og ellers som en
    // transaktion mærket input.type. Tasterne sendes som tastehændelser på editoren.
    const { completionStatus, currentCompletions } = await import("@codemirror/autocomplete");
    const { undo } = await import("@codemirror/commands");
    const type = async (text: string) => {
      for (const ch of text) {
        const { from, to } = view.state.selection.main;
        const insert = () => view.state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + 1 }, userEvent: "input.type", scrollIntoView: true });
        if (!view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, insert))) view.dispatch(insert());
        await pause(120);
      }
    };
    const key = (k: string, extra: KeyboardEventInit = {}) =>
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true, ...extra }));
    const menu = () => `${completionStatus(view.state) ?? "lukket"} (${currentCompletions(view.state).length})`;
    const lineAt = () => view.state.doc.lineAt(view.state.selection.main.head).text;
    const end = () => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n\n\n\n\n\n\n\n\n\n\n\n" }, selection: { anchor: view.state.doc.length + 2 }, scrollIntoView: true });
    const flat = (s: string) => s.replace(/\n/g, " ⏎ ");
    view.focus();

    // 1. »og/eller« og »5/10« åbner ikke menuen. »/« efter et mellemrum gør.
    end();
    await type("og/");
    const midWord = menu();
    await type("eller 5/");
    const afterDigit = menu();
    await type("10 ");
    await type("/");
    await pause(400);
    await say(`kommandoer 1: midt i ord ${midWord}, efter tal ${afterDigit}, efter mellemrum ${menu()}`);
    await pause(1500);

    // 2. /dato + Enter sætter datoen ind, og ét fortryd fjerner den.
    await type("dato");
    await pause(400);
    key("Enter");
    await pause(400);
    const withDate = lineAt();
    undo(view);
    await pause(200);
    await say(`kommandoer 2: »${withDate}« · efter ét fortryd: »${lineAt()}«`);

    // 3. /møde sætter skelettet ind, og Tab går til næste felt.
    end();
    await type("/møde");
    await pause(400);
    key("Enter");
    await pause(500);
    const first = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    key("Tab");
    await pause(200);
    const second = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    await say(`kommandoer 3: første felt »${first}«, efter Tab »${second}«`);
    await pause(1200);
    key("Escape");

    // 4. Markér tre linjer, tast »/sorter« og Enter, som brugeren gør (6/10: »/« slettede markeringen).
    end();
    const from = view.state.doc.length;
    view.dispatch({ changes: { from, insert: "pære\næble\nbanan" }, selection: { anchor: from, head: from + 15 } });
    const before = view.state.doc.toString();
    await type("/");
    await pause(400);
    const kept = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    const opened = menu();
    await type("sorter");
    await pause(400);
    key("Enter");
    await pause(400);
    const sorted = flat(view.state.sliceDoc(from));
    undo(view);
    await pause(200);
    await say(`kommandoer 4: efter »/« er markeringen »${flat(kept)}«, menu ${opened} · sorteret »${sorted}« · ét fortryd giver det gamle: ${view.state.doc.toString() === before}`);

    // 5. Uden markering: »/liste« sidst i afsnittet laver hele afsnittet om.
    end();
    const at = view.state.doc.length;
    view.dispatch({ changes: { from: at, insert: "en\nto\ntre" }, selection: { anchor: at + "en\nto\ntre".length } });
    await type(" /liste");
    await pause(400);
    key("Enter");
    await pause(400);
    await say(`kommandoer 5: afsnittet er nu »${flat(view.state.sliceDoc(at))}«`);

    // 6. /tjek skriver intet i teksten og viser fund fra alle tre tjek.
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n\nHer mangler et tal TK, og det det står to gange.\n" } });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await type("/tjek");
    await pause(400);
    const text = view.state.doc.toString();
    key("Enter");
    await pause(800);
    const cards = [...document.querySelectorAll(".cr-result .cl-card, .cr-result .cl-quote")].map((e) => (e.textContent ?? "").slice(0, 60));
    await say(`kommandoer 6: teksten uden »/tjek« ${view.state.doc.toString() === text.replace("/tjek", "")}, ${cards.length} fund: ${cards.slice(0, 4).join(" | ")}`);
    await pause(1500);

    // 7. Fanen Kommandoer: feltet til en ny kommando øverst, og det markerede som skabelon.
    const { allCommands } = await import("./commands/store.ts");
    // Fanen bor i Indstillinger (7/10).
    window.dispatchEvent(new CustomEvent("gt-open-settings", { detail: "kommandoer" }));
    await pause(800);
    const box = document.querySelector(".settings .cmd-new");
    await say(`kommandoer 7: ${document.querySelectorAll(".settings .cmd-row").length} rækker, ${allCommands().length} kommandoer, felt til ny kommando ${box?.querySelector("textarea") ? "med AI" : box ? "uden AI" : "MANGLER"} · ${(box?.textContent ?? "").slice(0, 120)}`);
    const sig = view.state.doc.length;
    view.dispatch({ changes: { from: sig, insert: "\n\nMed venlig hilsen\nKim" }, selection: { anchor: sig + 2, head: sig + 23 } });
    const byKey = (k: string) => document.querySelector<HTMLElement>(`#right [data-key="${k}"]`);
    // Fra højreklik på markeringen (9/10, før et link i fanen).
    window.dispatchEvent(new Event("gt-template-from-selection"));
    await pause(600);
    const proposalName = (byKey("proposal-name") as HTMLInputElement | null)?.value;
    await say(`kommandoer 8: forslag /${proposalName} · ${(document.querySelector(".settings .cmd-form")?.textContent ?? "").slice(0, 200)}`);
    await pause(1500);
    byKey("back")?.click();
    await pause(400);

    // 9. Beskriv en kommando med egne ord (kun med AI-hjælp slået til). Gemmes ikke.
    const area = byKey("describe") as HTMLTextAreaElement | null;
    if (area) {
      area.value = "sæt en tom tjekliste med tre punkter ind";
      area.dispatchEvent(new Event("input"));
      byKey("suggest")?.click();
      await pause(1500);
      // Første gang spørges der, om beskrivelsen må sendes.
      byKey("consent-yes")?.click();
      for (let i = 0; i < 120 && !byKey("proposal-name") && !document.querySelector("#left .cl-message"); i++) await pause(1000);
      const name = (byKey("proposal-name") as HTMLInputElement | null)?.value;
      await say(`kommandoer 9: ${name ? `forslag /${name}` : "INTET forslag"} · ${(document.querySelector(".settings .cmd-form")?.textContent ?? "").slice(0, 260)}`);
      await pause(2500);
      byKey("back")?.click();
    } else {
      await say("kommandoer 9: sprunget over, AI-hjælp er ikke slået til");
    }

    // 10. Tabeller vises og redigeres som tabeller (6/10).
    end();
    const tAt = view.state.doc.length;
    view.dispatch({ changes: { from: tAt, insert: "| Måling | Vægt | Hvorfor |\n|---|---:|---|\n| Læst dybt | 24 % | Tættest på **blev den læst?** |\n| Videre | 16 % | Lyst til mere |\n\nEfter tabellen." } });
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    await pause(600);
    const tbox = document.querySelector<HTMLElement>(".gt-tablebox");
    const cellsText = [...(tbox?.querySelectorAll("th, td") ?? [])].map((c) => c.textContent).join(" | ");
    await say(`kommandoer 10: tabel vist ${Boolean(tbox)}, celler: ${cellsText}`);
    tbox?.scrollIntoView({ block: "center" });
    await say("kommandoer 10: skærmbillede af tabellen");
    // Skærmbilledet tages udefra, og PowerShell er et par sekunder om at starte.
    await pause(6000);
    // Visuel redigering (6/10): skriv i en celle, Tab videre, Enter i sidste række giver en ny.
    const docLine = (needle: string) => view.state.doc.toString().split("\n").find((l) => l.includes(needle)) ?? "MANGLER";
    const cell = tbox?.querySelectorAll<HTMLElement>("td")[2];
    if (cell) {
      cell.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(cell);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.execCommand("insertText", false, " Nu rettet.");
    }
    await pause(400);
    const rowAfter = docLine("Læst dybt");
    const tableBox = document.querySelector<HTMLElement>(".gt-tablebox");
    const keyIn = (k: string) => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    keyIn("Tab");
    await pause(200);
    const afterTab = (document.activeElement as HTMLElement | null)?.textContent;
    const lastRowCell = tableBox?.querySelectorAll<HTMLElement>("tbody tr:last-child td")[0];
    lastRowCell?.focus();
    keyIn("Enter");
    await pause(500);
    const rows = document.querySelectorAll(".gt-tablebox tbody tr").length;
    const stillTable = Boolean(document.querySelector(".gt-tablebox"));
    await say(`kommandoer 10: rækken i filen »${rowAfter}« · efter Tab står fokus i »${afterTab}« · efter Enter i sidste række: ${rows} rækker, stadig tabel ${stillTable}, fokus i ${document.activeElement?.tagName}`);
    // /tabel uden markering: en tom tabel med fokus i første celle.
    keyIn("Escape");
    end();
    const tablesBefore = document.querySelectorAll(".gt-tablebox").length;
    view.focus();
    await type("/tabel");
    await pause(400);
    key("Enter");
    await pause(800);
    await say(`kommandoer 10: /tabel gav ${document.querySelectorAll(".gt-tablebox").length - tablesBefore} ny tabel, fokus i ${document.activeElement?.tagName} med pladsholder »${(document.activeElement as HTMLElement | null)?.dataset.placeholder ?? ""}«`);
    await pause(1500);

    // 11. Listepunkter (6/10): teksten står stille, når markøren går ind, og markeringen følger ordene.
    end();
    const lAt = view.state.doc.length;
    const item = "Fastholdelse dækker i praksis over det samme som læst dybt, og derfor dropper vi den som selvstændigt parameter i den næste udgave.";
    view.dispatch({ changes: { from: lAt, insert: `- ${item}\n- Andet punkt\n\nEfter listen.` } });
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    await pause(400);
    const wordX = () => view.coordsAtPos(lAt + 2)?.left ?? -1;
    const outside = wordX();
    view.dispatch({ selection: { anchor: lAt + 10 } });
    await pause(400);
    const inside = wordX();
    const selFrom = lAt + item.indexOf("læst");
    view.dispatch({ selection: { anchor: selFrom, head: selFrom + 40 }, scrollIntoView: true });
    await pause(500);
    const marks = [...document.querySelectorAll<HTMLElement>(".gt-selection")].map((m) => `${Math.round(m.offsetLeft)}+${Math.round(m.offsetWidth)}`);
    const textLeft = Math.round((view.coordsAtPos(lAt + 2)?.left ?? 0) - view.scrollDOM.getBoundingClientRect().left);
    await say(`kommandoer 11: første ord x ${outside.toFixed(1)} uden for, ${inside.toFixed(1)} på linjen · markering ${marks.join(", ")} · tekstens venstre kant ${textLeft}`);
    // Shift+Enter i punktet: fortsættelsen flugter med punktets tekst (6/10).
    const itemEnd = view.state.doc.lineAt(lAt).to;
    view.dispatch({ selection: { anchor: itemEnd } });
    key("Enter", { shiftKey: true });
    await pause(200);
    await type("Fortsat linje i punktet.");
    await pause(300);
    const contPos = view.state.selection.main.head - "Fortsat linje i punktet.".length;
    await say(`kommandoer 11: Shift+Enter gav »${JSON.stringify(view.state.doc.lineAt(contPos).text.slice(0, 12))}«, fortsættelsen x ${(view.coordsAtPos(contPos)?.left ?? -1).toFixed(1)}, punktets tekst x ${wordX().toFixed(1)}`);
    view.dispatch({ selection: { anchor: selFrom, head: selFrom + 40 }, scrollIntoView: true });
    await pause(500);
    await say("kommandoer 11: skærmbillede af markeringen");
    // Skærmbilledet tages udefra, og PowerShell er et par sekunder om at starte.
    await pause(6000);

    // 12. En tabel sat ind fra en terminal (6/10): rykket ind og med brudte rækker.
    end();
    const before12 = document.querySelectorAll(".gt-tablebox").length;
    const data = new DataTransfer();
    data.setData("text/plain", "| Måling | Vægt | Hvorfor |\n    | --- | --- | --- |\n    | Læst dybt | 24 % | Men lange\n  artikler taber |\n    | Videre | 16 % | Lyst til mere |");
    view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    await pause(300);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n\nEfter." }, selection: { anchor: view.state.doc.length + 8 }, scrollIntoView: true });
    await pause(500);
    const pastedRows = view.state.doc.toString().split("\n").filter((l) => l.startsWith("| Læst dybt"));
    await say(`kommandoer 12: tabeller før ${before12}, efter ${document.querySelectorAll(".gt-tablebox").length} · rækken: »${pastedRows[pastedRows.length - 1] ?? "MANGLER"}«`);
    await say("færdig-kommandoer");
  } else if (name === "ro") {
    // Ro på (5/10): F11 giver fuld skærm uden spalter, markøren skjules ved tastning, Esc
    // bringer alt tilbage. Wifi røres aldrig i en testkørsel (ro.rs).
    const key = (k: string, target: EventTarget = window) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true }));
    const state = () => {
      const left = document.getElementById("left");
      return `ro ${document.body.classList.contains("ro")}, venstre spalte ${left ? getComputedStyle(left).visibility : "?"}, bredde ${window.innerWidth}x${window.innerHeight}, markør ${getComputedStyle(view.contentDOM).cursor}`;
    };
    document.body.classList.add("left-pinned", "right-pinned");
    await pause(600);
    await say(`ro før: ${state()}`);
    key("F11");
    await pause(1500);
    // Wifi-knappen (6/10): synlig i Ro på. Klikket to gange, så indstillingen står som før.
    const wifi = document.getElementById("ro-wifi");
    const wifiState = () => (wifi ? `${getComputedStyle(wifi).display}/${getComputedStyle(wifi).opacity}, slukket ${wifi.getAttribute("aria-pressed")}, »${wifi.title}«` : "MANGLER");
    const wifiBefore = wifiState();
    wifi?.click();
    await pause(600);
    const wifiClicked = wifiState();
    wifi?.click();
    await pause(600);
    await say(`ro wifi: ${wifiBefore} · efter klik: ${wifiClicked} · efter to klik: ${wifiState()}`);
    key("a", view.contentDOM);
    await pause(500);
    await say(`ro til: ${state()} · wifi mens der skrives: ${wifiState()}`);
    // Spalterne kan hentes frem i Ro på med Ctrl+W og Ctrl+E (6/10), selv om de er fastgjort.
    const shownLeft = () => {
      const p = document.querySelector<HTMLElement>(".panel-left");
      return p ? `${getComputedStyle(p).opacity === "1" ? "fremme" : "skjult"}${p.inert ? " (inert)" : ""}` : "?";
    };
    const ctrl = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, ctrlKey: true, bubbles: true, cancelable: true }));
    const leftBefore = shownLeft();
    ctrl("w");
    await pause(600);
    const leftOpen = shownLeft();
    ctrl("w");
    await pause(600);
    await say(`ro spalte: før ${leftBefore}, Ctrl+W ${leftOpen}, Ctrl+W igen ${shownLeft()}, stadig fastgjort ${document.body.classList.contains("left-pinned")}`);
    await pause(1500);
    window.dispatchEvent(new MouseEvent("mousemove", { movementX: 5, movementY: 2, bubbles: true }));
    await pause(200);
    const afterMove = getComputedStyle(view.contentDOM).cursor;
    key("Escape");
    await pause(1500);
    await say(`ro fra: ${state()} · markør efter musebevægelse: ${afterMove}`);
    document.body.classList.remove("left-pinned", "right-pinned");
    await say("færdig-ro");
  } else if (name === "titellinje") {
    // Titellinjen i programmets farve (windows.rs). Lys, så mørk; skærmbilledet tages udefra.
    await pause(800);
    await say("titellinje: lys");
    await pause(2500);
    document.body.classList.add("dark");
    await invoke("set_titlebar", { theme: "moerk" });
    await pause(500);
    await say("titellinje: moerk");
    await pause(2500);
    await say("færdig-titellinje");
  } else if (name === "design") {
    // Visuel gennemgang (5/10): de flader, rundturen ikke viser. Kun i hukommelsen.
    const key = (k: string, extra: KeyboardEventInit = {}) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, bubbles: true, cancelable: true, ...extra }));
    const shot = async (label: string, ms = 1800) => {
      await pause(500);
      await say(`design: ${label}`);
      await pause(ms);
    };
    view.dispatch({ selection: { anchor: view.state.doc.line(5).from + 10 } });
    view.focus();
    await shot("lys");
    key("f", { ctrlKey: true });
    await shot("soeg");
    key("f", { ctrlKey: true });
    // Versioner bor i venstre spalte fra 6/10.
    [...document.querySelectorAll<HTMLButtonElement>("#left .rp-tab")].find((b) => /Versioner|Versions/.test(b.textContent ?? ""))?.click();
    await shot("versioner");
    window.dispatchEvent(new CustomEvent("gt-test-tab", { detail: "noter" }));
    await shot("fodnoter");
    key("d", { ctrlKey: true });
    await shot("fokus");
    key("d", { ctrlKey: true });
    document.body.classList.add("dark");
    await invoke("set_titlebar", { theme: "moerk" });
    await pause(300);
    document.body.classList.add("dark");
    await shot("moerk");
    document.body.classList.remove("dark");
    await invoke("set_titlebar", { theme: "lys" });
    notify("Kopieret som formateret tekst.");
    await shot("kvittering", 1200);
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => /Skriv til Gode Medier/.test(b.title || b.getAttribute("aria-label") || ""))?.click();
    await shot("feedback");
    await say("færdig-design");
  } else if (name === "rulning") {
    // 5/10: scrollbaren ses kun under rulning; Ctrl+W venstre spalte, Ctrl+E højre.
    const scroller = view.scrollDOM;
    const shows = () => scroller.classList.contains("is-scrolling") && getComputedStyle(scroller).scrollbarColor;
    await pause(500);
    await say(`rulning: i ro ${shows() || "skjult"}`);
    scroller.scrollTop += 200;
    await pause(150);
    await say(`rulning: under rulning ${shows() || "skjult"}`);
    await pause(1300);
    await say(`rulning: efter ${shows() || "skjult"}`);
    const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, ctrlKey: true, bubbles: true, cancelable: true }));
    const pins = () => `venstre ${document.body.classList.contains("left-pinned")}, højre ${document.body.classList.contains("right-pinned")}`;
    const start = pins();
    key("w");
    await pause(300);
    const afterW = pins();
    key("e");
    await pause(300);
    const afterE = pins();
    key("w");
    key("e");
    await pause(300);
    await say(`paneler: start ${start} · Ctrl+W ${afterW} · Ctrl+E ${afterE} · tilbage ${pins()}`);
    await say("færdig-rulning");
  } else if (name === "overskrifter") {
    // 5/10: »## « efter »## 1. …« giver »## 2. «. Inputhandleren kaldes som ved et tastetryk.
    view.dispatch({ changes: { from: 0, insert: "## 1. Første\n\ntekst\n\n##" } });
    const at = "## 1. Første\n\ntekst\n\n##".length;
    view.dispatch({ selection: { anchor: at } });
    for (const h of view.state.facet(EditorView.inputHandler)) {
      if (h(view, at, at, " ", () => view.state.update({ changes: { from: at, insert: " " } }))) break;
    }
    await pause(300);
    await say(`overskrifter: »${view.state.doc.line(5).text}«`);
    await say("færdig-overskrifter");
  } else if (name === "autonavn") {
    // 5/10: en ny tekst får navn efter første linje, uden at blive åbnet igen.
    view.dispatch({ changes: { from: 0, insert: "# Broen over Bæltet" }, selection: { anchor: 19 }, userEvent: "input.type" });
    await pause(2500);
    const before = document.title;
    view.dispatch({ changes: { from: 19, insert: "\n\nFørste afsnit." }, selection: { anchor: 35 }, userEvent: "input.type" });
    await pause(4000);
    await say(`autonavn: markør ${view.state.selection.main.head}, tekst ${view.state.doc.length} tegn (før: ${before.length})`);
    await say("færdig-autonavn");
  } else if (name === "rundtur") {
    // Engelsk og dansk (5/10): de vigtigste flader efter hinanden. Køres med GT_SPROG=en eller da.
    const key = (k: string, extra: KeyboardEventInit = {}) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true, ...extra }));
    await pause(800);
    await say("rundtur: skrivning");
    await pause(2200);
    window.dispatchEvent(new CustomEvent("gt-test-tab", { detail: "claude" }));
    // Spørgsmålet før første afsendelse (fanen Input, 5/10). Svaret, brugeren har givet, lægges
    // tilbage bagefter, og der sendes intet: Annullér.
    const okKeys = Object.keys(localStorage).filter((k) => k.startsWith("gt-ai-ok-"));
    const saved = okKeys.map((k) => [k, localStorage.getItem(k)] as const);
    for (const k of okKeys) localStorage.removeItem(k);
    window.dispatchEvent(new CustomEvent("gt-claude", { detail: "factcheck" }));
    await pause(1200);
    await say("rundtur: input");
    await pause(2200);
    [...document.querySelectorAll("button")].find((b) => ["Annullér", "Cancel"].includes(b.textContent?.trim() ?? ""))?.click();
    for (const [k, v] of saved) if (v !== null) localStorage.setItem(k, v);
    await pause(300);
    window.dispatchEvent(new CustomEvent("gt-test-tab", { detail: "sprog" }));
    await pause(1200);
    await say("rundtur: sprog");
    await pause(2200);
    window.dispatchEvent(new Event("gt-open-settings"));
    await pause(1200);
    await say("rundtur: indstillinger");
    await pause(2200);
    document.querySelector<HTMLElement>(".settings")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await pause(500);
    key("F1");
    await pause(800);
    await say("rundtur: genveje");
    await pause(2200);
    key("F1");
    await pause(500);
    key("r", { code: "KeyR", ctrlKey: true });
    await pause(2500);
    await say("rundtur: print");
    await pause(2200);
    await say("færdig-rundtur");
  } else if (name === "link-haand") {
    // 5/10: hånden ved Ctrl over et link. Syntetiske hændelser, ingen rigtig mus eller tast.
    view.dispatch({ changes: { from: 0, insert: "Se [Gode Medier](https://godemedier.dk) her.\n\n" } });
    await pause(300);
    const at = view.coordsAtPos(8);
    const move = (ctrlKey: boolean) =>
      at && view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { clientX: at.left + 2, clientY: at.top + 4, ctrlKey, bubbles: true }));
    const cursor = () => getComputedStyle(view.contentDOM).cursor;
    move(false);
    const plain = cursor();
    move(true);
    const withCtrl = cursor();
    view.contentDOM.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", bubbles: true }));
    await say(`markør uden Ctrl: ${plain}, med Ctrl over link: ${withCtrl}, efter Ctrl slippes: ${cursor()}`);
    await say("færdig-link-haand");
  } else if (name === "kvittering") {
    // 5/10: kvitteringen efter Skær kunne ikke lukkes og fulgte med til næste tekst.
    const { showBanner, clearTextBanners } = await import("./ui/banner.ts");
    showBanner("Dæmpet 2 steder, 2 ord. Klik i dæmpet tekst for at fjerne dæmpningen.", [{ label: "Fortryd", run: () => {} }, { label: "Flyt dæmpet til fraklip", run: () => {} }], { closable: true, perText: true });
    await pause(500);
    const box = document.getElementById("banner");
    await say(`kvittering: ${box && !box.hidden ? "vist" : "SKJULT"}, luk-knap: ${box?.querySelector(".banner-close") ? "ja" : "NEJ"}`);
    await pause(1500);
    box?.querySelector<HTMLButtonElement>(".banner-close")?.click();
    await pause(300);
    await say(`efter ×: ${box?.hidden ? "lukket" : "STADIG VIST"}`);
    showBanner("Dæmpet 1 sted, 3 ord.", [{ label: "Fortryd", run: () => {} }], { closable: true, perText: true });
    clearTextBanners();
    await pause(300);
    await say(`efter ny tekst: ${box?.hidden ? "væk" : "STADIG VIST"}`);
    await say("færdig-kvittering");
  } else if (name === "fraklip-traek") {
    // 5/10: et afsnit med en note trukket til fraklip, en halv note, der ikke må deles, og
    // fraklip, der ikke kan slettes fra bunden af teksten. Syntetiske hændelser, ingen rigtig mus.
    window.dispatchEvent(new CustomEvent("gt-test-tab", { detail: "fraklip" }));
    const doc = () => view.state.doc.toString();
    const para = doc().indexOf("Tallet skal tjekkes");
    const paraEnd = doc().indexOf("udgivelse.") + "udgivelse.".length;
    // Træk afsnittet (markeret helt) over i højre spalte.
    view.dispatch({ selection: { anchor: para, head: paraEnd } });
    const dt = new DataTransfer();
    dt.setData("text/plain", doc().slice(para, paraEnd));
    document.querySelector("#right")?.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    await pause(800);
    await say(`afsnit til fraklip: teksten har det ${doc().includes("Tallet skal tjekkes <!--") && doc().indexOf("Tallet skal tjekkes") < doc().indexOf("gt:parkeret") ? "STADIG" : "ikke længere"}, fraklip: ${(doc().match(/gt:parkeret/g) ?? []).length}`);
    // Markering, der slutter midt i den usynlige note: hele noten følger med.
    const t = doc();
    const n = t.indexOf("Her er en");
    view.dispatch({ selection: { anchor: n, head: t.indexOf("rettes") } });
    const { cmd } = await import("./editor/shortcuts.ts");
    cmd.park(view);
    await pause(500);
    // Slet alt fra bunden: fraklip skal blive.
    const before = (doc().match(/gt:parkeret/g) ?? []).length;
    view.dispatch({ changes: { from: doc().indexOf("Romertal"), to: doc().length }, userEvent: "delete.selection" });
    await pause(500);
    await say(`slet fra bunden: fraklip før ${before}, efter ${(doc().match(/gt:parkeret/g) ?? []).length}`);
    await pause(2000);
    await say("færdig-fraklip-traek");
  } else if (name === "input-fanen") {
    // Research og faktatjek, som de står gemt i filen (variant A, 7/10). Skærmbilledet tages udefra.
    window.dispatchEvent(new CustomEvent("gt-test-tab", { detail: "claude" }));
    await pause(1500);
    await say(`input-fanen: ${document.querySelectorAll(".cl-item").length} fund, ${document.querySelectorAll(".cl-claim").length} påstande`);
    await pause(4000);
    await say("færdig-input-fanen");
  } else if (name === "splash-ren") {
    // Toppen af godemedier.dk (5/10): den enkleste visning, kun teksten. Køres uden
    // GT_TEST_PANELS, så panelerne er skjult.
    const { setWordClasses } = await import("./editor/wordclasses.ts");
    const { setStyleCheck } = await import("./editor/styleCheck.ts");
    Object.assign(settings(), { wordClasses: false, styleCheck: false });
    await setWordClasses(view, false);
    setStyleCheck(view, false);
    // Kun visningen: fastgørelsen ligger i localStorage, som brugerens eget program deler. Skriften som
    // på sidens andre billeder, uanset hvad brugeren har valgt.
    document.body.classList.remove("left-pinned", "left-open", "right-pinned", "right-open");
    document.documentElement.style.setProperty("--skrift", '"Literata"');
    // Uden tekstmarkør (5/10, til videoen): markøren øverst og fokus væk fra teksten.
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.contentDOM.blur();
    await pause(200);
    view.scrollDOM.scrollTop = 0;
    await pause(1500);
    await say("splash: ren");
    await pause(2500);
    await say("færdig-splash-ren");
  } else if (name === "splash") {
    // Skærmbilleder til godemedier.dk (5/10, på »Mit nye inputapparat« fra 7/10). Venstre spalte
    // viser dispositionen, ikke brugerens biblioteker. Indstillinger ændres kun i hukommelsen: alle
    // ordklasser farves, og skriften er den samme som på »splash-ren«, uanset brugerens valg.
    const click = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)?.click();
    const { setWordClasses, setHiddenWordClasses } = await import("./editor/wordclasses.ts");
    const { setStyleCheck } = await import("./editor/styleCheck.ts");
    Object.assign(settings(), { wordClasses: false, styleCheck: false, hiddenWordClasses: [] });
    setHiddenWordClasses(view, []);
    document.documentElement.style.setProperty("--skrift", '"Literata"');
    await setWordClasses(view, false);
    setStyleCheck(view, false);
    click("Disposition");
    window.dispatchEvent(new CustomEvent("gt-test-tab", { detail: "fraklip" }));
    view.dispatch({ selection: { anchor: view.state.doc.line(5).from + 20 } });
    view.focus();
    await pause(1500);
    await say("splash: skrivning");
    await pause(2500);
    Object.assign(settings(), { wordClasses: true, styleCheck: true });
    await setWordClasses(view, true);
    setStyleCheck(view, true);
    window.dispatchEvent(new CustomEvent("gt-test-tab", { detail: "sprog" }));
    await pause(2500);
    window.dispatchEvent(new Event("gt-style"));
    await pause(800);
    await say("splash: sprog");
    await pause(2500);
    Object.assign(settings(), { wordClasses: false, styleCheck: false });
    await setWordClasses(view, false);
    setStyleCheck(view, false);
    view.dispatch({ selection: { anchor: 0 } });
    window.dispatchEvent(new CustomEvent("gt-test-tab", { detail: "claude" }));
    window.dispatchEvent(new CustomEvent("gt-claude", { detail: "factcheck" }));
    let running = false;
    for (let i = 0; i < 600; i++) {
      await pause(500);
      const send = [...(document.getElementById("banner")?.querySelectorAll("button") ?? [])].find((x) => x.textContent === "Send");
      if (send) send.click();
      if (document.querySelector(".cl-running")) {
        if (!running) {
          await pause(4000);
          await say("splash: taenker");
          await pause(1500);
        }
        running = true;
      } else if (running) break;
    }
    await pause(1200);
    await say(`splash: faktatjek (${document.querySelectorAll(".cl-claim").length} påstande)`);
    await pause(2500);
    await say("færdig-splash");
  } else if (name === "stavekontrol") {
    // 5/10: »viser den fejl?« To stavefejl og resten rigtigt dansk. Scriptet udenfor tager et
    // billede og højreklikker med den rigtige mus på »tekts« for at se forslagene.
    const text = "\n\nDette er en tekts med stavefjel, men resten af sætningen er rigtigt dansk.";
    view.dispatch({ changes: { from: view.state.doc.length, insert: text }, selection: { anchor: view.state.doc.length + text.length }, scrollIntoView: true, userEvent: "input.type" });
    view.focus();
    await pause(2500);
    const at = view.state.doc.toString().lastIndexOf("tekts") + 2;
    const c = view.coordsAtPos(at);
    await say(`stavekontrol: skrevet, ord ved ${Math.round(c?.left ?? 0)},${Math.round(((c?.top ?? 0) + (c?.bottom ?? 0)) / 2)} dpr ${window.devicePixelRatio}`);
    await pause(9000);
    await say("færdig-stavekontrol");
  } else if (name === "nedbrud") {
    // Efter GT_PANIK: kommer spørgsmålet om at sende fejlloggen? Svar »Nej tak«, så intet sendes.
    for (let i = 0; i < 40; i++) {
      await pause(250);
      const b = document.getElementById("banner");
      if (b && !b.hidden && /gik ned/.test(b.textContent ?? "")) {
        await say(`nedbrud: spørger (»${b.textContent?.slice(0, 120)}«)`);
        await pause(2500);
        [...b.querySelectorAll("button")].find((x) => x.textContent === "Nej tak")?.click();
        await pause(800);
        return void say("færdig-nedbrud");
      }
    }
    await say("nedbrud: INTET spørgsmål efter 10 s");
    await say("færdig-nedbrud");
  } else if (name === "faktatjek") {
    // 4/10: »vis med skærmbilleder, hvordan faktatjekket virker«. Scriptet udenfor tager
    // billeder, når loggen siger »faktatjek: <trin>«. Rigtigt kald til den valgte sprogmodel.
    window.dispatchEvent(new CustomEvent("gt-claude", { detail: "show" }));
    await pause(800);
    await say("faktatjek: fanen åben");
    await pause(1500);
    window.dispatchEvent(new CustomEvent("gt-claude", { detail: "factcheck" }));
    let sawRunning = false;
    for (let i = 0; i < 600; i++) {
      await pause(500);
      const send = [...(document.getElementById("banner")?.querySelectorAll("button") ?? [])].find((x) => x.textContent === "Send");
      if (send) {
        await say("faktatjek: spørger om lov");
        await pause(1500);
        send.click();
        continue;
      }
      const running = document.querySelector(".cl-running");
      if (running && !sawRunning) {
        sawRunning = true;
        await pause(4000);
        await say(`faktatjek: kører (${running.textContent?.slice(0, 80)})`);
        await pause(1500);
      }
      if (sawRunning && !running) {
        await pause(800);
        const claims = document.querySelectorAll(".cl-claim").length;
        await say(`faktatjek: færdig, ${claims} kort i fanen`);
        await pause(1500);
        // Rul ned i fanen til næste billede.
        const body = document.querySelector(".cl-claim")?.closest("[class*='rp-body'], .rp-content, .rp-scroll") as HTMLElement | null;
        (body ?? document.querySelector(".cl-claim")?.parentElement)?.scrollBy(0, 500);
        await pause(800);
        await say("faktatjek: rullet ned");
        await pause(1500);
        return void say("færdig-faktatjek");
      }
    }
    await say("faktatjek: INTET SVAR efter 300 s");
  } else if (name === "dobbeltklik") {
    // 4/10: dobbeltklik på et ord i en overskrift markerede hele linjen og lidt af den næste.
    // Markøren starter et andet sted, så »##« er skjult, når der klikkes første gang.
    const doc = view.state.doc;
    let line = doc.line(1);
    for (let n = 2; n <= doc.lines; n++) if (doc.line(n).text.startsWith("## ") && doc.line(n).text.length > 12) { line = doc.line(n); break; }
    const word = line.text.indexOf(" ", 6) + 1;
    view.dispatch({ selection: { anchor: doc.length }, scrollIntoView: true });
    view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    await pause(400);
    const c = view.coordsAtPos(line.from + word + 2);
    if (!c) return void say("dobbeltklik: ingen koordinater");
    const x = c.left + 1, y = (c.top + c.bottom) / 2;
    const target = document.elementFromPoint(x, y) ?? view.contentDOM;
    const fire = (type: string, detail: number) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1, detail, view: window }));
    fire("mousedown", 1); fire("mouseup", 1); fire("click", 1);
    // Som en rigtig hånd: 200 ms mellem klikkene, efter at »##« er kommet frem (livePreview thaw, 100 ms).
    await pause(200);
    fire("mousedown", 2); fire("mouseup", 2); fire("click", 2); fire("dblclick", 2);
    await pause(300);
    const s = view.state.selection.main;
    await say(`dobbeltklik: linje »${line.text}«, markeret »${doc.sliceString(s.from, s.to).replace(/\n/g, "⏎")}« (${s.from}-${s.to}, linjen er ${line.from}-${line.to})`);
    await pause(1500);
  } else if (name === "indryk") {
    // Afsnit som i bøger, kun på skærmen (indstillingen gemmes ikke: testen deler brugerens fil).
    const { setParagraphs } = await import("./editor/paragraphs.ts");
    view.dispatch({ selection: { anchor: 0 } });
    setParagraphs(view, true);
    await pause(400);
    await say(`indryk: ${view.dom.querySelectorAll(".gt-indent").length} rykket ind, ${view.dom.querySelectorAll(".gt-gap").length} tomme linjer klappet sammen`);
    await pause(2500);
  } else if (name === "link") {
    // Velkomsthilsenen (delbar udgave 3/10): Ctrl+klik på linket til vejledningen åbner den.
    await pause(2500);
    const { linkAt } = await import("./editor/links.ts");
    const line = view.state.doc.toString().split("\n").find((l) => l.includes("](S"));
    const target = line ? linkAt(line, line.indexOf("](") - 2) : null;
    await say(`link fundet: ${target ?? "NEJ"}`);
    if (target) window.dispatchEvent(new CustomEvent("gt-open-link", { detail: target }));
    await pause(2500);
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await say(`link: titel nu »${await getCurrentWindow().title()}«, ${view.state.doc.line(1).text}`);
  } else if (name === "zoom") {
    await zoomScenario(view);
  } else if (name === "udtryk") {
    // ADR-0037 (8/10): hele fladen i de tre udseender. Skærmbillederne tages udefra, når loggen
    // siger »skærmbillede <navn>«. Udseendet sættes kun i vinduet, ikke i indstillingerne.
    const { showTheme } = await import("./ui/theme.ts");
    const key = (k: string, extra: KeyboardEventInit = {}) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
    const shot = async (label: string) => {
      await pause(900);
      await say(`skærmbillede ${label}`);
      await pause(6000);
    };
    const panels = (detail: { left?: string; right?: string }) => window.dispatchEvent(new CustomEvent("gt-test-panels", { detail }));
    view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, 400) } });
    view.focus();
    // Linjebredden (ADR-0037): så mange tegn står der faktisk på en lang linje i den valgte skrift.
    await document.fonts.ready;
    await pause(500);
    const long = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find((l) => (l.textContent ?? "").length > 300);
    if (long) {
      const r = document.createRange();
      r.selectNodeContents(long);
      const rows = new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size || 1;
      await say(`linje: ca. ${Math.round((long.textContent ?? "").length / rows)} tegn pr. linje, --linjelaengde ${getComputedStyle(document.documentElement).getPropertyValue("--linjelaengde")}`);
    }
    for (const theme of ["lys", "moerk", "aften"] as const) {
      showTheme(theme);
      panels({});
      await shot(`${theme}-flade`);
      panels({ left: "bibliotek", right: "sprog" });
      await shot(`${theme}-spalter`);
      panels({});
      window.dispatchEvent(new Event("gt-open-settings"));
      await pause(900);
      [...document.querySelectorAll<HTMLButtonElement>(".settings [role='tab']")].find((t) => t.textContent?.trim() === "Tekst")?.click();
      await shot(`${theme}-indstillinger`);
      document.querySelector<HTMLButtonElement>(".settings:not([hidden]) .settings-head button")?.click();
      await pause(500);
      key("o", { code: "KeyO", ctrlKey: true });
      await shot(`${theme}-hurtig`);
      key("Escape", { code: "Escape" });
      document.querySelector<HTMLElement>("#overlay input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await pause(500);
    }
    showTheme("lys");
  } else if (name === "bibliotek") {
    // ADR-0038 (8/10): status, #tags, chips, søgning og »I gang« på kopier i tests/private/proeve/scen.
    // Filerne er lagt til af scriptet; her sættes status gennem Rust, som biblioteket gør.
    const dir = (path ?? "").replace(/\\[^\\]+$/, "");
    for (const [file, status] of [["kronik.md", "igang"], ["ansoegning.md", "gennemsyn"], ["ide.md", "ide"], ["opgave.md", "faerdig"]]) {
      await invoke("set_status", { path: `${dir}\\${file}`, status }).catch((e) => say(`status ${file}: FEJL ${String(e)}`));
    }
    await pause(1500);
    window.dispatchEvent(new CustomEvent("gt-test-panels", { detail: { left: "bibliotek" } }));
    await pause(1500);
    const dots = document.querySelectorAll(".lib-row .lib-dot:not([data-none])").length;
    await say(`bibliotek: ${dots} prikker, ${document.querySelectorAll(".lib-chip").length} chips`);
    const shot = async (label: string) => {
      await pause(900);
      await say(`skærmbillede ${label}`);
      await pause(6000);
    };
    await shot("bib-mappe");
    [...document.querySelectorAll<HTMLButtonElement>(".lib-chip")].find((c) => c.textContent === "Undervejs")?.click();
    const started = Date.now();
    for (let i = 0; i < 1200 && document.querySelector(".lib-empty")?.textContent?.startsWith("Henter"); i++) await pause(250);
    await say(`indeks: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    await say(`undervejs: ${[...document.querySelectorAll(".lib-row .lib-name")].map((n) => n.textContent).join(", ")}`);
    await shot("bib-igang");
    [...document.querySelectorAll<HTMLButtonElement>(".lib-chip")].find((c) => c.getAttribute("aria-pressed") === "true")?.click();
    const search = document.querySelector<HTMLInputElement>(".lib-search");
    if (search) {
      search.value = "#kronik";
      search.dispatchEvent(new Event("input"));
    }
    await pause(1200);
    await say(`søgning: ${[...document.querySelectorAll(".lib-row .lib-name")].map((n) => n.textContent).join(", ")}`);
    await shot("bib-soeg");
    document.querySelector<HTMLElement>(".lib-row .lib-dot")?.click();
    await shot("bib-status");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(new Event("gt-open-settings"));
    await pause(900);
    await shot("bib-indstillinger");
  } else if (name === "noter") {
    // ADR-0039 (8/10): tre noter på skrivebordet i testmappen (GT_NOTER_DIR). Én skrevet i, én grøn og
    // rullet op, én blå og holdt øverst. Skærmbilledet tages af hele skærmen udefra.
    const { emitTo } = await import("@tauri-apps/api/event");
    for (let i = 0; i < 3; i++) {
      await invoke("note_new");
      await pause(1500);
    }
    await emitTo("note-1", "gt-test-note", { text: "Ring til forvaltningen før kl. 12\n\n– budgettal for 2024\n– hvem skrev høringssvaret?\n– spørg om kablet til land" });
    await emitTo("note-2", "gt-test-note", { text: "Idé: podcast om lokalpolitik\n\nSeks afsnit om byrådet.", color: "groen", roll: true });
    await emitTo("note-3", "gt-test-note", { text: "Denne uge\n\n- [ ] Kronik til redaktionen\n- [x] Ansøgning til fonden", color: "blaa", pin: true });
    await pause(2500);
    await say("skærmbillede noter-skrivebord");
    await pause(6000);
    for (const n of [1, 2, 3]) await emitTo(`note-${n}`, "gt-test-note", { close: true });
    await pause(1500);
  } else if (name === "grammatik") {
    // 0.2.10 (8/10): kongruens og de tre kommavalg i fanen Sprog, Indstillinger › Tekst og
    // »dage til deadline« i hjørnet. Indstillinger kun i hukommelsen; skærmbilleder tages udefra.
    Object.assign(settings(), { styleCheck: true, wordClasses: false });
    const { setStyleCheck, setCommaStyle, currentFlags, categoryOf } = await import("./editor/styleCheck.ts");
    const grammar = () => currentFlags().filter((f) => categoryOf(f.kind) === "grammatik");
    const report = async (label: string) => {
      await pause(1500);
      const g = grammar();
      await say(`grammatik ${label}: ${g.length} fund · ${g.map((f) => `»${view.state.sliceDoc(f.from, f.to)}« ${f.message}`).join(" | ")}`);
    };
    setStyleCheck(view, true);
    window.dispatchEvent(new CustomEvent("gt-test-tab", { detail: "sprog" }));
    await report("startkomma");
    await say(`hjørnet: ${document.querySelector(".count-long")?.textContent ?? "(intet)"} · ${document.querySelector(".count-short")?.textContent ?? ""}`);
    await say("skærmbillede sprog-start");
    await pause(6000);
    setCommaStyle(view, "uden");
    await report("uden startkomma");
    setCommaStyle(view, "fra");
    await report("komma fra");
    setCommaStyle(view, "start");
    window.dispatchEvent(new Event("gt-open-settings"));
    await pause(1200);
    const tab = [...document.querySelectorAll<HTMLButtonElement>(".settings [role='tab']")].find((t) => t.textContent?.trim() === "Tekst");
    tab?.click();
    await pause(800);
    await say(`skærmbillede indstillinger-tekst · ${tab ? "fanen fundet" : "FANEN IKKE FUNDET"}`);
    await pause(6000);
  } else if (name === "tabel-skriv") {
    // 9/10: »da jeg skrev i den sidste celle, hoppede synsfeltet hver gang«. Rul tabellen ind, skriv
    // 40 tegn i sidste celle ét ad gangen, og log rullepositionen efter hvert. Ingen hop: samme tal.
    const scroller = view.scrollDOM;
    const boxes = [...view.contentDOM.querySelectorAll<HTMLElement>(".gt-tablebox")];
    const box = boxes[boxes.length - 1];
    if (!box) {
      await say("tabel-skriv: ingen tabel");
    } else {
      box.scrollIntoView({ block: "center" });
      await pause(600);
      const cells = box.querySelectorAll<HTMLElement>("td");
      const cell = cells[cells.length - 1];
      cell.focus();
      const sel = window.getSelection();
      sel?.selectAllChildren(cell);
      sel?.collapseToEnd();
      await pause(300);
      const tops: number[] = [Math.round(scroller.scrollTop)];
      for (const ch of " og opdateres løbende hver eneste nat.") {
        document.execCommand("insertText", false, ch);
        await pause(90);
        tops.push(Math.round(scroller.scrollTop));
      }
      const jumps = tops.slice(1).filter((t, i) => Math.abs(t - tops[i]) > 2).length;
      await say(`tabel-skriv: ${jumps} hop på ${tops.length - 1} tegn; rullepositioner ${[...new Set(tops)].join(", ")}`);
      await say("skærmbillede tabel-skriv");
      await pause(2500);
    }
  } else if (name === "vaerktoej") {
    // 9/10: værktøjslinjen ved en markering havnede under et fastgjort sidepanel. Højre panel
    // fastgøres (kun i DOM'en), slutningen af en lang linje markeres, og linjen måles mod fladen.
    document.body.classList.add("right-pinned");
    await pause(600);
    const line = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find((l) => (l.textContent ?? "").length > 60);
    if (line) {
      const from = view.posAtDOM(line, 0);
      const to = from + (line.textContent ?? "").length;
      line.scrollIntoView({ block: "center" });
      view.dispatch({ selection: { anchor: Math.max(from, to - 12), head: to } });
      view.contentDOM.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      await pause(700);
      const bar = document.querySelector<HTMLElement>(".sel-bar")?.getBoundingClientRect();
      const area = view.scrollDOM.getBoundingClientRect();
      await say(bar ? `vaerktoej: linjen ${Math.round(bar.left)}-${Math.round(bar.right)}, fladen ${Math.round(area.left)}-${Math.round(area.right)}, inden for: ${bar.left >= area.left - 1 && bar.right <= area.right + 1 ? "ja" : "NEJ"}` : "vaerktoej: ingen værktøjslinje");
      await say("skærmbillede vaerktoej");
      await pause(2500);
    }
  } else if (name === "hoejreklik") {
    // 9/10: højreklik viser stilfundets rettelse, tabellens punkter og »Tilføj«. Fladens svar logges
    // for et fund og en celle, og koordinaterne skrives, så et script kan højreklikke rigtigt.
    const { setStyleCheck } = await import("./editor/styleCheck.ts");
    setStyleCheck(view, true);
    await pause(2500);
    const ctx = (el: Element) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 6, clientY: r.top + r.height / 2 }));
      return window.__gtMenu?.context() ?? "(ingen bro)";
    };
    const flagged = view.contentDOM.querySelector(".gt-style");
    const cells = view.contentDOM.querySelectorAll(".gt-tablebox td");
    const cell = cells[cells.length - 1];
    if (flagged) await say(`hoejreklik: fund »${flagged.textContent}« → ${ctx(flagged).slice(0, 250)}`);
    if (cell) await say(`hoejreklik: celle → ${ctx(cell).slice(0, 250)}`);
    const para = [...view.contentDOM.querySelectorAll(".cm-line")].find((l) => !l.querySelector(".gt-style") && (l.textContent ?? "").length > 40);
    if (para) await say(`hoejreklik: tekst → ${ctx(para).slice(0, 250)}`);
    // Koordinaterne i CSS-pixel inde i vinduet, til et rigtigt højreklik udefra.
    for (const [navn, el] of [["fund", flagged], ["celle", cell]] as const) {
      if (!el) continue;
      el.scrollIntoView({ block: "center" });
      await pause(300);
      const r = el.getBoundingClientRect();
      await say(`hoejreklik-punkt ${navn} ${Math.round(r.left + 8)} ${Math.round(r.top + r.height / 2)} ${window.devicePixelRatio}`);
      await pause(6000);
    }
  } else if (name === "print9") {
    // 9/10: det nye print og menuen »Indhold«.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true }));
    await pause(1800);
    await say("skærmbillede print9");
    await pause(2500);
    document.querySelector<HTMLElement>(".pv-menu")?.click();
    await pause(700);
    await say(`print9: menuen ${document.querySelector(".menu") ? "åben" : "IKKE åben"}`);
    await say("skærmbillede print9-indhold");
    await pause(2500);
  } else if (name === "faktatjek9") {
    // 9/10: flueben i faktatjekket og segl (ADR-0041). Filen har en blok uden segl (fremmed).
    const { findClaudeBlocks, claudeBlock } = await import("./editor/claudeBlocks.ts");
    window.dispatchEvent(new CustomEvent("gt-test-tab", { detail: "claude" }));
    await pause(1200);
    await say(`faktatjek9: fremmed ${document.querySelector(".cl-foreign") ? "vist" : "IKKE vist"}, ${document.querySelector(".cl-tally")?.textContent ?? ""}`);
    await say("skærmbillede fk-fremmed");
    await pause(2500);
    // Forsegl blokken, som et nyt faktatjek ville blive det.
    const b = findClaudeBlocks(view.state.doc.toString()).find((x) => x.kind === "faktatjek");
    if (b) {
      const d = b.data as { claims: unknown };
      const seal = await invoke<string>("seal_text", { text: JSON.stringify(d.claims) });
      view.dispatch({ changes: { from: b.from, to: b.to, insert: claudeBlock(b.id, b.kind, b.date, { ...(b.data as object), seal }) } });
    }
    await pause(1200);
    await say(`faktatjek9: egen ${document.querySelector(".cl-foreign") ? "STADIG FREMMED" : "stolet på"}, ${document.querySelector(".cl-tally")?.textContent ?? ""}`);
    await say("skærmbillede fk-egen");
    await pause(2500);
    document.querySelector<HTMLButtonElement>(".cl-tick:not(.cl-ticked)")?.click();
    await pause(800);
    await say(`faktatjek9: efter flueben ${document.querySelector(".cl-tally")?.textContent ?? ""}, fokus ${document.activeElement?.className ?? ""}, besked »${document.getElementById("banner")?.textContent ?? ""}«`);
    await say("skærmbillede fk-flueben");
    await pause(2500);
    document.querySelector<HTMLButtonElement>(".cl-done-head")?.click();
    await pause(800);
    await say(`faktatjek9: håndteret ${document.querySelectorAll(".cl-done").length} vist, ${[...document.querySelectorAll(".cl-done .cl-why")].map((e) => e.textContent).join(" | ")}`);
    await say("skærmbillede fk-haandteret");
    await pause(2500);
  } else if (name === "anslag") {
    const { count } = await import("./editor/count.ts");
    const c = count(view.state.doc.toString());
    await say(`tælling: ${c.words} ord, ${c.chars} anslag`);
  }
  await say("færdig");
}

/** Ctrl+plus og Ctrl+minus: ændres skriften, og huskes den? Sætter størrelsen tilbage bagefter. */
export async function zoomScenario(view: EditorView): Promise<void> {
  const size = () => getComputedStyle(view.dom).fontSize;
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, ctrlKey: true, bubbles: true }));
  const before = size();
  key("+");
  key("+");
  await pause(300);
  const bigger = size();
  key("-");
  key("-");
  await pause(300);
  await say(`zoom: ${before} -> ${bigger} -> ${size()}`);
}

/** Ét vindue pr. tekst: åbn en anden tekst i nyt vindue, prøv at åbne den igen, og afslut med Ctrl+Q. */
export async function windowsScenario(other: string): Promise<void> {
  await invoke("new_window", { path: other });
  await pause(2500);
  const again = await invoke<boolean>("focus_if_open", { path: other });
  await say(`vinduer: anden tekst åbnet i nyt vindue; åbnes igen -> hentes frem i stedet: ${again ? "ja" : "NEJ"}`);
  await say("afslutter med Ctrl+Q");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", ctrlKey: true, bubbles: true }));
}

// --- trykprøve (3/10): de steder, skriveprogrammer typisk går i stykker --------------------------

/** Skift hurtigt mellem tekster midt i skrivningen: intet må gå tabt. */
export async function switchStress(view: EditorView, files: string[]): Promise<void> {
  for (let round = 0; round < 3; round++) {
    for (const f of files) {
      window.dispatchEvent(new CustomEvent("gt-open-at", { detail: { path: f, pos: 0 } }));
      await pause(350);
      view.dispatch({ changes: { from: view.state.doc.length, insert: `\nSKIFT-${round}` }, userEvent: "input.type" });
    }
  }
  await pause(3000);
  await say("skift: færdig");
}

/** Et kæmpe indsæt og en meget lang linje: må ikke fryse. */
export async function pasteStress(view: EditorView): Promise<void> {
  const big = ("Et afsnit med almindelig tekst, der gentages for at fylde. ".repeat(20) + "\n\n").repeat(800);
  const a = performance.now();
  view.dispatch({ changes: { from: view.state.doc.length, insert: big }, userEvent: "input.paste" });
  const b = performance.now();
  await new Promise((r) => requestAnimationFrame(r));
  const line = "x".repeat(100_000);
  view.dispatch({ changes: { from: view.state.doc.length, insert: `\n${line}\n` }, userEvent: "input.paste" });
  const c = performance.now();
  await new Promise((r) => requestAnimationFrame(r));
  view.dispatch({ selection: { anchor: view.state.doc.length - 50_000 }, scrollIntoView: true });
  await pause(500);
  await say(`indsæt: ${(big.length / 1e6).toFixed(1)} MB på ${(b - a).toFixed(0)} ms, linje på 100.000 tegn på ${(c - b).toFixed(0)} ms, ${view.state.doc.length} tegn i alt`);
  await pause(3000);
}

/** Fraklip med tegn, der ligner en skjult blok: skal komme helt tilbage. */
export async function parkStress(view: EditorView): Promise<void> {
  const nasty = "Tekst med --> og <!-- og {-- og --} og {>> <<} midt i.";
  view.dispatch({ changes: { from: view.state.doc.length, insert: `\n\n${nasty}` }, userEvent: "input.type" });
  view.dispatch({ selection: { anchor: view.state.doc.length - nasty.length, head: view.state.doc.length } });
  const { cmd } = await import("./editor/shortcuts.ts");
  cmd.park(view);
  await pause(300);
  const { findParked } = await import("./editor/parked.ts");
  const p = findParked(view.state.doc.toString()).find((x) => x.text.includes("midt i"));
  await say(`fraklip: kortet findes ${p ? "ja" : "NEJ"}, teksten intakt ${p?.text === nasty ? "ja" : `NEJ (${p?.text})`}, ude af brødteksten ${view.state.doc.toString().split("<!-- gt:")[0].includes("midt i.") ? "NEJ" : "ja"}`);
  await pause(3000);
}

/** Renskriv hele vejen (lavet om 6/10): Claude, teksten rettet i dokumentet og den gamle i fraklip. */
export async function cleanStress(view: EditorView): Promise<void> {
  const before = view.state.doc.toString();
  const parked = (doc: string) => (doc.match(/<!-- gt:parkeret/g) ?? []).length;
  window.dispatchEvent(new CustomEvent("gt-claude", { detail: "clean" }));
  for (let i = 0; i < 240; i++) {
    await pause(500);
    const b = document.getElementById("banner");
    // Spørgsmålet om lov første gang: testen trykker »Send« som en bruger ville.
    const send = [...(b?.querySelectorAll("button") ?? [])].find((x) => x.textContent === "Send");
    if (send) {
      await say("renskriv: spurgte om lov til at sende teksten, trykker Send");
      send.click();
      continue;
    }
    if (b && !b.hidden && /Renskrevet\.|ændret undervejs|kunne ikke|fejl/i.test(b.textContent ?? "")) {
      const after = view.state.doc.toString();
      await say(`renskriv: ${b.textContent?.slice(0, 200)}`);
      await say(`renskriv: fraklip før ${parked(before)}, efter ${parked(after)} · teksten ændret ${after !== before} · begynder nu »${after.slice(0, 160).replace(/\n/g, " ⏎ ")}«`);
      return;
    }
  }
  await say("renskriv: INTET SVAR efter 120 s");
}
