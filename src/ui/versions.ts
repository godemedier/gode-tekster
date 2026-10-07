// Fanen Versioner (ADR-0009, design runde 4): versioner grupperet pr. dag. Klik viser en gammel
// udgave med en stribet »fortid«-ramme (Ulysses). »Gendan denne udgave« gemmer først den nuværende
// som sin egen version (designprincip 3: gendan sletter aldrig). Højreklik navngiver en version.

import { invoke } from "@tauri-apps/api/core";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { authorshipField, setAuthorship, type Authorship } from "../editor/authorship.ts";
import { baseExtensions } from "../editor/setup.ts";
import { formatTime } from "./format.ts";
import { clock } from "../editor/dates.ts";
import { showMenu } from "./menu.ts";
import { errorText, hideBanner, notify, showBanner } from "./banner.ts";
import { markupFor } from "../editor/critic.ts";
import { resolveAll } from "../editor/revisionsView.ts";
import { findParked } from "../editor/parked.ts";
import { findClaudeBlocks } from "../editor/claudeBlocks.ts";
import { tr } from "../i18n.ts";

type VersionInfo = { id: number; ts: number; source: string; label: string | null; chars: number };
type VersionDto = { text: string; authors: Authorship[] };

const SOURCE: Record<string, string> = {
  app: tr("Skrevet", "Written"),
  external: tr("Rettet udefra", "Changed outside the app"),
  // Gemt, før en anden udgave tog over (Gendan eller »Brug den nye« ved en konflikt).
  restore: tr("Gemt før skift", "Saved before switching"),
  first: tr("Første udgave", "First version"),
};

export type VersionHooks = {
  view: EditorView;
  path(): string | null;
  /** Gem nu og hold autosave på pause, mens en gammel udgave vises. */
  pause(on: boolean): Promise<void>;
};

function dayLabel(ts: number): string {
  const t = formatTime(ts);
  // formatTime giver »14.12« (engelsk »14:12«) i dag og »i går« (»yesterday«) i går.
  if (/^\d\d[.:]\d\d$/.test(t)) return tr("I dag", "Today");
  if (t === tr("i går", "yesterday")) return tr("I går", "Yesterday");
  return t;
}

/** Klokkeslæt på engelsk: »14:05«. */
const enClock = (d: Date): string => clock(d).replace(".", ":");

export class Versions {
  private hooks: VersionHooks;
  private saved: EditorState | null = null;
  private bar: HTMLElement | null = null;

  constructor(hooks: VersionHooks) {
    this.hooks = hooks;
  }

  async render(body: HTMLElement): Promise<void> {
    const path = this.hooks.path();
    let list: VersionInfo[] = [];
    try {
      if (path) list = await invoke<VersionInfo[]>("history_list", { path });
    } catch (e) {
      const p = document.createElement("p");
      p.className = "cl-error";
      p.textContent = errorText(e);
      body.replaceChildren(p);
      return;
    }
    const rows: HTMLElement[] = [];
    let lastDay = "";
    for (const v of list) {
      const day = dayLabel(v.ts);
      if (day !== lastDay) {
        const h = document.createElement("div");
        h.className = "vs-day";
        h.textContent = day;
        rows.push(h);
        lastDay = day;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "vs-row";
      const time = document.createElement("span");
      time.className = "vs-time";
      const d = new Date(v.ts);
      time.textContent = tr(`Kl. ${clock(d)}`, enClock(d));
      const what = document.createElement("span");
      what.className = "vs-what";
      what.textContent = v.label ?? SOURCE[v.source] ?? v.source;
      if (v.label) what.classList.add("vs-named");
      b.append(time, what);
      b.addEventListener("click", () => void this.preview(v));
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [{ label: v.label ? tr("Omdøb versionen", "Rename version") : tr("Navngiv versionen", "Name version"), run: () => this.name(v, what) }]);
      });
      rows.push(b);
    }
    body.replaceChildren(...rows);
  }

  private name(v: VersionInfo, el: HTMLElement): void {
    const input = document.createElement("input");
    input.className = "lib-rename";
    input.value = v.label ?? "";
    input.placeholder = tr("Fx »Sendt til redaktøren«", "For example \"Sent to the editor\"");
    el.replaceWith(input);
    input.focus();
    const done = async () => {
      try {
        await invoke("history_label", { id: v.id, label: input.value });
      } catch (e) {
        showBanner(errorText(e));
      }
      window.dispatchEvent(new Event("gt-versions"));
    };
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") {
        input.value = v.label ?? "";
        input.blur();
      }
    });
    input.addEventListener("blur", () => void done(), { once: true });
  }

  private async preview(v: VersionInfo): Promise<void> {
    let old: VersionDto;
    try {
      old = await invoke<VersionDto>("history_get", { id: v.id });
    } catch (e) {
      showBanner(errorText(e));
      return;
    }
    const view = this.hooks.view;
    if (!this.saved) {
      await this.hooks.pause(true);
      this.saved = view.state;
    }
    view.setState(
      EditorState.create({
        doc: old.text,
        extensions: [baseExtensions(() => {}), EditorState.readOnly.of(true), EditorView.editable.of(false)],
      }),
    );
    document.body.classList.add("previewing");
    this.showBar(v, old);
  }

  private showBar(v: VersionInfo, old: VersionDto): void {
    this.bar?.remove();
    const bar = document.createElement("div");
    bar.className = "vs-bar";
    const label = document.createElement("span");
    const d = new Date(v.ts);
    label.textContent = tr(`${dayLabel(v.ts)} kl. ${clock(d)}`, `${dayLabel(v.ts)} at ${enClock(d)}`);
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "vs-primary";
    restore.textContent = tr("Gendan denne udgave", "Restore this version");
    restore.addEventListener("click", () => void this.restore(old));
    const compare = document.createElement("button");
    compare.type = "button";
    compare.textContent = tr("Sammenlign med nu", "Compare with now");
    compare.addEventListener("click", () => void this.compare(old));
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = tr("Tilbage til nu", "Back to now");
    back.addEventListener("click", () => void this.back());
    bar.append(label, restore, compare, back);
    (document.getElementById("main") as HTMLElement).append(bar);
    this.bar = bar;
  }

  async back(): Promise<void> {
    if (!this.saved) return;
    this.hooks.view.setState(this.saved);
    this.saved = null;
    this.bar?.remove();
    this.bar = null;
    document.body.classList.remove("previewing");
    await this.hooks.pause(false);
    this.hooks.view.focus();
  }

  /**
   * Forskellen fra denne udgave til nu, vist som rettelser i den nuværende tekst (critic.ts).
   * Godtag beholder det nuværende, afvis går tilbage til den gamle udgave, ét sted ad gangen.
   */
  private async compare(old: VersionDto): Promise<void> {
    await this.back();
    const view = this.hooks.view;
    const now = view.state.doc.toString();
    let edits: { from: number; to: number; insert: string }[];
    try {
      edits = await invoke("word_diff", { old: old.text, new: now });
    } catch (e) {
      showBanner(errorText(e));
      return;
    }
    // Aldrig mærker inde i skjulte blokke (fraklip, Claudes resultater): de er kommentarer.
    const hidden = [...findParked(now), ...findClaudeBlocks(now)];
    const skip = (at: number, length: number) => hidden.some((b) => at < b.to && at + length >= b.from);
    const changes = markupFor(edits, old.text, skip);
    if (!changes.length) {
      notify(tr("Der er ingen forskel på den udgave og teksten nu.", "There is no difference between that version and the text now."));
      return;
    }
    view.dispatch({ changes, userEvent: "input.compare" });
    const n = changes.length / 2;
    const id = showBanner(
      tr(
        `${n} forskelle fra den udgave er markeret. Godtag beholder det nye, afvis går tilbage.`,
        `${n === 1 ? "1 difference from that version is" : `${n} differences from that version are`} marked. Accept keeps the new text, reject goes back.`,
      ),
      [
        { label: tr("Godtag alle", "Accept all"), run: () => (resolveAll(view, true), hideBanner(id)) },
        { label: tr("Afvis alle", "Reject all"), run: () => (resolveAll(view, false), hideBanner(id)) },
        { label: tr("Ét ad gangen", "One at a time"), run: () => hideBanner(id) },
      ],
      { perText: true },
    );
  }

  /** Gem den nuværende som version, vend tilbage, og erstat teksten med den gamle udgave. */
  private async restore(old: VersionDto): Promise<void> {
    const saved = this.saved;
    const path = this.hooks.path();
    if (!saved || !path) return;
    const now = saved.field(authorshipField);
    try {
      // Den nuværende gemmes først, ellers gendannes der ikke (designprincip 3).
      await invoke("history_keep", { path, text: saved.doc.toString(), authors: now.authors });
    } catch (e) {
      showBanner(errorText(e));
      return;
    }
    await this.back();
    const view = this.hooks.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: old.text }, userEvent: "restore" });
    view.dispatch({ effects: setAuthorship.of({ authors: old.authors, me: now.me, pasted: [], external: [] }) });
    window.dispatchEvent(new Event("gt-versions"));
  }
}
