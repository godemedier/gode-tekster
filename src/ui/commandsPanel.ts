// Fanen Kommandoer i Indstillinger (7/10, før i venstre og højre spalte; research 3.9). En liste
// over »/«-kommandoerne med egne øverst, hver med en til/fra-kontakt. Øverst står et felt, hvor en
// ny kommando beskrives med egne ord (6/10: »det skal bare beskrives med ord, og så sætter systemet selv op«).
// Sprogmodellen foreslår kommandoen, og forslaget vises med navn, prøve og Gem. »Gem det markerede
// som skabelon« virker uden AI. Formularen med de fire slags er »Byg selv« for den, der vil rette
// selv. Alt går gennem samme validator og gemmes først ved et klik. Visningerne afløser listen
// inde i fanen: ingen dialoger. Esc fører altid tilbage til teksten uden at kassere noget. Alt
// vises med textContent.

import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";

import { count } from "../editor/count.ts";
import { withoutParked } from "../editor/parked.ts";
import { currentLang, tr, type Lang } from "../i18n.ts";
import { BLOCKS, MAX_STEPS, applyChain, formatStep, parseChain } from "../commands/blocks.ts";
import { runCheck } from "../commands/checks.ts";
import { FIELD_NAMES, expandTemplate } from "../commands/fields.ts";
import { validateCommand } from "../commands/model.ts";
import { brokenCommands, deleteUserCommand, everyCommand, onCommandsChanged, saveUserCommand, setEnabled, type Entry } from "../commands/store.ts";
import { SHORTCUT_KEYS, type AiDesign, type BrokenCommand, type Command, type CommandError, type CommandHooks, type Kind, type Output, type ShortcutKey } from "../commands/types.ts";
import { errorText } from "./banner.ts";

type AiState = { chosen: string | null; providers: { id: string; name: string; ready: boolean }[] };
type Scope = Command["scope"];

const KINDS: Kind[] = ["template", "transform", "check", "ai"];
const kindName = (k: Kind): string =>
  ({ template: tr("Skabelon", "Template"), transform: tr("Omformning", "Transform"), check: tr("Tjek", "Check"), ai: "AI" })[k];
const groupName = (k: Kind): string =>
  ({ template: tr("Skabeloner", "Templates"), transform: tr("Omformninger", "Transforms"), check: tr("Tjek", "Checks"), ai: "AI" })[k];
const kindHint = (k: Kind): string =>
  ({
    template: tr("Sætter en tekst ind ved markøren. Felterne udfyldes, når du bruger den.", "Inserts a text at the cursor. The fields are filled in when you use it."),
    transform: tr("Laver det markerede om i faste trin. Ét Ctrl+Z fortryder det hele.", "Changes the selection in fixed steps. One Ctrl+Z undoes it all."),
    check: tr("Læser kun. Peger på de ord, du vil undgå.", "Only reads. Points to the words you want to avoid."),
    ai: tr("Sender teksten med din instruks. Svaret peger og spørger, det skriver aldrig tekst.", "Sends the text with your instruction. The answer points and asks, it never writes text."),
  })[k];

/** Valgene i en klods med ord, man forstår. Et valg uden for listen vises, som det står i filen. */
const OPTION_NAMES: Record<string, [string, string]> = {
  word: ["kun hele ord", "whole words only"],
  case: ["forskel på store og små bogstaver", "match upper and lower case"],
  da: ["danske »«", "Danish »«"],
  en: ["engelske “ ”", "English “ ”"],
  around: ["sæt citationstegn om teksten", "put quotation marks around the text"],
  desc: ["omvendt rækkefølge", "descending"],
  upper: ["STORE BOGSTAVER", "UPPER CASE"],
  lower: ["små bogstaver", "lower case"],
  sentence: ["Stort begyndelsesbogstav", "Sentence case"],
  bullets: ["punkter", "bullets"],
  numbered: ["tal", "numbers"],
  tasks: ["tjekliste", "task list"],
  none: ["ingen liste", "no list"],
  format: ["formatering", "formatting"],
  links: ["links", "links"],
  "0": ["brødtekst", "body text"],
  "1": ["overskrift 1", "heading 1"],
  "2": ["overskrift 2", "heading 2"],
  "3": ["overskrift 3", "heading 3"],
  "4": ["overskrift 4", "heading 4"],
};
const optionName = (o: string): string => (OPTION_NAMES[o] ? tr(...OPTION_NAMES[o]) : o);

/** Kroppe, validatoren altid godtager. Bruges til at finde ud af, hvilket felt en fejl hører til. */
const GOOD_BODY: Record<Kind, string> = { template: "x", transform: "tidy", check: "a => b", ai: "x" };

const EXAMPLE = tr(
  'Hun sagde: "Det går nok".  Det gjorde det ikke...\nanden linje\nførste linje\nanden linje',
  'She said: "It will be fine".  It was not...\nsecond line\nfirst line\nsecond line',
);

type StepDraft = { block: string; texts: string[]; options: string[] };
type Draft = {
  name: string;
  description: string;
  kind: Kind;
  template: string;
  check: string;
  ai: string;
  steps: StepDraft[];
  newfile: boolean;
  scope: Scope;
  /** Har brugeren selv valgt, hvad kommandoen gælder? Ellers følger det slagsen. */
  scopeChosen: boolean;
  output: Output;
  shortcut: ShortcutKey | "";
  aliases: string[];
  lang?: Lang;
};
type FieldKey = "name" | "description" | "body" | "other";
type Form = {
  title: string;
  hint: string;
  draft: Draft;
  previousPath?: string;
  /** Felter, der er rørt ved. Kun de viser fejl, så en ny formular ikke starter rød. */
  touched: Set<FieldKey>;
  errorEls: Partial<Record<FieldKey, HTMLElement>>;
  stepErrorEls: HTMLElement[];
  tryEl: HTMLElement | null;
  saveError: string;
};

function specOf(block: string) {
  return BLOCKS.find((b) => b.name === block);
}

function newStep(block: string): StepDraft {
  const s = specOf(block);
  return { block, texts: Array.from({ length: s?.texts ?? 0 }, () => ""), options: s && s.min > 0 ? s.options.slice(0, s.min) : [] };
}

function bodyOf(d: Draft): string {
  if (d.kind === "transform") return d.steps.map((s) => formatStep(s.block, [...s.texts, ...s.options])).join("\n");
  return d[d.kind];
}

function draftFrom(c: Command | null): Draft {
  const d: Draft = {
    name: c?.name ?? "",
    description: c?.description ?? "",
    kind: c?.kind ?? "template",
    template: "",
    check: "",
    ai: "",
    steps: [],
    newfile: c?.newfile ?? false,
    scope: c?.scope ?? "selection",
    scopeChosen: Boolean(c),
    output: c?.output ?? "findings",
    shortcut: c?.shortcut ?? "",
    aliases: c?.aliases ?? [],
    lang: c?.lang,
  };
  if (!c) return d;
  if (c.kind === "transform") {
    d.steps = parseChain(c.body).steps.map((s) => {
      const texts = specOf(s.block)?.texts ?? 0;
      return { block: s.block, texts: s.args.slice(0, texts), options: s.args.slice(texts) };
    });
  } else {
    d[c.kind] = c.body;
  }
  return d;
}

function commandFrom(d: Draft): Command {
  return {
    name: d.name.trim(),
    kind: d.kind,
    description: d.description.trim(),
    aliases: d.aliases,
    scope: d.kind === "template" ? "selection" : d.scope,
    newfile: d.kind === "template" && d.newfile,
    output: d.kind === "ai" ? d.output : undefined,
    shortcut: d.shortcut || undefined,
    lang: d.lang,
    body: bodyOf(d),
    source: "user",
  };
}

/**
 * Det, sprogmodellen får at bygge af (research 3.6): slags, felter, klodser, svarformer og grænser.
 * Skrevet ud fra de samme lister, som validatoren bruger, så kataloget ikke kan love mere, end
 * programmet kan.
 */
export function designCatalog(): string {
  const en = currentLang() === "en";
  const fields = FIELD_NAMES.map((f) => `{{${en ? f.en : f.da}}}`).join(", ");
  const blocks = BLOCKS.map((b) => `- ${b.name}${b.args ? ` ${b.args}` : ""}: ${en ? b.en : b.da}`).join("\n");
  return tr(
    [
      "SLAGS (kind) OG KROP (body)",
      "template: en tekst, der sættes ind ved markøren. Felter skrives i dobbelte tuborgklammer.",
      `Felter: ${fields}. {{dato+7}} regner dage frem, minus går også. {{1:tekst}} til {{9:tekst}} er steder, brugeren udfylder med Tab. Samme nummer udfyldes samlet. Højst én {{markør}}. Andre felter findes ikke.`,
      `transform: en kæde på højst ${MAX_STEPS} klodser, én pr. linje, der laver det markerede om. Tekster står i "anførselstegn", valg er bare ord. Klodserne:`,
      blocks,
      "clip og footnote må kun stå sidst. Andre klodser findes ikke.",
      "check: en ordliste, én regel pr. linje: `ordet, der skal undgås => det, man hellere vil skrive`. Tjekket peger på hvert sted, ordet står. Det ændrer intet.",
      "ai: en instruks på højst 2.000 tegn til en sprogmodel, der læser teksten. output er findings (op til 30 ordrette uddrag med en kort kommentar) eller questions (op til 10 korte spørgsmål). Der er ingen anden svarform, og modellen kan ikke skrive eller omskrive tekst.",
      "",
      "GRÆNSER",
      "name: små bogstaver (også æøå), tal og bindestreg, højst 24 tegn, uden skråstreg.",
      "description: én linje, højst 80 tegn.",
      "scope: selection (markeringen, ellers afsnittet) eller document (hele teksten).",
    ].join("\n"),
    [
      "KINDS (kind) AND BODY (body)",
      "template: a text that is inserted at the cursor. Fields are written in double curly braces.",
      `Fields: ${fields}. {{date+7}} counts days ahead, minus works too. {{1:text}} to {{9:text}} are places the user fills in with Tab. The same number is filled in together. At most one {{cursor}}. There are no other fields.`,
      `transform: a chain of at most ${MAX_STEPS} blocks, one per line, that changes the selection. Texts go in "double quotes", options are bare words. The blocks:`,
      blocks,
      "clip and footnote may only come last. There are no other blocks.",
      "check: a word list, one rule per line: `the word to avoid => what to write instead`. The check points to every place the word occurs. It changes nothing.",
      "ai: an instruction of at most 2,000 characters for a language model that reads the text. output is findings (up to 30 verbatim excerpts with a short comment) or questions (up to 10 short questions). There is no other answer form, and the model cannot write or rewrite text.",
      "",
      "LIMITS",
      "name: lower-case letters, digits and hyphen, 24 characters at most, no slash.",
      "description: one line, 80 characters at most.",
      "scope: selection (the selection, otherwise the paragraph) or document (the whole text).",
    ].join("\n"),
  );
}

export class CommandsPanel {
  readonly el: HTMLElement;
  private view: EditorView;
  private hooks: CommandHooks;
  private mode: "list" | "form" | "describe" | "proposal" = "list";
  private form: Form | null = null;
  /** Forslaget, der venter på Gem: fra sprogmodellen eller fra det markerede. */
  private proposal: { command: Command; from: "ai" | "selection" } | null = null;
  /** Den valgte udbyder, når den er klar. null: »Beskriv en kommando« vises ikke. */
  private ai: { id: string; name: string } | null = null;
  /** Filen, der er spurgt »Slet?« om. */
  private confirmDelete: string | null = null;
  private describe = { text: "", busy: false, message: "", asking: false, run: 0 };

  constructor(view: EditorView, hooks: CommandHooks) {
    this.view = view;
    this.hooks = hooks;
    this.el = document.createElement("div");
    this.el.className = "left-view cmd";
    // Esc fører tilbage til teksten. Formularen bliver stående, så intet går tabt.
    this.el.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      this.view.focus();
    });
    onCommandsChanged(() => this.refresh());
    window.addEventListener("gt-ai-changed", () => void this.checkAi(true));
    void this.checkAi(false);
    this.renderList();
  }

  /** Listen er læst igen, eller fanen er vist. En åben formular røres ikke, kun dens fejl. */
  refresh(): void {
    if (this.mode === "list") this.renderList();
    else if (this.mode === "form") this.validate();
  }

  private async checkAi(refresh: boolean): Promise<void> {
    try {
      const st = await invoke<AiState>("ai_status", { refresh });
      const chosen = st.providers.find((p) => p.id === st.chosen);
      this.ai = chosen?.ready ? { id: chosen.id, name: chosen.name } : null;
    } catch {
      this.ai = null;
    }
    if (this.mode === "list") this.renderList();
  }

  // --- listen --------------------------------------------------------------------------------------

  private renderList(): void {
    this.mode = "list";
    const active = document.activeElement instanceof HTMLElement && this.el.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
    const scroll = this.el.querySelector(".cmd-list")?.scrollTop ?? 0;

    const top = this.newBox();

    const list = document.createElement("div");
    list.className = "cmd-list";
    const broken = brokenCommands();
    if (broken.length) list.append(heading(tr("Kan ikke læses", "Can't be read")), ...broken.map((b) => this.brokenRow(b)));
    const entries = everyCommand();
    const own = entries.filter((e) => e.command.source === "user");
    list.append(heading(tr("Egne", "Your own")));
    if (own.length) list.append(...own.map((e) => this.row(e)));
    else list.append(hint(tr("Du har ingen endnu. Beskriv en ovenfor, eller tilpas en af dem herunder.", "You have none yet. Describe one above, or customize one of those below.")));
    for (const k of KINDS) {
      const rows = entries.filter((e) => e.command.source === "builtin" && e.command.kind === k);
      if (rows.length) list.append(heading(groupName(k)), ...rows.map((e) => this.row(e)));
    }
    this.el.replaceChildren(top, list);
    list.scrollTop = scroll;
    if (active) this.focusKey(active);
  }

  /**
   * Øverst i listen: beskriv en ny kommando med egne ord. Uden AI-hjælp står der, hvor den slås
   * til. »Gem det markerede som skabelon« og »Byg selv« virker altid.
   */
  private newBox(): HTMLElement {
    const st = this.describe;
    const box = document.createElement("form");
    box.className = "cmd-new";
    box.addEventListener("submit", (e) => {
      e.preventDefault();
      this.openDescribe();
      void this.suggest();
    });
    if (this.ai) {
      const area = textarea(st.text, 3, "describe");
      area.maxLength = 1000;
      area.placeholder = tr("Fx: sæt en tom tjekliste ind, find ordene måske og nok, eller gør linjerne til en nummereret liste", "E.g. insert an empty checklist, find the words maybe and quite, or turn the lines into a numbered list");
      area.addEventListener("input", () => (st.text = area.value));
      // Ctrl+Enter sender. Enter alene giver en ny linje.
      area.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.ctrlKey) {
          e.preventDefault();
          box.requestSubmit();
        }
      });
      const go = button(tr("Lav kommandoen", "Make the command"), () => {}, "suggest");
      go.type = "submit";
      go.classList.add("cmd-primary");
      const actions = document.createElement("div");
      actions.className = "cmd-actions";
      actions.append(go);
      box.append(field(tr("Ny kommando: hvad skal den gøre?", "New command: what should it do?"), area), actions);
    } else {
      box.append(field(tr("Ny kommando", "New command"), hint(tr("Slå AI-hjælp til under Indstillinger, så kan du beskrive en ny kommando med dine egne ord.", "Turn on AI help in Settings, and you can describe a new command in your own words."))));
    }
    const more = document.createElement("div");
    more.className = "cmd-more";
    more.append(
      link(tr("Gem det markerede som skabelon", "Save the selection as a template"), () => this.selectionAsTemplate(), "from-selection"),
      link(tr("Byg selv", "Build it yourself"), () => this.openForm(null, tr("Ny kommando", "New command")), "new"),
    );
    box.append(more);
    return box;
  }

  private focusKey(key: string): void {
    for (const el of this.el.querySelectorAll<HTMLElement>("[data-key]")) {
      if (el.dataset.key === key) return el.focus();
    }
  }

  private row(e: Entry): HTMLElement {
    const c = e.command;
    const own = c.source === "user";
    const row = document.createElement("div");
    row.className = e.enabled ? "cmd-row" : "cmd-row cmd-off";
    const top = document.createElement("label");
    top.className = "settings-toggle";
    const sw = document.createElement("input");
    sw.type = "checkbox";
    sw.checked = e.enabled;
    sw.dataset.key = `switch:${c.source}:${c.name}`;
    sw.title = e.enabled ? tr("Slå fra", "Turn off") : tr("Slå til", "Turn on");
    sw.addEventListener("change", () => void setEnabled(c.name, sw.checked).catch((err) => this.hooks.notify(errorText(err))));
    const name = document.createElement("span");
    name.className = "cmd-name";
    name.textContent = `/${c.name}`;
    top.append(sw, name, tag(kindName(c.kind)));
    if (c.lang && c.lang !== currentLang()) top.append(tag(c.lang === "da" ? tr("kun dansk", "Danish only") : tr("kun engelsk", "English only")));
    if (c.shortcut) {
      const k = document.createElement("kbd");
      k.textContent = c.shortcut;
      top.append(k);
    }
    const sub = document.createElement("div");
    sub.className = "cmd-sub";
    const desc = document.createElement("span");
    desc.className = "cmd-desc";
    desc.textContent = c.description;
    sub.append(desc);
    row.append(top, sub);
    if (!own) {
      sub.append(
        link(
          tr("Tilpas", "Customize"),
          () =>
            this.openForm(
              { ...c, source: "user", path: undefined },
              tr(`Tilpas /${c.name}`, `Customize /${c.name}`),
              tr("Du retter i din egen kopi. Den går forud for den indbyggede, så længe den har samme navn.", "You are editing your own copy. It replaces the built-in one as long as it has the same name."),
            ),
          `edit:builtin:${c.name}`,
        ),
      );
      return row;
    }
    const path = c.path ?? "";
    row.append(
      this.confirmDelete === path
        ? this.deleteQuestion(path, `/${c.name}`)
        : tools([
            link(tr("Ret", "Edit"), () => this.openForm(c, tr(`Ret /${c.name}`, `Edit /${c.name}`), "", path), `edit:user:${c.name}`),
            link(tr("Åbn som fil", "Open as file"), () => this.openFile(path), `file:${path}`),
            link(tr("Slet", "Delete"), () => this.askDelete(path), `delete:${path}`),
          ]),
    );
    return row;
  }

  private brokenRow(b: BrokenCommand): HTMLElement {
    const row = document.createElement("div");
    row.className = "cmd-row";
    const name = document.createElement("span");
    name.className = "cmd-name";
    name.textContent = b.fileName;
    row.append(name);
    for (const e of b.errors.slice(0, 5)) row.append(errorLine(e));
    row.append(
      this.confirmDelete === b.path
        ? this.deleteQuestion(b.path, b.fileName)
        : tools([link(tr("Åbn som fil", "Open as file"), () => this.openFile(b.path), `file:${b.path}`), link(tr("Slet", "Delete"), () => this.askDelete(b.path), `delete:${b.path}`)]),
    );
    return row;
  }

  private askDelete(path: string): void {
    this.confirmDelete = path;
    this.renderList();
    this.focusKey("delete-no");
  }

  private deleteQuestion(path: string, shown: string): HTMLElement {
    const box = tools([]);
    const q = document.createElement("span");
    q.className = "cmd-desc";
    q.textContent = tr(`Læg ${shown} i papirkurven?`, `Move ${shown} to the Recycle Bin?`);
    const done = () => {
      this.confirmDelete = null;
      this.renderList();
    };
    box.append(
      q,
      link(
        tr("Slet", "Delete"),
        () => {
          void deleteUserCommand(path)
            .then(() => this.hooks.notify(tr(`${shown} ligger i papirkurven.`, `${shown} is in the Recycle Bin.`)))
            .catch((err) => this.hooks.notify(errorText(err)))
            .finally(() => {
              done();
              this.focusKey("new");
            });
        },
        "delete-yes",
      ),
      link(
        tr("Behold", "Keep"),
        () => {
          done();
          this.focusKey(`delete:${path}`);
        },
        "delete-no",
      ),
    );
    return box;
  }

  /** Åbn filen i programmet. main.ts lytter efter gt-open-link og viser fejlen, hvis den ikke kan åbnes. */
  private openFile(path: string): void {
    if (!path) return;
    // Lytteren afkoder procenttegn, som om stien var et link. Et procenttegn i et filnavn skal overleve det.
    window.dispatchEvent(new CustomEvent("gt-open-link", { detail: path.replace(/%/g, "%25") }));
  }

  // --- formularen ----------------------------------------------------------------------------------

  private openForm(c: Command | null, title: string, hintText = "", previousPath?: string): void {
    this.mode = "form";
    this.confirmDelete = null;
    this.form = { title, hint: hintText, draft: draftFrom(c), previousPath, touched: new Set(), errorEls: {}, stepErrorEls: [], tryEl: null, saveError: "" };
    this.renderForm();
    this.focusKey("name");
  }

  private closeForm(): void {
    this.form = null;
    this.renderList();
    this.focusKey("new");
  }

  private renderForm(): void {
    const f = this.form;
    if (!f) return;
    const d = f.draft;
    const form = document.createElement("form");
    form.className = "cmd-form";
    form.noValidate = true;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.save();
    });

    const head = document.createElement("div");
    head.className = "cmd-form-head";
    const title = document.createElement("strong");
    title.textContent = f.title;
    head.append(title, link(tr("Tilbage", "Back"), () => this.closeForm(), "back"));
    form.append(head);
    if (f.hint) form.append(hint(f.hint));

    const kindHintEl = hint(kindHint(d.kind));
    form.append(
      radios(tr("Slags", "Kind"), "cmd-kind", KINDS.map((k) => [k, kindName(k)]), d.kind, (k) => {
        d.kind = k;
        if (!d.scopeChosen) d.scope = k === "check" || k === "ai" ? "document" : "selection";
        this.renderForm();
        this.focusKey(`cmd-kind:${k}`);
      }),
      kindHintEl,
    );

    const name = input(d.name, 24, "name");
    name.setAttribute("aria-label", tr("Navn", "Name"));
    name.spellcheck = false;
    name.addEventListener("input", () => {
      const clean = name.value.replace(/^\/+/, "").toLowerCase();
      if (clean !== name.value) name.value = clean;
      d.name = clean;
      this.touch("name");
    });
    const nameRow = document.createElement("div");
    nameRow.className = "cmd-name-field";
    const slash = document.createElement("span");
    slash.textContent = "/";
    slash.setAttribute("aria-hidden", "true");
    nameRow.append(slash, name);
    form.append(field(tr("Navn", "Name"), nameRow), this.errorSlot("name"));

    const desc = input(d.description, 80, "description");
    desc.addEventListener("input", () => {
      d.description = desc.value;
      this.touch("description");
    });
    form.append(field(tr("Beskrivelse", "Description"), desc), this.errorSlot("description"));

    f.stepErrorEls = [];
    if (d.kind === "template") form.append(...this.templateFields(d));
    else if (d.kind === "transform") form.append(...this.transformFields(d));
    else if (d.kind === "check") form.append(...this.checkFields(d));
    else form.append(...this.aiFields(d));
    form.append(this.errorSlot("body"));

    if (d.kind !== "template") {
      form.append(
        radios(
          tr("Gælder", "Applies to"),
          "cmd-scope",
          [
            ["selection", tr("Markeringen, ellers afsnittet", "The selection, otherwise the paragraph")],
            ["document", tr("Hele teksten", "The whole text")],
          ],
          d.scope,
          (s) => {
            d.scope = s;
            d.scopeChosen = true;
            this.validate();
          },
        ),
      );
    }

    const taken = this.shortcutsTaken();
    const keys = document.createElement("select");
    keys.className = "cmd-select";
    keys.dataset.key = "shortcut";
    keys.append(option("", tr("Ingen", "None")));
    for (const k of SHORTCUT_KEYS) {
      const by = taken.get(k);
      const o = option(k, by ? tr(`${k} (bruges af /${by})`, `${k} (used by /${by})`) : k);
      o.disabled = Boolean(by);
      keys.append(o);
    }
    keys.value = d.shortcut;
    keys.addEventListener("change", () => {
      d.shortcut = keys.value as ShortcutKey | "";
      this.touch("other");
    });
    form.append(field(tr("Genvej", "Shortcut"), keys), this.errorSlot("other"));

    const tryEl = document.createElement("div");
    tryEl.className = "cmd-try";
    tryEl.setAttribute("role", "status");
    tryEl.hidden = true;
    f.tryEl = tryEl;

    const actions = document.createElement("div");
    actions.className = "cmd-actions";
    const save = button(tr("Gem", "Save"), () => {}, "save");
    save.type = "submit";
    save.classList.add("cmd-primary");
    actions.append(save);
    if (d.kind !== "ai") actions.append(button(tr("Prøv", "Try"), () => this.tryIt(), "try"));
    actions.append(button(tr("Annullér", "Cancel"), () => this.closeForm(), "cancel"));
    form.append(tryEl, actions);

    this.el.replaceChildren(form);
    this.validate();
  }

  private errorSlot(key: FieldKey): HTMLElement {
    const box = document.createElement("div");
    box.className = "cmd-errors";
    box.setAttribute("role", "alert");
    if (this.form) this.form.errorEls[key] = box;
    return box;
  }

  private touch(key: FieldKey): void {
    this.form?.touched.add(key);
    this.validate();
  }

  // Skabelon: et tekstfelt og knapper, der sætter felter ind ved markøren.
  private templateFields(d: Draft): HTMLElement[] {
    const area = textarea(d.template, 9, "body");
    area.addEventListener("input", () => {
      d.template = area.value;
      this.touch("body");
    });
    const chips = document.createElement("div");
    chips.className = "lp-spell-options";
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", tr("Sæt et felt ind", "Insert a field"));
    for (const f of FIELD_NAMES) {
      const label = tr(f.da, f.en);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lp-chip";
      b.textContent = label;
      b.addEventListener("click", () => {
        // Et sted, der skal udfyldes, får det næste ledige nummer.
        const stop = /^\d:(.*)$/.exec(label);
        const used = [...area.value.matchAll(/\{\{(\d):/g)].map((m) => Number(m[1]));
        const text = stop ? `{{${Math.min(9, Math.max(0, ...used) + 1)}:${stop[1]}}}` : `{{${label}}}`;
        area.setRangeText(text, area.selectionStart, area.selectionEnd, "end");
        area.focus();
        d.template = area.value;
        this.touch("body");
      });
      chips.append(b);
    }
    const newfile = toggle(tr("Opret som ny tekst", "Create as a new text"), d.newfile, (v) => (d.newfile = v), "newfile");
    return [field(tr("Tekst", "Text"), area), hint(tr("Sæt et felt ind, hvor markøren står:", "Insert a field at the caret:")), chips, newfile];
  }

  // Omformning: klodser fra listen, som kan flyttes op og ned.
  private transformFields(d: Draft): HTMLElement[] {
    const f = this.form;
    const list = document.createElement("ol");
    list.className = "cmd-steps";
    d.steps.forEach((s, i) => {
      const spec = specOf(s.block);
      const li = document.createElement("li");
      li.className = "cmd-step";
      const top = document.createElement("div");
      top.className = "cmd-step-top";
      const label = document.createElement("span");
      label.className = "cmd-step-name";
      label.textContent = spec ? tr(spec.da, spec.en) : s.block;
      const move = (to: number) => {
        d.steps.splice(to, 0, ...d.steps.splice(i, 1));
        this.touch("body");
        this.renderForm();
        this.focusKey(`step:${to}:${to > i ? "down" : "up"}`);
      };
      const up = icon("↑", tr("Flyt op", "Move up"), () => move(i - 1), `step:${i}:up`);
      up.disabled = i === 0;
      const down = icon("↓", tr("Flyt ned", "Move down"), () => move(i + 1), `step:${i}:down`);
      down.disabled = i === d.steps.length - 1;
      const remove = icon("×", tr("Fjern", "Remove"), () => {
        d.steps.splice(i, 1);
        this.touch("body");
        this.renderForm();
        this.focusKey("add-step");
      }, `step:${i}:remove`);
      top.append(label, up, down, remove);
      li.append(top);
      s.texts.forEach((t, n) => {
        const box = input(t, 200, `step:${i}:text:${n}`);
        box.setAttribute("aria-label", tr(`Tekst ${n + 1}`, `Text ${n + 1}`));
        box.placeholder = stepPlaceholder(s.block, n);
        box.addEventListener("input", () => {
          s.texts[n] = box.value;
          this.touch("body");
        });
        li.append(box);
      });
      if (spec && spec.options.length) {
        if (spec.min === 1 && spec.max === 1) {
          const sel = document.createElement("select");
          sel.className = "cmd-select";
          sel.dataset.key = `step:${i}:option`;
          sel.setAttribute("aria-label", tr("Valg", "Option"));
          for (const o of spec.options) sel.append(option(o, optionName(o)));
          sel.value = s.options[0] ?? spec.options[0];
          sel.addEventListener("change", () => {
            s.options = [sel.value];
            this.touch("body");
          });
          li.append(sel);
        } else {
          for (const o of spec.options) {
            li.append(
              toggle(optionName(o), s.options.includes(o), (v) => {
                // Rækkefølgen i filen følger klodsens egen liste.
                const next = new Set(s.options);
                if (v) next.add(o);
                else next.delete(o);
                s.options = spec.options.filter((x) => next.has(x));
                this.touch("body");
              }, `step:${i}:opt:${o}`),
            );
          }
        }
      }
      const err = document.createElement("div");
      err.className = "cmd-errors";
      f?.stepErrorEls.push(err);
      li.append(err);
      list.append(li);
    });

    const add = document.createElement("select");
    add.className = "cmd-select";
    add.dataset.key = "add-step";
    add.setAttribute("aria-label", tr("Tilføj et trin", "Add a step"));
    add.append(option("", tr("Tilføj et trin …", "Add a step …")));
    for (const b of BLOCKS) add.append(option(b.name, tr(b.da, b.en)));
    add.disabled = d.steps.length >= MAX_STEPS;
    add.addEventListener("change", () => {
      if (!add.value) return;
      d.steps.push(newStep(add.value));
      const at = d.steps.length - 1;
      this.touch("body");
      this.renderForm();
      // Videre til det første, der skal udfyldes i det nye trin, ellers tilbage til listen.
      const first = this.el.querySelector<HTMLElement>(`[data-key^="step:${at}:text"], [data-key^="step:${at}:opt"]`);
      if (first) first.focus();
      else this.focusKey("add-step");
    });
    const out: HTMLElement[] = [];
    if (d.steps.length) out.push(list);
    out.push(add);
    if (d.steps.length >= MAX_STEPS) out.push(hint(tr(`En omformning kan højst have ${MAX_STEPS} trin.`, `A transform can have at most ${MAX_STEPS} steps.`)));
    return out;
  }

  // Tjek: en ordliste.
  private checkFields(d: Draft): HTMLElement[] {
    const area = textarea(d.check, 8, "body");
    area.placeholder = tr("pct. => procent\nimplementere => indføre", "utilize => use\nin order to => to");
    area.addEventListener("input", () => {
      d.check = area.value;
      this.touch("body");
    });
    return [
      field(tr("Ordliste", "Word list"), area),
      hint(tr("Én regel pr. linje: først ordet, du vil undgå, så => og det, du hellere vil skrive.", "One rule per line: first the word you want to avoid, then => and what you would rather write.")),
    ];
  }

  // AI: instruks og svarform. Der findes ingen svarform, der kan rumme brødtekst.
  private aiFields(d: Draft): HTMLElement[] {
    const area = textarea(d.ai, 7, "body");
    const left = hint("");
    const showCount = () => (left.textContent = tr(`${area.value.length} af 2.000 tegn.`, `${area.value.length} of 2,000 characters.`));
    showCount();
    area.addEventListener("input", () => {
      d.ai = area.value;
      showCount();
      this.touch("body");
    });
    return [
      field(tr("Instruks", "Instruction"), area),
      left,
      radios(
        tr("Svaret er", "The answer is"),
        "cmd-output",
        [
          ["findings", tr("Fund: steder i teksten med en kommentar", "Findings: places in the text with a comment")],
          ["questions", tr("Spørgsmål til teksten", "Questions about the text")],
        ],
        d.output,
        (o) => {
          d.output = o;
          this.validate();
        },
      ),
    ];
  }

  private shortcutsTaken(): Map<string, string> {
    const f = this.form;
    const taken = new Map<string, string>();
    for (const e of everyCommand()) {
      const c = e.command;
      if (!c.shortcut) continue;
      // Kommandoen, der rettes i, og den indbyggede, kopien skygger for, tæller ikke.
      if (f && ((f.previousPath && c.path === f.previousPath) || c.name === f.draft.name.trim())) continue;
      if (!taken.has(c.shortcut)) taken.set(c.shortcut, c.name);
    }
    return taken;
  }

  /** Alle fejl, fordelt på det felt de hører til. Validatoren er den samme, som læser filerne. */
  private errors(): Record<FieldKey, CommandError[]> & { steps: CommandError[][] } {
    const f = this.form;
    const out = { name: [] as CommandError[], description: [] as CommandError[], body: [] as CommandError[], other: [] as CommandError[], steps: [] as CommandError[][] };
    if (!f) return out;
    const d = f.draft;
    const c = commandFrom(d);
    const all = validateCommand(c);
    // Validatoren giver linje 0 for hovedet og ellers linjen i kroppen. En fejl i hovedet hører til
    // det felt, den forsvinder sammen med.
    const head = (patch: Partial<Command>) => new Set(validateCommand({ ...c, ...patch }).filter((e) => e.line === 0).map((e) => e.message));
    const okName = head({ name: "x" });
    const okDescription = head({ description: "x" });
    const okBody = head({ body: GOOD_BODY[d.kind] });
    for (const e of all.filter((x) => x.line === 0)) {
      if (!okName.has(e.message)) out.name.push(e);
      else if (!okDescription.has(e.message)) out.description.push(e);
      else if (!okBody.has(e.message)) out.body.push(e);
      else out.other.push(e);
    }
    const inBody = all.filter((e) => e.line > 0);
    if (d.kind === "transform" && d.steps.length) {
      // Formularen skriver ét trin pr. linje, så linjen er trinnets nummer.
      out.steps = d.steps.map((_, i) => inBody.filter((e) => e.line === i + 1));
      out.body.push(...inBody.filter((e) => e.line > d.steps.length).map((e) => ({ ...e, line: 0 })));
    } else {
      // Linjenummeret hjælper kun i et tekstfelt med flere linjer.
      const numbered = (d.kind === "template" || d.kind === "check") && c.body.trim() !== "";
      out.body.push(...inBody.map((e) => (numbered ? e : { ...e, line: 0 })));
    }
    // To ting, validatoren ikke kan vide: navne og genveje, der allerede er i brug.
    const clash = everyCommand().find((e) => e.command.source === "user" && e.command.name === c.name && e.command.path !== f.previousPath);
    if (clash) out.name.push({ line: 0, message: tr(`Du har allerede en kommando, der hedder /${c.name}.`, `You already have a command called /${c.name}.`) });
    const by = c.shortcut ? this.shortcutsTaken().get(c.shortcut) : undefined;
    if (by) out.other.push({ line: 0, message: tr(`${c.shortcut} bruges allerede af /${by}.`, `${c.shortcut} is already used by /${by}.`) });
    return out;
  }

  private validate(): boolean {
    const f = this.form;
    if (!f) return false;
    const errs = this.errors();
    const shown = (k: FieldKey) => (f.touched.has(k) ? errs[k] : []);
    for (const k of ["name", "description", "body", "other"] as const) {
      const list = k === "other" && f.saveError ? [...shown(k), { line: 0, message: f.saveError }] : shown(k);
      f.errorEls[k]?.replaceChildren(...list.slice(0, 6).map(errorLine));
    }
    f.stepErrorEls.forEach((el, i) => el.replaceChildren(...(f.touched.has("body") ? (errs.steps[i] ?? []) : []).map((e) => errorLine({ ...e, line: 0 }))));
    return !errs.name.length && !errs.description.length && !errs.body.length && !errs.other.length && !errs.steps.some((s) => s.length);
  }

  private async save(): Promise<void> {
    const f = this.form;
    if (!f) return;
    f.saveError = "";
    for (const k of ["name", "description", "body", "other"] as const) f.touched.add(k);
    if (!this.validate()) {
      // Fokus til det første felt med en fejl.
      const errs = this.errors();
      const first = errs.name.length ? "name" : errs.description.length ? "description" : errs.other.length && !errs.body.length && !errs.steps.some((s) => s.length) ? "shortcut" : "body";
      this.focusKey(first === "body" && f.draft.kind === "transform" ? "add-step" : first);
      return;
    }
    const c = commandFrom(f.draft);
    try {
      await saveUserCommand(c, f.previousPath);
    } catch (e) {
      f.saveError = errorText(e);
      this.validate();
      return;
    }
    this.hooks.notify(tr(`/${c.name} er gemt.`, `/${c.name} is saved.`));
    this.form = null;
    this.renderList();
    this.focusKey(`edit:user:${c.name}`);
  }

  // --- prøv ----------------------------------------------------------------------------------------

  /** Kør kommandoen på det markerede eller et eksempel, og vis før og efter. Teksten røres ikke. */
  private tryIt(): void {
    const f = this.form;
    if (!f?.tryEl) return;
    f.touched.add("body");
    this.validate();
    const errs = this.errors();
    const box = f.tryEl;
    box.hidden = false;
    if (errs.body.length || errs.steps.some((s) => s.length)) return void box.replaceChildren(hint(tr("Ret fejlene først.", "Fix the errors first.")));
    const c = commandFrom(f.draft);
    if (c.kind === "transform" && !c.body.trim()) return void box.replaceChildren(hint(tr("Tilføj et trin først.", "Add a step first.")));
    box.replaceChildren(...this.preview(c), hint(tr("Intet er ændret i teksten.", "Nothing in the text has changed.")));
  }

  /** Det, kommandoen gør, prøvet på det markerede eller på et eksempel. En AI-kommando vises som sin instruks. */
  private preview(c: Command): HTMLElement[] {
    const lang = currentLang();
    const { from, to } = this.view.state.selection.main;
    const selection = this.view.state.sliceDoc(from, to);
    const doc = this.view.state.doc.toString();
    try {
      if (c.kind === "template") {
        const n = count(doc);
        const fc = this.hooks.fileContext();
        const r = expandTemplate(c.body, { now: new Date(), lang, name: fc.name, filename: fc.filename, title: fc.title, selection, words: n.words, characters: n.chars, readingMinutes: n.minutes });
        return [sample(tr("Sådan bliver det", "This is what you get"), r.text)];
      }
      if (c.kind === "transform") {
        const input = selection || EXAMPLE;
        const r = applyChain(parseChain(c.body).steps, input, lang);
        const then = r.then === "clip" ? tr("Bagefter flyttes teksten til Fraklip.", "Afterwards the text moves to Clippings.") : r.then === "footnote" ? tr("Bagefter bliver teksten til en fodnote.", "Afterwards the text becomes a footnote.") : "";
        return [
          hint(selection ? tr("Prøvet på det, du har markeret.", "Tried on your selection.") : tr("Prøvet på et eksempel. Markér noget i teksten for at prøve på det.", "Tried on an example. Select something in the text to try it on that.")),
          sample(tr("Før", "Before"), input),
          sample(tr("Efter", "After"), r.text),
          ...(then ? [hint(then)] : []),
        ];
      }
      if (c.kind === "check") {
        const text = selection || withoutParked(doc);
        const found = runCheck(c, text, lang);
        const lines = found.slice(0, 8).map((x) => (x.comment ? `${x.excerpt}: ${x.comment}` : x.excerpt));
        return [
          hint(
            (selection ? tr("Prøvet på det, du har markeret. ", "Tried on your selection. ") : tr("Prøvet på hele teksten. ", "Tried on the whole text. ")) +
              (found.length ? tr(`${found.length} fund.`, found.length === 1 ? "1 finding." : `${found.length} findings.`) : tr("Ingen fund.", "No findings.")),
          ),
          ...(lines.length ? [sample(tr("De første", "The first ones"), lines.join("\n"))] : []),
        ];
      }
      return [sample(tr("Instruksen", "The instruction"), c.body)];
    } catch (e) {
      return [errorLine({ line: 0, message: errorText(e) })];
    }
  }

  // --- forslaget: navn, prøve og Gem -------------------------------------------------------------------

  /** Et navn, ingen anden kommando har eller svarer på: »tjekliste«, ellers »tjekliste-2« og så videre. */
  private freeName(wanted: string): string {
    const taken = new Set(everyCommand().flatMap((e) => [e.command.name, ...e.command.aliases]));
    const base = wanted.slice(0, 21).replace(/-+$/, "") || tr("kommando", "command");
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  /** Det markerede bliver en skabelon, der sætter netop den tekst ind. Uden AI. */
  private selectionAsTemplate(): void {
    const { from, to } = this.view.state.selection.main;
    const text = this.view.state.sliceDoc(from, to).trim();
    if (!text) return this.hooks.notify(tr("Markér først den tekst, der skal blive en skabelon.", "First select the text that should become a template."));
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const first = text.split("\n")[0].replace(/\s+/g, " ");
    const shown = first.length > 50 ? `${first.slice(0, 49)}…` : first;
    this.showProposal(
      {
        name: this.freeName(words.slice(0, 2).join("-")),
        kind: "template",
        description: tr(`Sætter »${shown}« ind`, `Inserts “${shown}”`),
        aliases: [],
        scope: "selection",
        newfile: false,
        // Klammer i teksten skal blive stående som klammer og ikke læses som felter.
        body: text.replace(/\{\{/g, "\\{{"),
        source: "user",
      },
      "selection",
    );
  }

  private showProposal(c: Command, from: "ai" | "selection"): void {
    this.mode = "proposal";
    this.confirmDelete = null;
    this.proposal = { command: c, from };
    this.renderProposal();
    this.focusKey("proposal-save");
  }

  private renderProposal(): void {
    const p = this.proposal;
    if (!p) return this.renderList();
    const c = p.command;
    const form = document.createElement("form");
    form.className = "cmd-form";
    form.noValidate = true;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.saveProposal();
    });
    const head = document.createElement("div");
    head.className = "cmd-form-head";
    const title = document.createElement("strong");
    title.textContent = p.from === "ai" ? tr("Forslag", "Suggestion") : tr("Ny skabelon", "New template");
    head.append(title, link(tr("Tilbage", "Back"), () => this.closeProposal(), "back"));

    const name = input(c.name, 24, "proposal-name");
    name.spellcheck = false;
    name.setAttribute("aria-label", tr("Navn", "Name"));
    const errors = document.createElement("div");
    errors.className = "cmd-errors";
    errors.setAttribute("role", "alert");
    name.addEventListener("input", () => {
      const clean = name.value.replace(/^\/+/, "").toLowerCase();
      if (clean !== name.value) name.value = clean;
      c.name = clean;
      errors.replaceChildren();
    });
    const nameRow = document.createElement("div");
    nameRow.className = "cmd-name-field";
    const slash = document.createElement("span");
    slash.textContent = "/";
    slash.setAttribute("aria-hidden", "true");
    nameRow.append(slash, name);

    const desc = document.createElement("p");
    desc.className = "cmd-desc";
    desc.textContent = c.description;

    const tryEl = document.createElement("div");
    tryEl.className = "cmd-try";
    tryEl.replaceChildren(hint(kindHint(c.kind)), ...this.preview(c));

    const save = button(tr("Gem", "Save"), () => {}, "proposal-save");
    save.type = "submit";
    save.classList.add("cmd-primary");
    const actions = document.createElement("div");
    actions.className = "cmd-actions";
    actions.append(
      save,
      button(tr("Ret selv", "Edit it yourself"), () => {
        this.proposal = null;
        this.openForm(c, tr(`Ret /${c.name}`, `Edit /${c.name}`), tr("Den er ikke gemt endnu. Tryk Gem, når den er, som du vil have den.", "It isn't saved yet. Press Save when it is the way you want it."));
      }, "proposal-edit"),
    );
    if (p.from === "ai") {
      actions.append(
        button(tr("Beskriv igen", "Describe again"), () => {
          this.proposal = null;
          this.openDescribe();
        }, "proposal-again"),
      );
    }
    form.append(head, field(tr("Du skriver", "You type"), nameRow), errors, desc, tryEl, actions);
    this.el.replaceChildren(form);
  }

  private closeProposal(): void {
    this.proposal = null;
    this.renderList();
    this.focusKey("describe");
  }

  private async saveProposal(): Promise<void> {
    const p = this.proposal;
    if (!p) return;
    const c = p.command;
    const show = (message: string) => {
      this.el.querySelector(".cmd-errors")?.replaceChildren(errorLine({ line: 0, message }));
      this.focusKey("proposal-name");
    };
    const problems = validateCommand(c);
    if (problems.length) return show(problems[0].message);
    if (this.freeName(c.name) !== c.name) return show(tr(`/${c.name} findes allerede. Vælg et andet navn.`, `/${c.name} already exists. Choose another name.`));
    try {
      await saveUserCommand(c);
    } catch (e) {
      return show(errorText(e));
    }
    this.describe.text = "";
    this.proposal = null;
    this.hooks.notify(tr(`/${c.name} er gemt. Skriv /${c.name} i teksten for at bruge den.`, `/${c.name} is saved. Type /${c.name} in the text to use it.`));
    this.renderList();
    this.focusKey(`edit:user:${c.name}`);
  }

  // --- beskriv en kommando (research 3.6) ------------------------------------------------------------

  private openDescribe(): void {
    this.mode = "describe";
    this.confirmDelete = null;
    this.describe.message = "";
    this.describe.asking = false;
    this.renderDescribe();
    this.focusKey("describe-text");
  }

  private renderDescribe(): void {
    const st = this.describe;
    const ai = this.ai;
    const form = document.createElement("form");
    form.className = "cmd-form";
    const head = document.createElement("div");
    head.className = "cmd-form-head";
    const title = document.createElement("strong");
    title.textContent = tr("Beskriv en kommando", "Describe a command");
    head.append(
      title,
      link(tr("Tilbage", "Back"), () => {
        st.run++;
        st.busy = false;
        this.renderList();
        this.focusKey("describe");
      }, "back"),
    );
    const area = textarea(st.text, 6, "describe-text");
    area.maxLength = 1000;
    area.disabled = st.busy;
    area.placeholder = tr("For eksempel: en rettelsesnote med dagens dato", "For example: a correction note with today's date");
    area.addEventListener("input", () => (st.text = area.value));
    form.append(
      head,
      field(tr("Hvad skal kommandoen kunne?", "What should the command do?"), area),
      hint(
        tr(
          `${ai?.name ?? "AI-hjælpen"} foreslår en kommando ud fra beskrivelsen. Du ser forslaget, før noget gemmes. Kun beskrivelsen sendes, ikke din tekst.`,
          `${ai?.name ?? "AI help"} suggests a command from the description. You see the suggestion before anything is saved. Only the description is sent, not your text.`,
        ),
      ),
    );
    if (st.asking && ai) {
      const box = document.createElement("div");
      box.className = "cl-message";
      box.setAttribute("role", "status");
      const p = document.createElement("p");
      p.textContent = tr(`Beskrivelsen sendes til ${ai.name} via din egen konto. Gode Medier ser den ikke.`, `The description is sent to ${ai.name} through your own account. Gode Medier doesn't see it.`);
      const row = document.createElement("div");
      row.className = "cmd-actions";
      row.append(
        button(tr("Send", "Send"), () => {
          try {
            localStorage.setItem(`gt-ai-describe-ok-${ai.id}`, "1");
          } catch {
            // Lagringen kan være spærret. Så spørges der igen næste gang.
          }
          st.asking = false;
          void this.suggest();
        }, "consent-yes"),
        button(tr("Annullér", "Cancel"), () => {
          st.asking = false;
          this.renderDescribe();
          this.focusKey("describe-text");
        }, "consent-no"),
      );
      box.append(p, row);
      form.append(box);
    } else if (st.busy) {
      const box = document.createElement("div");
      box.className = "cl-running";
      box.setAttribute("role", "status");
      const line = document.createElement("div");
      line.className = "cl-progress";
      line.setAttribute("aria-hidden", "true");
      const top = document.createElement("div");
      top.className = "cl-running-top";
      const label = document.createElement("strong");
      label.textContent = tr(`Spørger ${ai?.name ?? "AI-hjælpen"}`, `Asking ${ai?.name ?? "AI help"}`);
      top.append(
        label,
        link(tr("Stop", "Stop"), () => {
          st.run++;
          st.busy = false;
          void invoke("claude_cancel").catch(() => {});
          this.renderDescribe();
          this.focusKey("describe-text");
        }, "stop"),
      );
      box.append(line, top);
      form.append(box);
    } else {
      if (st.message) {
        const m = document.createElement("p");
        m.className = "cl-message";
        m.setAttribute("role", "status");
        m.textContent = st.message;
        form.append(m);
      }
      const actions = document.createElement("div");
      actions.className = "cmd-actions";
      const go = button(tr("Lav kommandoen", "Make the command"), () => {}, "suggest");
      go.type = "submit";
      go.classList.add("cmd-primary");
      actions.append(
        go,
        button(tr("Annullér", "Cancel"), () => {
          this.renderList();
          this.focusKey("describe");
        }, "cancel"),
      );
      form.append(actions);
    }
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.suggest();
    });
    this.el.replaceChildren(form);
  }

  /** Har brugeren sagt ja til at sende til den udbyder, enten her eller i resten af AI-hjælpen? */
  private describeAllowed(id: string): boolean {
    try {
      return Boolean(localStorage.getItem(`gt-ai-ok-${id}`) || localStorage.getItem(`gt-ai-describe-ok-${id}`));
    } catch {
      return true; // som resten af AI-hjælpen: uden lagring kan der ikke spørges kun én gang
    }
  }

  private async suggest(): Promise<void> {
    const st = this.describe;
    const ai = this.ai;
    if (st.busy || !ai) return;
    const description = st.text.trim();
    if (!description) {
      st.message = tr("Skriv først, hvad kommandoen skal kunne.", "First write what the command should do.");
      this.renderDescribe();
      return this.focusKey("describe-text");
    }
    if (!this.describeAllowed(ai.id)) {
      st.asking = true;
      this.renderDescribe();
      return this.focusKey("consent-yes");
    }
    const run = ++st.run;
    st.busy = true;
    st.message = "";
    this.renderDescribe();
    this.focusKey("stop");
    let design: AiDesign;
    try {
      design = await invoke<AiDesign>("ai_design_command", { description, catalog: designCatalog() });
    } catch (e) {
      if (run !== st.run) return;
      st.busy = false;
      st.message = errorText(e);
      this.renderDescribe();
      return this.focusKey("describe-text");
    }
    if (run !== st.run) return;
    st.busy = false;
    if (!design.possible) {
      st.message = design.reason || tr("Det kan ikke bygges af kommandoernes klodser.", "That can't be built from the command blocks.");
      this.renderDescribe();
      return this.focusKey("describe-text");
    }
    const c: Command = {
      name: design.name,
      kind: design.kind,
      description: design.description,
      aliases: [],
      scope: design.scope,
      newfile: false,
      output: design.kind === "ai" ? design.output || undefined : undefined,
      body: design.body,
      source: "user",
    };
    // Et navn, der er taget, får et tal på, så forslaget ikke skygger for en anden kommando.
    c.name = this.freeName(c.name);
    // Samme validator som for filer og formularen: modellen kan ikke bygge noget, man ikke selv kunne.
    const errors = validateCommand(c);
    if (errors.length) {
      st.message = `${tr("Forslaget kunne ikke bruges.", "The suggestion could not be used.")} ${errors.slice(0, 3).map((e) => e.message).join(" ")}`;
      this.renderDescribe();
      return this.focusKey("describe-text");
    }
    // Forslaget vises med en prøve på det markerede eller et eksempel (research 3.6 punkt 4).
    this.showProposal(c, "ai");
  }
}

// --- små byggesten ---------------------------------------------------------------------------------

function button(label: string, run: () => void, key: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cmd-button";
  b.textContent = label;
  b.dataset.key = key;
  b.addEventListener("click", run);
  return b;
}

function link(label: string, run: () => void, key: string): HTMLButtonElement {
  const b = button(label, run, key);
  b.className = "settings-link";
  return b;
}

function icon(sign: string, label: string, run: () => void, key: string): HTMLButtonElement {
  const b = button(sign, run, key);
  b.className = "cmd-icon";
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

function tools(items: HTMLElement[]): HTMLElement {
  const t = document.createElement("div");
  t.className = "cmd-tools";
  t.append(...items);
  return t;
}

function heading(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.className = "cmd-group";
  h.textContent = text;
  return h;
}

function hint(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "lp-hint";
  p.textContent = text;
  return p;
}

function tag(text: string): HTMLElement {
  const s = document.createElement("small");
  s.className = "cmd-kind";
  s.textContent = text;
  return s;
}

function errorLine(e: CommandError): HTMLElement {
  const p = document.createElement("p");
  p.className = "cmd-error";
  p.textContent = e.line > 0 ? tr(`Linje ${e.line}: ${e.message}`, `Line ${e.line}: ${e.message}`) : e.message;
  return p;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const l = document.createElement("label");
  l.className = "cmd-field";
  const s = document.createElement("span");
  s.textContent = label;
  l.append(s, control);
  return l;
}

function input(value: string, max: number, key: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "text";
  i.className = "settings-name";
  i.value = value;
  i.maxLength = max;
  i.dataset.key = key;
  return i;
}

function textarea(value: string, rows: number, key: string): HTMLTextAreaElement {
  const t = document.createElement("textarea");
  t.className = "cmd-text";
  t.value = value;
  t.rows = rows;
  t.spellcheck = false;
  t.dataset.key = key;
  return t;
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function toggle(label: string, on: boolean, change: (v: boolean) => void, key: string): HTMLElement {
  const row = document.createElement("label");
  row.className = "settings-toggle";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = on;
  box.dataset.key = key;
  box.addEventListener("change", () => change(box.checked));
  const name = document.createElement("span");
  name.textContent = label;
  row.append(box, name);
  return row;
}

/** En gruppe rigtige radioknapper: piletasterne skifter, som de plejer. */
function radios<T extends string>(legend: string, group: string, items: [T, string][], current: T, change: (v: T) => void): HTMLElement {
  const set = document.createElement("fieldset");
  set.className = "cmd-radios";
  const l = document.createElement("legend");
  l.textContent = legend;
  set.append(l);
  for (const [value, label] of items) {
    const row = document.createElement("label");
    row.className = "settings-toggle";
    const r = document.createElement("input");
    r.type = "radio";
    r.className = "settings-radio";
    r.name = group;
    r.checked = value === current;
    r.dataset.key = `${group}:${value}`;
    r.addEventListener("change", () => {
      if (r.checked) change(value);
    });
    const name = document.createElement("span");
    name.textContent = label;
    row.append(r, name);
    set.append(row);
  }
  return set;
}

function sample(label: string, text: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "cmd-sample";
  const l = document.createElement("span");
  l.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = text;
  box.append(l, pre);
  return box;
}

function stepPlaceholder(block: string, n: number): string {
  if (block === "replace") return n === 0 ? tr("Find", "Find") : tr("Erstat med", "Replace with");
  if (block === "wrap") return n === 0 ? tr("Før", "Before") : tr("Efter", "After");
  return tr("Tekst", "Text");
}
