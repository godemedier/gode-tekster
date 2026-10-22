// Hændelserne mellem modulerne (kodegennemgang 20/10). Moduler, der ikke kender hinanden, taler
// sammen gennem `window` med navne, der begynder med »gt-«. Her står de alle med deres indhold, så
// »Gå til definition« på et navn fører hertil, og så TypeScript kender `detail` uden en cast.
// Afsenderne står ved hver hændelse; modtageren er næsten altid main.ts.

export {};

declare global {
  interface WindowEventMap {
    /** Åbn indstillingerne, eventuelt på en bestemt fane (»ai«, »synk« …). Fra fladen og panelerne. */
    "gt-open-settings": CustomEvent<string | undefined>;
    /** AI-forbindelsen er ændret i indstillingerne: paneler, der viser den, henter status igen. */
    "gt-ai-changed": Event;
    /** AI-hjælp på markeringen: »factcheck«, »clean«, »cut« … (selectionToolbar.ts, kommandoer). */
    "gt-claude": CustomEvent<string>;
    /** Gem nu (fx før en handling, der læser filen). */
    "gt-save-now": Event;
    /** En ny version kan være gemt: fanen Versioner tegnes om (document.ts). */
    "gt-versions": Event;
    /** Et gem er lykkedes, og filen er lig skrivefladen (detail: stien). */
    "gt-saved": CustomEvent<string>;
    /** Teksten er flyttet eller omdøbt (document.ts, main.ts). */
    "gt-moved": CustomEvent<{ from: string; to: string }>;
    /** Noget er lagt i Fraklip: spalten viser det et øjeblik. */
    "gt-parked": Event;
    /** Vis fodnoten med denne etiket i fanen Fodnoter, klar til at skrive i (shortcuts.ts, kommandoer). */
    "gt-footnote": CustomEvent<string>;
    /** Åbn et link fra teksten: en adresse eller en anden tekst (links.ts). */
    "gt-open-link": CustomEvent<string>;
    /** Åbn en tekst på en bestemt position (søgning, struktur). */
    "gt-open-at": CustomEvent<{ path: string; pos: number }>;
    /** Gruppér det markerede som en del i Struktur (selectionToolbar.ts). */
    "gt-group": Event;
    /** Del det markerede (højreklik). */
    "gt-share": Event;
    /** Stilen eller sprogvalget er ændret: sprogpanelet og ordtallet tegnes om. */
    "gt-style": Event;
    /** Lav en skabelon af det markerede (kommandoer). */
    "gt-template-from-selection": Event;
    /** Kun til testkørsler (measure.ts): vis en fane i højre spalte. */
    "gt-test-tab": CustomEvent<string>;
    /** Kun til testkørsler (measure.ts): fastgør spalterne på en bestemt fane. */
    "gt-test-panels": CustomEvent<{ left?: "bibliotek" | "disposition"; right?: string }>;
  }
}
