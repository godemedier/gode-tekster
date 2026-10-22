// Deling kræver ejerens enhed, forbundet til synkserveren (ADR-0060). Hos alle andre endte »Del« i
// en fejl, så fanen og »Del det markerede« vises først, når enheden er ejerens (ADR-0064). En enhed
// parret med en kode er forbundet, men serveren afviser dens delinger (gennemgang 22/10). Følger
// »synk-status«, så fanen kommer og går med forbindelsen.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Status = { connected: boolean; owner: boolean };

let available = false;
const watchers: ((on: boolean) => void)[] = [];

function set(s: Status): void {
  const on = s.connected && s.owner;
  if (on === available) return;
  available = on;
  for (const w of watchers) w(on);
}

/** Kan enheden dele lige nu? */
export const sharingAvailable = (): boolean => available;

/** Kaldes med det samme og igen, hver gang forbindelsen skifter. */
export function watchSharing(w: (on: boolean) => void): void {
  watchers.push(w);
  w(available);
}

// Lytteren først, så intet skift falder mellem øjebliksbilledet og lytteren. Er der kommet en
// hændelse, før svaret kom, er svaret det ældste og ignoreres.
let heard = false;
void listen<Status>("synk-status", (e) => {
  heard = true;
  set(e.payload);
})
  .then(() => invoke<Status>("synk_status"))
  .then((s) => {
    if (!heard) set(s);
  })
  .catch(() => {});
