// Stiltjekket kører her, uden for skrivefladens tråd (styleCheck.ts sender teksten).
import { analyze } from "./styleRules.ts";

self.onmessage = (e: MessageEvent<{ id: number; doc: string }>) => {
  self.postMessage({ id: e.data.id, ...analyze(e.data.doc) });
};
