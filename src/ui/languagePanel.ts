// Fanen Sprog i højre spalte (4/10): ordklasser og stiltjek slås til og fra
// her, hvor man skriver, i stedet for i indstillingerne. Hver del har en forklaring af farverne og et
// overblik, man kan bruge: hvor mange navneord pr. udsagnsord, og hvor mange steder stiltjekket har
// fundet (med »Næste« for at hoppe derhen). »Hvem skrev hvad« er taget ud, til den er gentænkt.

import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { settings, updateSettings, type Settings } from "../settings.ts";
import { errorText, showBanner } from "./banner.ts";
import { currentFlags, currentLix, categoryOf, mask, type Flag } from "../editor/styleCheck.ts";

type SpellError = { from: number; to: number; word: string; suggestions: string[] };
import { wordClassCounts, type WordClass } from "../editor/wordclasses.ts";
import { parseItem } from "../editor/fancyLists.ts";
import { isEnglish, tr } from "../i18n.ts";

// Ordklasser og stiltjek bygger på danske ordlister og vises kun på dansk (render), så deres tekster
// står kun på dansk.
const CLASSES: [WordClass, string, string][] = [
  ["n", "Navneord", "ting, personer og begreber"],
  ["v", "Udsagnsord", "det, der sker"],
  ["a", "Tillægsord", "beskriver navneord"],
  ["d", "Biord", "beskriver udsagnsord og sætninger"],
  ["c", "Bindeord", "binder sætninger sammen"],
];

// Overskrifterne er valgt 5/10.
const STYLE: [string, string, string][] = [
  ["grammatik", "Grammatik", "nutids-r og dobbelte ord"],
  ["stryg", "Floskler og fyld", "kan strøges"],
  ["enklere", "Tunge ord", "kan siges enklere"],
  ["saetning", "Tunge sætninger", "lange sætninger, passiv og navneordsstil"],
  ["hus", "Lyder som AI", "vendinger, der afslører maskinskrevet tekst"],
];

export class LanguagePanel {
  private body: HTMLElement | null = null;
  private view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
  }

  render(body: HTMLElement): void {
    this.body = body;
    const s = settings();
    // På engelsk er der kun stavningen: ordklasser og stiltjek kender kun dansk.
    if (isEnglish()) return void body.replaceChildren(this.spelling());
    const sections = [
      this.spelling(),
      this.section("Ordklasser i farver", "Shift+F7", s.wordClasses, (v) => this.set({ wordClasses: v }), () => this.wordClasses()),
      this.section("Stiltjek", "F7", s.styleCheck, (v) => this.set({ styleCheck: v }), () => this.styleCheck()),
    ];
    body.replaceChildren(...sections);
  }

  // --- stavning (5/10: »Ret stavefejl«) ---------------------------------------------------------
  // Windows' egen stavekontrol (spelling.rs). Ét ord ad gangen: forslagene som knapper, »Spring
  // over« og »Tilføj til ordbog«. Efter hver rettelse tjekkes teksten igen, så positionerne passer.

  private spellErrors: SpellError[] | null = null;
  private spellBusy = false;
  private spellMessage = "";
  private skipped = new Set<string>();

  private spelling(): HTMLElement {
    const sec = document.createElement("section");
    sec.className = "lp-section";
    const head = document.createElement("div");
    head.className = "lp-spell-head";
    const title = document.createElement("span");
    title.className = "lp-title";
    title.textContent = tr("Stavning", "Spelling");
    const run = document.createElement("button");
    run.type = "button";
    run.className = "lp-button";
    run.textContent = this.spellBusy ? tr("Tjekker …", "Checking …") : this.spellErrors ? tr("Tjek igen", "Check again") : tr("Ret stavefejl", "Fix spelling");
    run.disabled = this.spellBusy;
    run.addEventListener("click", () => void this.checkSpelling());
    head.append(title, run);
    sec.append(head);
    const current = this.spellErrors?.[0];
    if (current) {
      const box = document.createElement("div");
      box.className = "lp-spell";
      const word = document.createElement("p");
      word.className = "lp-spell-word";
      word.textContent = current.word;
      const count = document.createElement("span");
      count.className = "lp-count";
      count.textContent = this.spellErrors!.length === 1 ? tr("1 tilbage", "1 left") : tr(`${this.spellErrors!.length} tilbage`, `${this.spellErrors!.length} left`);
      word.append(" ", count);
      const options = document.createElement("div");
      options.className = "lp-spell-options";
      for (const sug of current.suggestions) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "lp-chip";
        b.textContent = sug || tr("Slet gentagelsen", "Delete the repeated word");
        b.addEventListener("click", () => void this.replaceSpelling(current, sug));
        options.append(b);
      }
      if (!current.suggestions.length) options.append(hint(tr("Ingen forslag.", "No suggestions.")));
      const tools = document.createElement("div");
      tools.className = "lp-spell-tools";
      const skip = document.createElement("button");
      skip.type = "button";
      skip.className = "settings-link";
      skip.textContent = tr("Spring over", "Skip");
      skip.addEventListener("click", () => {
        this.skipped.add(current.word);
        this.spellErrors = this.spellErrors!.filter((e) => !this.skipped.has(e.word));
        this.showCurrent();
      });
      const add = document.createElement("button");
      add.type = "button";
      add.className = "settings-link";
      add.textContent = tr("Tilføj til ordbog", "Add to dictionary");
      add.addEventListener("click", () => {
        void invoke("spell_add", { word: current.word })
          .then(() => {
            this.skipped.add(current.word);
            this.spellErrors = this.spellErrors!.filter((e) => !this.skipped.has(e.word));
            this.showCurrent();
          })
          .catch((e) => showBanner(errorText(e)));
      });
      tools.append(skip, add);
      box.append(word, options, tools);
      sec.append(box);
    } else if (this.spellMessage) {
      sec.append(hint(this.spellMessage));
    }
    return sec;
  }

  private async checkSpelling(): Promise<void> {
    this.spellBusy = true;
    this.refresh();
    try {
      // Markdown-tegn, links og skjulte blokke blankes ud, så de ikke tæller som stavefejl.
      const found = await invoke<SpellError[]>("spell_check", { text: spellText(this.view.state.doc.toString()) });
      this.spellErrors = found.filter((e) => !this.skipped.has(e.word));
      this.spellMessage = this.spellErrors.length ? "" : tr("Ingen stavefejl fundet.", "No spelling mistakes found.");
    } catch (e) {
      this.spellErrors = null;
      this.spellMessage = errorText(e);
    }
    this.spellBusy = false;
    this.showCurrent();
  }

  /** Markér det aktuelle ord i teksten, så man kan se det i sammenhæng, og tegn fanen. */
  private showCurrent(): void {
    const e = this.spellErrors?.[0];
    if (!e && this.spellErrors) this.spellMessage = tr("Ingen flere stavefejl.", "No more spelling mistakes.");
    if (e) this.view.dispatch({ selection: { anchor: e.from, head: e.to }, scrollIntoView: true });
    this.refresh();
  }

  private async replaceSpelling(e: SpellError, by: string): Promise<void> {
    if (this.view.state.sliceDoc(e.from, e.to) !== e.word) return void this.checkSpelling();
    // Et ord, der står to gange: slet det og mellemrummet foran.
    const from = by === "" && this.view.state.sliceDoc(e.from - 1, e.from) === " " ? e.from - 1 : e.from;
    this.view.dispatch({ changes: { from, to: e.to, insert: by }, userEvent: "input.spelling" });
    await this.checkSpelling();
  }

  /** Tegn om, hvis fanen vises (nye stiltjekfund, ændrede indstillinger). */
  refresh(): void {
    if (this.body?.isConnected && this.body.dataset.tab === "sprog") this.render(this.body);
  }

  private set(patch: Partial<Settings>): void {
    void updateSettings(patch).then(() => this.refresh());
  }

  private section(label: string, key: string, on: boolean, change: (v: boolean) => void, content: () => HTMLElement[] | Promise<HTMLElement[]>): HTMLElement {
    const sec = document.createElement("section");
    sec.className = "lp-section";
    const row = document.createElement("label");
    row.className = "settings-toggle";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = on;
    box.addEventListener("change", () => change(box.checked));
    const name = document.createElement("span");
    name.textContent = label;
    row.append(box, name);
    if (key) {
      const k = document.createElement("kbd");
      k.textContent = key;
      row.append(k);
    }
    sec.append(row);
    if (on) {
      const inner = document.createElement("div");
      inner.className = "lp-body";
      sec.append(inner);
      void Promise.resolve(content()).then((els) => inner.replaceChildren(...els));
    }
    return sec;
  }

  // --- ordklasser --------------------------------------------------------------------------------

  private async wordClasses(): Promise<HTMLElement[]> {
    const counts = await wordClassCounts(this.view.state.doc.toString());
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    // Hver ordklasse kan slås til og fra med et klik på rækken (5/10).
    const hiddenNow = new Set(settings().hiddenWordClasses ?? []);
    const legend = CLASSES.map(([k, name, what]) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "lp-legend lp-toggle";
      row.setAttribute("aria-pressed", String(!hiddenNow.has(k)));
      row.title = hiddenNow.has(k) ? `Vis ${name.toLowerCase()} i farver` : `Skjul farven på ${name.toLowerCase()}`;
      row.addEventListener("click", () => {
        const next = new Set(settings().hiddenWordClasses ?? []);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        this.set({ hiddenWordClasses: [...next] });
      });
      const dot = document.createElement("span");
      dot.className = "lp-dot";
      dot.style.background = `var(--wc-${k})`;
      const label = document.createElement("span");
      label.className = "lp-name";
      label.style.color = `var(--wc-${k})`;
      label.textContent = name;
      const desc = document.createElement("span");
      desc.className = "lp-desc";
      desc.textContent = what;
      const n = document.createElement("span");
      n.className = "lp-count";
      n.textContent = total ? `${Math.round((counts[k] / total) * 100)} %` : "";
      row.append(dot, label, desc, n);
      return row;
    });
    const bar = document.createElement("div");
    bar.className = "lp-bar";
    for (const [k] of CLASSES) {
      if (!counts[k]) continue;
      const part = document.createElement("span");
      part.style.background = `var(--wc-${k})`;
      part.style.flexGrow = String(counts[k]);
      bar.append(part);
    }
    const out: HTMLElement[] = [bar, ...legend];
    if (counts.v && counts.n) {
      out.push(hint(`${formatRatio(counts.n / counts.v)} navneord pr. udsagnsord. Jo flere navneord i forhold til udsagnsord, jo tungere læses teksten. Udsagnsordene driver den frem.`));
    }
    return out;
  }

  // --- stiltjek ----------------------------------------------------------------------------------

  private styleCheck(): HTMLElement[] {
    const flags = currentFlags();
    const lix = currentLix();
    const out: HTMLElement[] = STYLE.map(([cat, name, what]) => {
      const mine = flags.filter((f) => categoryOf(f.kind) === cat);
      const row = document.createElement("div");
      row.className = "lp-legend";
      const sample = document.createElement("span");
      sample.className = `lp-sample gt-style gt-style-${cat}`;
      sample.textContent = name;
      const desc = document.createElement("span");
      desc.className = "lp-desc";
      desc.textContent = what;
      const n = document.createElement("span");
      n.className = "lp-count";
      n.textContent = String(mine.length);
      row.append(sample, desc, n);
      if (mine.length) {
        const next = document.createElement("button");
        next.type = "button";
        next.className = "settings-link lp-next";
        next.textContent = "Næste";
        next.title = "Gå til næste sted i teksten";
        next.addEventListener("click", () => this.jump(mine));
        row.append(next);
      }
      return row;
    });
    if (lix) out.push(hint(`LIX ${Math.round(lix.lix)}: ${lix.label}.`));
    if (!flags.length && !lix) out.push(hint("Stiltjekket læser teksten …"));
    return out;
  }

  /** Næste fund efter markøren, ellers det første. */
  private jump(flags: Flag[]): void {
    const at = this.view.state.selection.main.to;
    const f = flags.find((x) => x.from >= at) ?? flags[0];
    this.view.dispatch({ selection: { anchor: f.from, head: f.to }, scrollIntoView: true });
    this.view.focus();
  }
}

/**
 * Teksten til stavekontrollen: markdown-tegn blanket ud (mask), og listemarkører som »ii.« og »b)«
 * også, så romertal og bogstaver ikke bliver til stavefejl (set 5/10: »ii« blev rettet til »ia«).
 * Længden bevares, så positionerne passer på teksten.
 */
export function spellText(doc: string): string {
  return mask(doc)
    .split("\n")
    .map((line) => {
      const it = parseItem(line, "a") ?? parseItem(line);
      return it ? " ".repeat(it.markerEnd) + line.slice(it.markerEnd) : line;
    })
    .join("\n");
}

function hint(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "lp-hint";
  p.textContent = text;
  return p;
}

function formatRatio(r: number): string {
  return r.toFixed(1).replace(".", ",");
}
