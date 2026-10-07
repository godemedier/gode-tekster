// Stiltjekket kører her, uden for skrivefladens tråd (styleCheck.ts sender teksten). Grammatikken
// (grammar.ts, 7/10) bruger ordklasselisten og kongruensdata, som indlæses én gang her.
import { analyze } from "./styleRules.ts";
import ordklasser from "../assets/ordklasser.json";
import kongruens from "../assets/kongruens.json";
import type { Agreement } from "./grammar.ts";

const lex = ordklasser as unknown as { v: string[]; n: string[]; a: string[]; d: string[] };
const words = { verbs: new Set(lex.v), nouns: new Set(lex.n), adjectives: new Set(lex.a), adverbs: new Set(lex.d), agree: kongruens as unknown as Agreement };

self.onmessage = (e: MessageEvent<{ id: number; doc: string; comma?: string }>) => {
  self.postMessage({ id: e.data.id, ...analyze(e.data.doc, words, e.data.comma) });
};
