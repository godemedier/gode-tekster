// Indstillinger: et roligt vindue midt på skærmen med tre faner, Generelt, Tekst og AI-hjælp
// (6/10: »lidt bloatet«, skal være »minimalistisk, overskueligt, intuitivt«). Én indstilling
// pr. linje, navnet til venstre og valget til højre. Forklaringer kun, hvor de ændrer noget, resten
// står ved musen. Hver ændring gemmes med det samme, der er ingen Gem-knap. Bibliotekerne tilføjes
// og fjernes i biblioteksfanens oversigt (library.ts).

import { invoke } from "@tauri-apps/api/core";

import { tr } from "../i18n.ts";
import { BULLETS, settings, updateSettings, type BulletStyle, type Settings } from "../settings.ts";
import { errorText, showBanner } from "./banner.ts";
import { rememberFocus } from "./focus.ts";
import { ICON, iconButton } from "./icons.ts";
import { setLineLength } from "./lineWidth.ts";
import { statusDot } from "./libraryStatus.ts";

// Skrifterne på skrivefladen (ADR-0037, 8/10): halvmono som standard og tre valg med hver sin
// personlighed. Alle ligger i programmet (OFL). Halvmono er Recursive med mono-aksen bagt fast på 0,5.
export const FONTS = ["Recursive Halvmono", "IBM Plex Mono", "Literata", "Schibsted Grotesk"];

/** Navnene på knapperne: hvad skriften er, ikke hvad den hedder. Navnet står ved musen. */
const FONT_LABELS: Record<string, [string, string]> = {
  "Recursive Halvmono": ["Halvmono", "Semi-mono"],
  "IBM Plex Mono": ["Mono", "Mono"],
  Literata: ["Serif", "Serif"],
  "Schibsted Grotesk": ["Sans", "Sans"],
};

/** Gemte valg af skrifter, der ikke længere er på listen, flyttes til den nærmeste af samme slags. */
const RENAMED: Record<string, string> = {
  "iA Writer Duo": "IBM Plex Mono",
  "iA Writer Quattro": "Recursive Halvmono",
  Arial: "Schibsted Grotesk",
  Georgia: "Literata",
  "IBM Plex Sans": "Schibsted Grotesk",
  "IBM Plex Serif": "Literata",
  "Avenir Next": "Schibsted Grotesk",
};

/** Navnet på listen for et gemt valg. En ukendt skrift bliver til standarden. */
export function fontName(saved: string): string {
  const renamed = RENAMED[saved] ?? saved;
  return FONTS.includes(renamed) ? renamed : FONTS[0];
}

/** CSS-skriften for et gemt valg. */
export function fontStack(saved: string): string {
  return `"${fontName(saved)}"`;
}

export class SettingsPanel {
  private sheet: HTMLElement;
  private restore: (() => void) | null = null;
  /** Den flytbare udgave (autostart.rs): uden »Start med Windows«. */
  private portable = false;
  /** Den åbne fane. Vinduet åbner altid på Generelt (6/10). */
  private tab = "generelt";
  /** Faner, som andre moduler sætter ind (Kommandoer, 7/10). De har deres egen tilstand. */
  private extra: ExtraTab[] = [];

  // Biblioteker styres i biblioteksfanen (3/10), ikke her.
  constructor() {
    this.sheet = document.createElement("div");
    this.sheet.className = "settings";
    this.sheet.setAttribute("role", "dialog");
    this.sheet.setAttribute("aria-modal", "true");
    this.sheet.setAttribute("aria-label", tr("Indstillinger", "Settings"));
    this.sheet.hidden = true;
    this.sheet.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    // Et klik uden for vinduet lukker det.
    this.sheet.addEventListener("mousedown", (e) => {
      if (e.target === this.sheet) this.close();
    });
    document.body.append(this.sheet);
    void invoke<boolean>("portable")
      .then((p) => (this.portable = p))
      .catch(() => {});
  }

  get isOpen(): boolean {
    return !this.sheet.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** En fane efter de faste. `mount` får fanens tomme flade, hver gang vinduet tegnes. */
  addTab(tab: ExtraTab): void {
    this.extra.push(tab);
  }

  open(tab = "generelt"): void {
    this.restore = rememberFocus();
    this.tab = tab;
    this.render();
    this.sheet.hidden = false;
    // Fokus på den åbne fane, så Esc, Tab og pilene virker med det samme (også efter Ctrl+,).
    window.setTimeout(() => this.sheet.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(), 0);
    requestAnimationFrame(() => this.sheet.classList.add("open"));
    document.body.classList.add("settings-open");
  }

  close(): void {
    if (this.sheet.hidden) return;
    this.restore?.();
    this.restore = null;
    this.sheet.classList.remove("open");
    document.body.classList.remove("settings-open");
    window.setTimeout(() => {
      if (!this.sheet.classList.contains("open")) this.sheet.hidden = true;
    }, 220);
  }

  private render(): void {
    const s = settings();
    const set = (patch: Partial<Settings>) => void updateSettings(patch).then(() => this.render());

    const head = document.createElement("div");
    head.className = "settings-head";
    const title = document.createElement("span");
    title.textContent = tr("Indstillinger", "Settings");
    head.append(title, iconButton(ICON.close, tr("Luk (Esc)", "Close (Esc)"), () => this.close()));

    // Skrift: hvert navn står i sin egen skrift, så valget kan ses.
    const fonts = choices(
      FONTS.map((f) => ({ value: f, label: tr(...FONT_LABELS[f]), title: f, font: fontStack(f) })),
      fontName(s.font),
      (v) => set({ font: v }),
      tr("Skrift", "Font"),
      "st-fonts",
    );

    const width = document.createElement("input");
    width.type = "range";
    width.min = "50";
    width.max = "90";
    width.step = "2";
    width.value = String(s.lineLength);
    width.setAttribute("aria-label", tr("Linjebredde", "Line width"));
    const widthValue = document.createElement("span");
    widthValue.className = "st-value";
    widthValue.textContent = tr(`${s.lineLength} tegn`, `${s.lineLength} chars`);
    width.addEventListener("input", () => {
      widthValue.textContent = tr(`${width.value} tegn`, `${width.value} chars`);
      void setLineLength(Number(width.value), fontStack(s.font));
    });
    width.addEventListener("change", () => set({ lineLength: Number(width.value) }));
    const widthBox = document.createElement("div");
    widthBox.className = "st-range";
    widthBox.append(width, widthValue);

    const paragraphs = choices(
      [
        { value: "luft", label: tr("Luft", "Space"), title: tr("Afstand mellem afsnit", "Space between paragraphs") },
        {
          value: "indryk",
          label: tr("Indryk", "Indent"),
          title: tr("Indrykning af første linje. En ekstra tom linje giver afstand mellem to afsnit.", "First-line indent. An extra blank line adds space between two paragraphs."),
        },
      ],
      s.paragraphs ?? "luft",
      (v) => set({ paragraphs: v as Settings["paragraphs"] }),
      tr("Afsnit", "Paragraphs"),
    );

    const quotes = choices(
      [
        { value: "guillemets", label: "»citat«" },
        { value: "curly", label: "”citat”" },
        { value: "low", label: "„citat“", title: tr("Hævede og sænkede, som i traditionel dansk", "Low and high, as in traditional Danish") },
      ],
      s.quotes,
      (v) => set({ quotes: v as Settings["quotes"] }),
      tr("Anførselstegn", "Quotation marks"),
    );

    // Punkttegn (5/10): tegnene selv, navnet som forklaring ved musen.
    const NAMES: Record<BulletStyle, string> = {
      streg: tr("Streg", "Dash"),
      prik: tr("Prik", "Dot"),
      pil: tr("Pil", "Arrow"),
      stjerne: tr("Stjerne", "Star"),
      ring: tr("Ring", "Circle"),
    };
    const bullets = choices(
      (Object.entries(BULLETS) as [BulletStyle, string][]).map(([value, ch]) => ({ value, label: ch, title: NAMES[value] })),
      s.bulletStyle ?? "streg",
      (v) => set({ bulletStyle: v as BulletStyle }),
      tr("Punkttegn", "Bullet"),
      "st-glyphs",
    );

    // Kommatjekket i stiltjekket (7/10): Dansk Sprognævns to systemer, eller slet ikke.
    const comma = choices(
      [
        { value: "start", label: tr("Startkomma", "Start comma"), title: tr("Komma foran ledsætninger: »Han sagde, at …«", "Comma before subordinate clauses") },
        { value: "uden", label: tr("Uden startkomma", "No start comma"), title: tr("Intet komma foran ledsætninger: »Han sagde at …«", "No comma before subordinate clauses") },
        { value: "fra", label: tr("Fra", "Off"), title: tr("Stiltjekket ser ikke på komma", "The style check ignores commas") },
      ],
      s.commaStyle ?? "start",
      (v) => set({ commaStyle: v as Settings["commaStyle"] }),
      tr("Komma", "Commas"),
    );

    // Udseendet (ADR-0037): »Skifter selv« går til aften ved solnedgang og tilbage ved solopgang.
    const theme = choices(
      [
        { value: "lys", label: tr("Lys", "Light") },
        { value: "moerk", label: tr("Mørk", "Dark") },
        { value: "aften", label: tr("Aften", "Evening"), title: tr("Ravgult lys på mørk bund", "Amber light on a dark ground") },
        {
          value: "auto",
          label: tr("Skifter selv", "Automatic"),
          title: tr("Lys om dagen, aften fra solnedgang til solopgang", "Light by day, evening from sunset to sunrise"),
        },
      ],
      s.theme ?? (s.dark ? "moerk" : "lys"),
      (v) => set({ theme: v as Settings["theme"] }),
      tr("Udseende", "Appearance"),
    );

    // Sprog (5/10): et skift gemmer og tegner vinduerne forfra (main.ts).
    const language = choices(
      [
        { value: "auto", label: tr("Som Windows", "As Windows") },
        { value: "da", label: "Dansk" },
        { value: "en", label: "English" },
      ],
      s.language ?? "auto",
      (v) => set({ language: v as Settings["language"] }),
      "Sprog · Language",
    );

    const text = panel(
      group(
        null,
        row(tr("Skrift", "Font"), fonts, { wide: true }),
        row(tr("Linjebredde", "Line width"), widthBox),
        row(tr("Afsnit", "Paragraphs"), paragraphs),
        row(tr("Anførselstegn", "Quotation marks"), quotes),
        row(tr("Punkttegn", "Bullet"), bullets),
        row(tr("Komma i stiltjekket", "Commas in the style check"), comma),
        row(tr("Udseende", "Appearance"), theme),
      ),
      // Markdown-tegnene (7/10): fire visninger af den samme fil. Standard er tegn ved markøren.
      group(
        tr("Markdown", "Markdown"),
        radioList(
          [
            { value: "skjul", label: tr("Skjul helt", "Hide completely") },
            { value: "markoer", label: tr("Vis tegn ved markør", "Show marks at the cursor") },
            { value: "alle", label: tr("Vis tegn og formatering", "Show marks and formatting") },
            { value: "raa", label: tr("Vis kun ren markdown", "Plain markdown only") },
          ],
          s.markMode ?? (s.hideMarks ? "skjul" : "markoer"),
          (v) => set({ markMode: v as Settings["markMode"] }),
          tr("Markdown", "Markdown"),
        ),
      ),
      group(
        tr("Mens du skriver", "While you write"),
        switchRow(tr("Fokus på afsnittet", "Focus on paragraph"), "Ctrl+D", s.focusMode, (v) => set({ focusMode: v })),
        switchRow(tr("Teksten ruller som på en skrivemaskine", "Typewriter scrolling"), "Ctrl+T", s.typewriter, (v) => set({ typewriter: v })),
        switchRow(tr("Ordoptælling altid synlig", "Always show word count"), "", s.alwaysShowCount, (v) => set({ alwaysShowCount: v })),
        switchRow(tr("Sluk wifi i Ro på", "Turn off Wi-Fi in Quiet mode"), "F11", s.roWifi ?? false, (v) => set({ roWifi: v })),
      ),
    );
    const ai = panel(aiSection());
    const general = panel(
      group(
        null,
        row(tr("Dit navn", "Your name"), nameField(), { hint: tr("Bruges i byline og forfatterskab.", "Used for the byline and authorship.") }),
        row("Sprog · Language", language, s.language === "en" ? { hint: "Word classes and the style check are only available in Danish." } : {}),
        ...(this.portable ? [] : [switchRow(tr("Start med Windows", "Start with Windows"), "", s.startWithWindows, (v) => set({ startWithWindows: v }))]),
        switchRow(tr("Automatiske opdateringer i baggrunden", "Automatic updates in the background"), "", s.checkUpdates, (v) => set({ checkUpdates: v })),
      ),
      group(tr("Status i biblioteket", "Status in the library"), statusEditor(() => this.render())),
      aboutLine(),
    );

    const extra = this.extra.map((t) => {
      const p = panel();
      p.classList.add("st-panel-flush");
      t.mount(p);
      return { id: t.id, label: t.label, panel: p };
    });
    const tabs = tabbar(
      [
        { id: "generelt", label: tr("Generelt", "General"), panel: general },
        { id: "tekst", label: tr("Tekst", "Text"), panel: text },
        { id: "ai", label: tr("AI-hjælp", "AI help"), panel: ai },
        ...extra,
      ],
      this.tab,
      (id) => (this.tab = id),
    );

    const box = document.createElement("div");
    box.className = "settings-box st";
    box.append(head, tabs, general, text, ai, ...extra.map((t) => t.panel));
    this.sheet.replaceChildren(box);
  }
}

/** Version, afsender og licenser i én linje nederst (delbar udgave 3/10). Licenserne åbnes som fil. */
function aboutLine(): HTMLElement {
  const box = document.createElement("div");
  box.className = "st-about";
  const version = document.createElement("span");
  version.textContent = "Gode Tekster";
  void invoke<{ version: string }>("app_info").then((i) => (version.textContent = `Gode Tekster ${i.version}`));
  box.append(
    version,
    linkButton("godemedier.dk", () => void invoke("open_url", { url: "https://godemedier.dk" })),
    linkButton(tr("Skriv til Gode Medier", "Write to Gode Medier"), () => void invoke("write_feedback_mail", { subject: "Gode Tekster" })),
    linkButton(tr("Licenser", "Licenses"), () => void invoke("open_licenses").catch((e) => showBanner(errorText(e)))),
  );
  return box;
}

function linkButton(label: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "settings-link";
  b.textContent = label;
  b.addEventListener("click", run);
  return b;
}

type AiState = { chosen: string | null; providers: { id: string; name: string; ready: boolean; detail: string }[] };
/** Det sidste svar fra ai_status, vist med det samme, når panelet tegnes igen. */
let lastAi: AiState | null = null;

const GET: Record<string, { label: string; url: string }> = {
  claude: { label: tr("Hent Claude", "Get Claude"), url: "https://claude.ai/download" },
  codex: { label: tr("Hent Codex", "Get Codex"), url: "https://developers.openai.com/codex" },
  gemini: { label: tr("Hent en gratis nøgle", "Get a free key"), url: "https://aistudio.google.com/apikey" },
  mistral: { label: tr("Hent en nøgle", "Get a key"), url: "https://console.mistral.ai/api-keys" },
};
/** Udbydere med en nøgle, som brugeren selv indsætter (gemini.rs, mistral.rs). */
const KEYED = ["gemini", "mistral"];

/**
 * AI-hjælpen (delbar udgave 3/10, fase 3): brugerens eget Claude-, ChatGPT-, Gemini- eller
 * Mistral-abonnement. Én linje pr. udbyder. Kun en udbyder, der er klar, kan vælges. En nøgle går
 * direkte til Rust og vises aldrig igen.
 */
function aiSection(): HTMLElement {
  const box = document.createElement("div");
  box.className = "st-group st-ai";
  const wait = (text: string) => {
    const p = document.createElement("p");
    p.className = "st-note";
    p.textContent = text;
    box.replaceChildren(p);
  };
  wait(tr("Tjekker, hvad der er installeret …", "Checking what is installed …"));
  const render = (state: AiState) => {
    const rows = state.providers.map((p) => {
      const left = document.createElement("label");
      left.className = "st-ai-name";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "ai";
      radio.checked = state.chosen === p.id;
      radio.disabled = !p.ready;
      radio.addEventListener("change", () => {
        if (lastAi) lastAi = { ...lastAi, chosen: p.id };
        void updateSettings({ aiProvider: p.id }).then(() => window.dispatchEvent(new Event("gt-ai-changed")));
      });
      const name = document.createElement("span");
      name.textContent = p.name;
      left.append(radio, name);
      const control = document.createElement("div");
      control.className = "st-ai-action";
      const get = GET[p.id];
      if (KEYED.includes(p.id) && !p.ready) {
        const key = document.createElement("input");
        key.type = "password";
        key.className = "st-input st-key";
        key.placeholder = tr("Nøgle", "Key");
        key.setAttribute("aria-label", tr(`Nøgle til ${p.name}`, `${p.name} key`));
        const save = linkButton(tr("Gem", "Save"), async () => {
          save.textContent = tr("Prøver …", "Trying …");
          try {
            await invoke(`${p.id}_set_key`, { key: key.value });
            key.value = "";
            await updateSettings({ aiProvider: p.id });
            window.dispatchEvent(new Event("gt-ai-changed"));
            void load(false);
          } catch (e) {
            save.textContent = tr("Gem", "Save");
            showBanner(errorText(e));
          }
        });
        control.append(key, save);
      } else if (KEYED.includes(p.id)) {
        control.append(linkButton(tr("Fjern nøglen", "Remove the key"), () => void invoke(`${p.id}_clear_key`).then(() => load(true))));
      }
      if (get && !p.ready) control.append(linkButton(get.label, () => void invoke("open_url", { url: get.url })));
      return row(left, control, { hint: p.detail });
    });
    const note = document.createElement("p");
    note.className = "st-note";
    note.textContent = tr(
      "Teksten sendes til den udbyder, du vælger, via din egen konto. Gode Medier ser hverken tekst eller nøgler.",
      "Your text is sent to the provider you choose, through your own account. Gode Medier never sees your text or keys.",
    );
    note.append(" ", linkButton(tr("Tjek igen", "Check again"), () => void load(true)));
    box.replaceChildren(...rows, note);
  };
  const load = async (refresh: boolean) => {
    if (refresh) wait(tr("Tjekker igen …", "Checking again …"));
    try {
      lastAi = await invoke<AiState>("ai_status", { refresh });
      render(lastAi);
    } catch (e) {
      wait(errorText(e));
    }
  };
  // Hele panelet tegnes forfra ved hvert valg. Uden det sidste svar stod der »Tjekker …« et øjeblik,
  // og fanen hoppede (5/10, ved skift af anførselstegn).
  if (lastAi) render(lastAi);
  void load(false);
  return box;
}

/**
 * Statusserne i biblioteket (ADR-0038): navnene kan rettes, og der kan lægges flere til. Filerne gemmer
 * id'et, så et nyt navn ikke mister teksterne. Den sidste betyder færdig og bliver stående sidst.
 */
function statusEditor(refresh: () => void): HTMLElement {
  const box = document.createElement("div");
  box.className = "st-statuses";
  const list = settings().statuses ?? [];
  const save = (next: { id: string; name: string }[]) => void updateSettings({ statuses: next }).then(refresh);
  list.forEach((s, i) => {
    const r = document.createElement("div");
    r.className = "st-status";
    const name = document.createElement("input");
    name.type = "text";
    name.className = "st-input";
    name.value = s.name;
    name.setAttribute("aria-label", tr(`Status ${i + 1}`, `Status ${i + 1}`));
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (v) save(list.map((x, j) => (j === i ? { ...x, name: v } : x)));
      else name.value = s.name;
    });
    const remove = iconButton(ICON.close, tr("Fjern status (teksterne beholder deres tekst)", "Remove status (the texts keep their text)"), () => save(list.filter((_, j) => j !== i)));
    remove.disabled = list.length <= 2;
    r.append(statusDot(s.id), name, remove);
    box.append(r);
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "settings-link";
  add.textContent = tr("Tilføj status", "Add status");
  // En ny status lægges før den sidste, så »færdig« bliver ved med at stå sidst.
  add.addEventListener("click", () => save([...list.slice(0, -1), { id: `s${Date.now().toString(36)}`, name: tr("Ny status", "New status") }, ...list.slice(-1)]));
  const hint = document.createElement("p");
  hint.className = "st-hint";
  hint.textContent = tr("Den sidste betyder færdig. Klik på prikken ved en tekst i biblioteket for at give den en status.", "The last one means done. Click the dot next to a text in the library to give it a status.");
  box.append(add, hint);
  return box;
}

/** »Dit navn« (delbar udgave 3/10): bruges i byline, sidehoved og forfatterskab. Tomt felt: ingen byline. */
function nameField(): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "st-input";
  input.value = settings().authorName ?? "";
  input.setAttribute("aria-label", tr("Dit navn", "Your name"));
  input.addEventListener("change", () => void updateSettings({ authorName: input.value.trim() }));
  return input;
}

// --- byggestenene: faner, grupper, linjer og valg ------------------------------------------------

type Tab = { id: string; label: string; panel: HTMLElement };
export type ExtraTab = { id: string; label: string; mount: (host: HTMLElement) => void };

/** Fanerne øverst. Pil til venstre og højre skifter, som i en tablist. */
function tabbar(items: Tab[], current: string, change: (id: string) => void): HTMLElement {
  const nav = document.createElement("div");
  nav.className = "st-tabs";
  nav.setAttribute("role", "tablist");
  const active = items.some((t) => t.id === current) ? current : items[0].id;
  const buttons = items.map((t) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.id = `st-tab-${t.id}`;
    b.textContent = t.label;
    t.panel.id = `st-panel-${t.id}`;
    t.panel.setAttribute("aria-labelledby", b.id);
    b.setAttribute("aria-controls", t.panel.id);
    return b;
  });
  const select = (i: number, focus: boolean) => {
    items.forEach((t, j) => {
      buttons[j].setAttribute("aria-selected", String(i === j));
      buttons[j].tabIndex = i === j ? 0 : -1;
      t.panel.hidden = i !== j;
    });
    change(items[i].id);
    if (focus) buttons[i].focus();
  };
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => select(i, false));
    b.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      select((i + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length, true);
    });
  });
  nav.append(...buttons);
  select(
    items.findIndex((t) => t.id === active),
    false,
  );
  return nav;
}

function panel(...children: HTMLElement[]): HTMLElement {
  const p = document.createElement("div");
  p.className = "st-panel";
  p.setAttribute("role", "tabpanel");
  p.append(...children);
  return p;
}

function group(title: string | null, ...rows: HTMLElement[]): HTMLElement {
  const g = document.createElement("div");
  g.className = "st-group";
  if (title) {
    const h = document.createElement("h3");
    h.textContent = title;
    g.append(h);
  }
  g.append(...rows);
  return g;
}

/** Én indstilling: navnet til venstre, valget til højre. `wide`: valget får sin egen linje. */
function row(label: string | HTMLElement, control: HTMLElement, opts: { hint?: string; wide?: boolean } = {}): HTMLElement {
  const r = document.createElement("div");
  r.className = opts.wide ? "st-row st-wide" : "st-row";
  const left = document.createElement("div");
  left.className = "st-label";
  if (typeof label === "string") {
    const name = document.createElement("span");
    name.textContent = label;
    left.append(name);
  } else {
    left.append(label);
  }
  if (opts.hint) {
    const h = document.createElement("p");
    h.className = "st-hint";
    h.textContent = opts.hint;
    left.append(h);
  }
  control.classList.add("st-control");
  r.append(left, control);
  return r;
}

/** En kontakt. Hele linjen kan klikkes. Genvejen står med lille skrift efter navnet. */
function switchRow(label: string, key: string, checked: boolean, change: (v: boolean) => void): HTMLElement {
  const r = document.createElement("label");
  r.className = "st-row st-switch";
  const name = document.createElement("span");
  name.className = "st-label";
  name.textContent = label;
  if (key) {
    const k = document.createElement("kbd");
    k.textContent = key;
    name.append(k);
  }
  const box = document.createElement("input");
  box.type = "checkbox";
  box.setAttribute("role", "switch");
  box.checked = checked;
  box.addEventListener("change", () => change(box.checked));
  r.append(name, box);
  return r;
}

type Choice = { value: string; label: string; title?: string; font?: string };

/** En lille knapgruppe, hvor ét valg er markeret. */
/** Valg, der er for lange til en knapgruppe: én linje pr. valg med en radioknap, som i AI-hjælp. */
function radioList(options: { value: string; label: string }[], current: string, change: (v: string) => void, label: string): HTMLElement {
  const list = document.createElement("div");
  list.className = "st-radios";
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-label", label);
  const name = `st-radio-${label.toLowerCase().replace(/\W+/g, "-")}`;
  for (const o of options) {
    const row = document.createElement("label");
    row.className = "st-radio";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.checked = o.value === current;
    input.addEventListener("change", () => change(o.value));
    const text = document.createElement("span");
    text.textContent = o.label;
    row.append(input, text);
    list.append(row);
  }
  return list;
}

function choices(options: Choice[], current: string, change: (v: string) => void, label: string, extra = ""): HTMLElement {
  const g = document.createElement("div");
  g.className = extra ? `st-choices ${extra}` : "st-choices";
  g.setAttribute("role", "radiogroup");
  g.setAttribute("aria-label", label);
  for (const o of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(o.value === current));
    b.textContent = o.label;
    if (o.title) {
      b.title = o.title;
      if (o.title !== o.label) b.setAttribute("aria-label", o.title);
    }
    if (o.font) b.style.fontFamily = o.font;
    b.addEventListener("click", () => change(o.value));
    g.append(b);
  }
  return g;
}
