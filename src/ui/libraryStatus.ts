// Status i biblioteket (ADR-0038): prikken foran navnet, valget af status og fristen.
// Farverne følger ADR-0037: vermilion betyder »her er du« og bruges ikke her. Den første status
// (Idé) er en tom ring, resten er fyldte prikker i rolige farver. Den sidste status betyder færdig.

import { daysLeft } from "../editor/goal.ts";
import { tr } from "../i18n.ts";
import { settings } from "../settings.ts";
import type { MenuItem } from "./menu.ts";

export type StatusDef = { id: string; name: string };

// Egne tokens (styles.css), så Kladde og Til gennemsyn kan skelnes i alle tre udseender. Grøn er kun til
// den sidste, så en femte status ikke ligner »færdig«.
const COLORS = ["var(--dæmpet)", "var(--status-a)", "var(--status-b)", "var(--status-c)", "var(--status-d)"];

export function statuses(): StatusDef[] {
  return settings().statuses ?? [];
}

/** Farven for en status efter dens plads på listen. Den sidste (færdig) er altid grøn. */
export function statusColor(id: string): string {
  const list = statuses();
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return "var(--dæmpet)";
  if (i === list.length - 1) return "var(--ok)";
  return COLORS[Math.min(i, COLORS.length - 1)];
}

export const statusName = (id: string): string => statuses().find((s) => s.id === id)?.name ?? id;

/** Er teksten i gang: har en status, og den er ikke den sidste. */
export function inProgress(id: string | null | undefined): boolean {
  const list = statuses();
  return Boolean(id) && list.some((s) => s.id === id) && list[list.length - 1]?.id !== id;
}

/** Prikken foran navnet. Uden status: ingen prik, men pladsen står, så navnene flugter. */
export function statusDot(id: string | null | undefined, onPick?: (anchor: HTMLElement) => void): HTMLElement {
  const dot = document.createElement("span");
  dot.className = "lib-dot";
  if (id) {
    dot.dataset.first = String(statuses()[0]?.id === id);
    dot.style.setProperty("--dot", statusColor(id));
    dot.title = tr(`${statusName(id)}. Klik for at skifte`, `${statusName(id)}. Click to change`);
  } else {
    dot.dataset.none = "true";
    dot.title = tr("Ingen status. Klik for at sætte en", "No status. Click to set one");
  }
  if (onPick) {
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      onPick(dot);
    });
  }
  return dot;
}

/** Menuen med statusserne, flueben ved den nuværende, og »Ingen status«. */
export function statusItems(current: string | null | undefined, pick: (id: string | null) => void): MenuItem[] {
  return [
    ...statuses().map((s) => ({ label: s.name, checked: s.id === current, run: () => pick(s.id) })),
    { separator: true },
    { label: tr("Ingen status", "No status"), checked: !current, run: () => pick(null) },
  ];
}

/** »I dag«, »i morgen«, »3 dage« eller »2 dage over« til fristen. */
export function deadlineLabel(deadline: string): { text: string; late: boolean } {
  const d = daysLeft(deadline);
  if (d === 0) return { text: tr("i dag", "today"), late: false };
  if (d === 1) return { text: tr("i morgen", "tomorrow"), late: false };
  if (d > 1) return { text: tr(`${d} dage`, `${d} days`), late: false };
  return { text: d === -1 ? tr("1 dag over", "1 day late") : tr(`${-d} dage over`, `${-d} days late`), late: true };
}
