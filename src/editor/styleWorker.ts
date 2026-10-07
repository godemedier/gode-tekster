// Stiltjekket kører her, uden for skrivefladens tråd (styleCheck.ts sender teksten). Grammatikken
// (grammar.ts, 7/10) bruger udsagnsordene fra ordklasselisten, som indlæses én gang her.
import { analyze } from "./styleRules.ts";
import ordklasser from "../assets/ordklasser.json";

const verbs: ReadonlySet<string> = new Set((ordklasser as unknown as { v: string[] }).v);

self.onmessage = (e: MessageEvent<{ id: number; doc: string }>) => {
  self.postMessage({ id: e.data.id, ...analyze(e.data.doc, verbs) });
};
