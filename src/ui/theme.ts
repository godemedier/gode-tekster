// Udseendet (ADR-0037): lys, mørk, aften, eller »Skifter selv«, der går til aften ved solnedgang
// og tilbage ved solopgang. Aften er en variant af mørk (body.dark.aften i styles.css), så alle
// mørke regler gælder, og kun farverne skifter til ravgult lys på næsten sort.
//
// Solens tider regnes her på maskinen (NOAA's tilnærmelse), uden net og uden placering: bredden
// er Danmarks, længden er Danmarks i dansk tid og ellers tidszonens midte. Aften begynder aldrig
// før kl. 18, så en decembereftermiddag stadig er lys.

import { invoke } from "@tauri-apps/api/core";

export type ThemeSetting = "lys" | "moerk" | "aften" | "auto";
export type Theme = "lys" | "moerk" | "aften";

const LAT = 56;
const EARLIEST_EVENING = 18 * 60;

/** Solopgang og solnedgang i minutter efter lokal midnat. `utcOffset` er lokal tid minus UTC i minutter. */
export function sunTimes(date: Date, utcOffset: number, longitude: number): { rise: number; set: number } {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86_400_000);
  const g = ((2 * Math.PI) / 365) * (day - 1);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const lat = (LAT * Math.PI) / 180;
  const cos = Math.cos((90.833 * Math.PI) / 180) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl);
  const ha = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
  return { rise: 720 - 4 * (longitude + ha) - eqtime + utcOffset, set: 720 - 4 * (longitude - ha) - eqtime + utcOffset };
}

/** Længden for maskinens tidszone: Danmark i dansk tid (UTC+1 om vinteren), ellers zonens midte. */
function longitude(now: Date): number {
  const year = now.getFullYear();
  const standard = -Math.max(new Date(year, 0, 1).getTimezoneOffset(), new Date(year, 6, 1).getTimezoneOffset());
  return standard === 60 ? 10.5 : standard / 4;
}

/** Er det aften: efter solnedgang (tidligst kl. 18) og før solopgang? */
export function isEvening(now: Date, utcOffset = -now.getTimezoneOffset(), lon = longitude(now)): boolean {
  const { rise, set } = sunTimes(now, utcOffset, lon);
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= Math.max(set, EARLIEST_EVENING) || minutes < rise;
}

/** Det udseende, der gælder nu. */
export function currentTheme(setting: ThemeSetting, now = new Date()): Theme {
  if (setting === "auto") return isEvening(now) ? "aften" : "lys";
  return setting;
}

let shown: Theme | null = null;

/** Sætter udseendet på vinduet og titellinjen. Et skift af sig selv (auto) toner blødt over. */
export function showTheme(theme: Theme, fade = false): void {
  if (theme === shown) return;
  const body = document.body;
  if (fade && shown !== null) {
    body.classList.add("tema-skift");
    window.setTimeout(() => body.classList.remove("tema-skift"), 1600);
  }
  shown = theme;
  body.classList.toggle("dark", theme !== "lys");
  body.classList.toggle("aften", theme === "aften");
  void invoke("set_titlebar", { theme }).catch(() => {});
}

let timer = 0;

/** Følger indstillingen. Ved »Skifter selv« ses der efter hvert minut, om solen er gået ned. */
export function followTheme(setting: ThemeSetting): void {
  window.clearInterval(timer);
  showTheme(currentTheme(setting));
  if (setting === "auto") timer = window.setInterval(() => showTheme(currentTheme("auto"), true), 60_000);
}
