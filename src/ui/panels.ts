// Sidepanelerne (2/10, runde 5): skjult som standard, glider frem, når musen når kanten,
// og væk igen 350 ms efter, den forlader dem. Knappenålen eller Ctrl+W/Ctrl+E fastgør. Om et
// panel er fastgjort, huskes i localStorage (et valg pr. maskine, ikke data). I Ro på (F11) er et
// fastgjort panel løst: skjult fra start, men det kan hentes frem som de løse (6/10).

import { tr } from "../i18n.ts";

export type Side = "left" | "right";

const LEAVE_MS = 350;

function stored(side: Side): boolean {
  try {
    return localStorage.getItem(`gt-pin-${side}`) === "1";
  } catch {
    return false;
  }
}

function store(side: Side, pinned: boolean): void {
  try {
    localStorage.setItem(`gt-pin-${side}`, pinned ? "1" : "0");
  } catch {
    // Lagringen kan være spærret. Valget gælder så kun denne kørsel.
  }
}

export class Panel {
  private side: Side;
  private panel: HTMLElement;
  private timer: number | undefined;
  private pinButtons: HTMLButtonElement[] = [];
  private shown: (() => void)[] = [];

  constructor(side: Side, panel: HTMLElement, zone: HTMLElement) {
    this.side = side;
    this.panel = panel;
    const enter = () => this.open();
    const leave = () => this.scheduleClose();
    zone.addEventListener("mouseenter", enter);
    panel.addEventListener("mouseenter", enter);
    panel.addEventListener("mouseleave", leave);
    zone.addEventListener("mouseleave", leave);
    this.setPinned(stored(side));
  }

  get pinned(): boolean {
    return document.body.classList.contains(`${this.side}-pinned`);
  }

  /** Fastgjort og vist som fastgjort. I Ro på er intet panel det. */
  get docked(): boolean {
    return this.pinned && !document.body.classList.contains("ro");
  }

  open(): void {
    window.clearTimeout(this.timer);
    const was = this.visible;
    document.body.classList.add(`${this.side}-open`);
    this.syncInert();
    if (!was) this.shown.forEach((f) => f());
  }

  get visible(): boolean {
    const b = document.body.classList;
    return b.contains(`${this.side}-open`) || this.docked;
  }

  /** Kaldes, når panelet kommer frem (indhold, der ikke tegnes, mens det er skjult). */
  onShow(f: () => void): void {
    this.shown.push(f);
  }

  /** Ctrl+W og Ctrl+E i Ro på: frem eller væk, uden at røre fastgørelsen. */
  toggleOpen(): void {
    if (document.body.classList.contains(`${this.side}-open`)) this.close();
    else this.open();
  }

  /** Luk med det samme (Esc i dispositionen). Et fastgjort panel bliver stående. */
  close(): void {
    window.clearTimeout(this.timer);
    document.body.classList.remove(`${this.side}-open`);
    this.syncInert();
  }

  /** Et panel, der hverken er åbent eller fastgjort, kan ikke ses og må ikke kunne få fokus. */
  private syncInert(): void {
    this.panel.inert = !this.visible;
  }

  scheduleClose(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      // Et åbent menupunkt, åbne indstillinger eller et felt, der skrives i, holder panelet fremme.
      const typing = this.panel.contains(document.activeElement) && document.activeElement?.matches("input, textarea");
      const settingsOpen = this.side === "left" && document.body.classList.contains("settings-open");
      if (document.querySelector(".menu") || typing || settingsOpen || this.panel.matches(":hover")) return this.scheduleClose();
      document.body.classList.remove(`${this.side}-open`);
      this.syncInert();
    }, LEAVE_MS);
  }

  setPinned(pinned: boolean): void {
    const was = this.visible;
    document.body.classList.toggle(`${this.side}-pinned`, pinned);
    if (!pinned) document.body.classList.remove(`${this.side}-open`);
    for (const b of this.pinButtons) {
      b.setAttribute("aria-pressed", String(pinned));
      b.title = pinned ? tr("Frigør", "Unpin") : tr("Fastgør", "Pin");
    }
    store(this.side, pinned);
    this.syncInert();
    if (!was && this.visible) this.shown.forEach((f) => f());
  }

  /** Kun til skærmbilleder i testtilstand: vis panelet fastgjort uden at gemme det. */
  showForTest(): void {
    document.body.classList.add(`${this.side}-pinned`);
    this.syncInert();
  }

  togglePin(): void {
    this.setPinned(!this.pinned);
  }

  /** Knappenålen nederst i panelet. */
  registerPin(button: HTMLButtonElement): void {
    button.classList.add("pin");
    this.pinButtons.push(button);
    this.setPinned(this.pinned);
  }
}
