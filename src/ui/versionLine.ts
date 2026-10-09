// Linjen under en version i fanen Versioner (9/10): »+84 nye ord, 12 fjernet«. Eget modul, så den
// kan testes uden et vindue.

import { tr } from "../i18n.ts";

/** Hvad der er ændret siden versionen før (history.rs `describe`). */
export type Summary = { place: string; added: number; removed: number };

/** »+84 nye ord, 12 fjernet«, »+1 nyt ord«, »12 ord fjernet« eller »Små rettelser«. */
export function countLine(s: Summary): string {
  const added = s.added === 1 ? tr("+1 nyt ord", "+1 new word") : tr(`+${s.added} nye ord`, `+${s.added} new words`);
  if (s.added && s.removed) return tr(`${added}, ${s.removed} fjernet`, `${added}, ${s.removed} removed`);
  if (s.added) return added;
  if (s.removed) return s.removed === 1 ? tr("1 ord fjernet", "1 word removed") : tr(`${s.removed} ord fjernet`, `${s.removed} words removed`);
  return tr("Små rettelser", "Small corrections");
}
