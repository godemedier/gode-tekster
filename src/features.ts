// Funktioner, der kun findes i udviklerudgaven (`npm run tauri dev`), til de er klar til at udgive.
// Vite sætter `import.meta.env.DEV` til false i installeren. Testene kører uden Vite og ser false.

declare global {
  interface ImportMeta {
    readonly env?: { readonly DEV?: boolean };
  }
}

/** Struktur (ADR-0046): fanen og »Gruppér som del«. Ikke klar til launch (21/10). Dele i en fil
 *  bliver stadig skjult og beskyttet i skrivefladen (hidden.ts), så intet går tabt. */
export const STRUCTURE = import.meta.env?.DEV === true;
