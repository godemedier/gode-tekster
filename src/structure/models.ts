// Egne beskrivelser og spørgsmål med kilder. Samme katalog bruges af fladen og Rust.
import catalog from './models.json' with { type: 'json' };
export type ModelRole = { id: string; name: string; question: string };
export type NarrativeModel = { id: string; name: string; groups: string[]; description: string; source: string; roles: ModelRole[] };
export const MODEL_GROUPS: string[] = catalog.groups;
export const NARRATIVE_MODELS: NarrativeModel[] = catalog.models;
export function narrativeModel(id: string): NarrativeModel | undefined { return NARRATIVE_MODELS.find(m => m.id === id); }
