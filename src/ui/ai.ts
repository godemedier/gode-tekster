// AI-forbindelsens status, som Rust melder den (`ai_status`, ai.rs). Én type og ét kald til fanen
// Input, indstillingerne og kommandoerne, der før havde hver sin kopi (kodegennemgang 20/10).

import { invoke } from "@tauri-apps/api/core";

export type AiProvider = { id: string; name: string; ready: boolean; detail: string; web: boolean };
export type AiState = { chosen: string | null; providers: AiProvider[] };

/** `refresh`: spørg programmerne igen i stedet for at bruge Rusts korte cache. */
export function aiStatus(refresh = false): Promise<AiState> {
  return invoke<AiState>("ai_status", { refresh });
}
