// Ordtallet nederst til højre (ADR-0015): usynligt, til musen er i hjørnet, eller altid, hvis
// brugeren har valgt det. Holdes musen over, vises anslag, normalsider og læsetid. Er der en
// markering, tælles kun den. Har teksten et længdemål (goal.ts, 7/10), står fremdriften der altid,
// med en tynd stribe og dage til fristen. Et klik på »Sæt mål« eller på fremdriften åbner målet.

import type { EditorView } from "@codemirror/view";

import type { Text } from "@codemirror/state";
import { count, formatCount, type Count } from "../editor/count.ts";
import { daysLeft, findGoal, goalChange, progress, type Goal, type GoalKind, type GoalUnit } from "../editor/goal.ts";
import { currentLix } from "../editor/styleCheck.ts";
import { locale, tr } from "../i18n.ts";
import { rememberFocus } from "./focus.ts";

const nf = new Intl.NumberFormat(locale());
const nf1 = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 });

const KIND: Record<GoalKind, string> = { hoejst: tr("højst", "at most"), mindst: tr("mindst", "at least"), cirka: tr("cirka", "about") };
const UNIT: Record<GoalUnit, string> = { anslag: tr("anslag", "characters"), ord: tr("ord", "words"), sider: tr("normalsider", "standard pages") };

/** »3 dage til fristen«, »Fristen er i dag«, »2 dage over fristen«. */
function deadlineText(deadline: string): string {
  const d = daysLeft(deadline);
  if (d === 0) return tr("Fristen er i dag", "Due today");
  if (d === 1) return tr("1 dag til fristen", "1 day left");
  if (d > 1) return tr(`${d} dage til fristen`, `${d} days left`);
  return d === -1 ? tr("1 dag over fristen", "1 day overdue") : tr(`${-d} dage over fristen`, `${-d} days overdue`);
}

export class CountCorner {
  private el: HTMLElement;
  private view: EditorView;
  private timer: number | undefined;
  private pop: HTMLElement | null = null;
  private restore: (() => void) | null = null;

  /** Teksten er ændret, mens tallet var skjult. Det tælles, når musen kommer til hjørnet. */
  private stale = true;

  constructor(el: HTMLElement, view: EditorView) {
    this.el = el;
    this.view = view;
    el.addEventListener("mouseenter", () => {
      if (this.stale) this.update();
    });
  }

  private get visible(): boolean {
    return this.el.classList.contains("always") || this.el.classList.contains("has-goal") || this.el.matches(":hover");
  }

  setAlways(on: boolean): void {
    this.el.classList.toggle("always", on);
    if (on && this.stale) this.update();
  }

  /** Kaldes ved ændringer i teksten eller markeringen. Tælles lidt forsinket. */
  schedule(): void {
    this.stale = true;
    window.clearTimeout(this.timer);
    // En lang tekst tælles ikke for ingenting: kun når tallet faktisk vises.
    if (this.visible) this.timer = window.setTimeout(() => this.update(), 250);
  }

  private whole: { doc: Text; count: Count; goal: Goal | null } | null = null;

  update(): void {
    this.stale = false;
    const state = this.view.state;
    const sel = state.selection.main;
    const selected = !sel.empty;
    // Hele teksten tælles kun forfra, når den er ændret, ikke ved hver markørflytning (perf-review 2/10).
    if (this.whole?.doc !== state.doc) {
      const text = state.doc.toString();
      this.whole = { doc: state.doc, count: count(text), goal: findGoal(text) };
    }
    const c = selected ? count(state.sliceDoc(sel.from, sel.to)) : this.whole.count;
    const goal = this.whole.goal;
    const f = formatCount(c);
    const lix = currentLix();
    const longParts = [...f.long.slice(1), ...(lix ? [`LIX ${Math.round(lix.lix)} (${lix.label})`] : [])];

    const short = document.createElement("span");
    short.className = "count-short";
    const children: HTMLElement[] = [];
    this.el.classList.toggle("has-goal", Boolean(goal));
    if (goal && !selected) {
      const p = progress(this.whole.count, goal);
      const value = goal.unit === "sider" ? nf1.format(p.value) : nf.format(p.value);
      const target = goal.unit === "sider" ? nf1.format(goal.n) : nf.format(goal.n);
      short.textContent = tr(`${value} af ${KIND[goal.kind]} ${target} ${UNIT[goal.unit]}`, `${value} of ${KIND[goal.kind]} ${target} ${UNIT[goal.unit]}`);
      short.dataset.state = p.state;
      const bar = document.createElement("span");
      bar.className = "count-bar";
      bar.dataset.state = p.state;
      const fill = document.createElement("i");
      fill.style.width = `${Math.min(p.ratio, 1) * 100}%`;
      bar.append(fill);
      if (goal.deadline) longParts.unshift(deadlineText(goal.deadline));
      children.push(this.longLine(longParts, tr("Ret mål", "Edit goal")), short, bar);
    } else {
      short.textContent = selected ? tr(`${f.short} markeret`, `${f.short} selected`) : f.short;
      children.push(this.longLine(longParts, selected ? null : tr("Sæt mål", "Set a goal")), short);
    }
    this.el.replaceChildren(...children);
  }

  private longLine(parts: string[], goalLabel: string | null): HTMLElement {
    const long = document.createElement("span");
    long.className = "count-long";
    long.textContent = parts.join(" · ");
    if (goalLabel) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "count-goal";
      b.textContent = goalLabel;
      b.addEventListener("click", () => this.openGoal());
      long.append(" · ", b);
    }
    return long;
  }

  // --- målet ---------------------------------------------------------------------------------

  /** En lille formular over hjørnet: højst, mindst eller cirka, antal og enhed, og en frist. */
  openGoal(): void {
    if (this.pop) return this.closeGoal();
    const current = findGoal(this.view.state.doc.toString());
    const g: Goal = current ? { kind: current.kind, n: current.n, unit: current.unit, deadline: current.deadline } : { kind: "hoejst", n: 7400, unit: "anslag", deadline: null };
    this.restore = rememberFocus();

    const pop = document.createElement("form");
    pop.className = "goal-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", tr("Mål for teksten", "Goal for the text"));
    const title = document.createElement("strong");
    title.textContent = tr("Mål for teksten", "Goal for the text");

    const kinds = document.createElement("div");
    kinds.className = "st-choices";
    kinds.setAttribute("role", "radiogroup");
    const setKind = (k: GoalKind) => {
      g.kind = k;
      for (const b of kinds.children) b.setAttribute("aria-checked", String((b as HTMLElement).dataset.kind === k));
    };
    for (const k of ["hoejst", "mindst", "cirka"] as GoalKind[]) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.kind = k;
      b.textContent = KIND[k][0].toUpperCase() + KIND[k].slice(1);
      b.addEventListener("click", () => setKind(k));
      kinds.append(b);
    }
    setKind(g.kind);

    const amountRow = document.createElement("div");
    amountRow.className = "goal-row";
    const n = document.createElement("input");
    n.type = "number";
    n.min = "1";
    n.step = "any";
    n.value = String(g.n);
    n.setAttribute("aria-label", tr("Antal", "Amount"));
    const unit = document.createElement("select");
    unit.setAttribute("aria-label", tr("Enhed", "Unit"));
    for (const u of ["anslag", "ord", "sider"] as GoalUnit[]) {
      const o = document.createElement("option");
      o.value = u;
      o.textContent = UNIT[u];
      o.selected = u === g.unit;
      unit.append(o);
    }
    amountRow.append(n, unit);

    const dateRow = document.createElement("label");
    dateRow.className = "goal-row goal-date";
    const dateText = document.createElement("span");
    dateText.textContent = tr("Frist", "Deadline");
    const date = document.createElement("input");
    date.type = "date";
    date.value = g.deadline ?? "";
    dateRow.append(dateText, date);

    const actions = document.createElement("div");
    actions.className = "goal-actions";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "goal-primary";
    save.textContent = tr("Gem mål", "Save goal");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = tr("Annullér", "Cancel");
    cancel.addEventListener("click", () => this.closeGoal());
    actions.append(save, cancel);
    if (current) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "goal-remove";
      remove.textContent = tr("Fjern mål", "Remove goal");
      remove.addEventListener("click", () => this.saveGoal(null));
      actions.append(remove);
    }

    pop.addEventListener("submit", (e) => {
      e.preventDefault();
      const amount = Number(n.value.replace(",", "."));
      if (!(amount > 0)) {
        n.focus();
        return;
      }
      this.saveGoal({ kind: g.kind, n: amount, unit: unit.value as GoalUnit, deadline: date.value || null });
    });
    pop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeGoal();
      }
    });
    pop.append(title, kinds, amountRow, dateRow, actions);
    document.body.append(pop);
    this.pop = pop;
    n.focus();
    n.select();
  }

  private saveGoal(g: Goal | null): void {
    const change = goalChange(this.view.state.doc.toString(), g);
    this.view.dispatch({ changes: change, userEvent: "input.goal" });
    this.closeGoal();
    this.update();
  }

  private closeGoal(): void {
    this.pop?.remove();
    this.pop = null;
    this.restore?.();
    this.restore = null;
  }
}
