import { commentSpans } from "../editor/textSyntax.ts";
export type AudioSource = { audio: string; duration: number; complete: boolean };
export function audioSource(doc: string): AudioSource | null {
  for (const span of commentSpans(doc)) {
    const match = /^<!-- gt:lyd (.+) -->$/.exec(doc.slice(span.from, span.to));
    if (!match) continue;
    try {
      const data = JSON.parse(match[1]);
      if (data.version === 1 && typeof data.audio === "string" && data.audio.length > 0 && !/[\\/:]/.test(data.audio) && Number.isFinite(data.duration) && data.duration > 0 && typeof data.complete === "boolean") return data;
    } catch { /* Ukendt metadata bevares i filen. */ }
  }
  return null;
}
export function audioLink(target: string): { name: string; seconds: number } | null {
  const m = /^([^/#]+)#t=(\d+(?:\.\d+)?)$/.exec(target);
  if (!m) return null;
  try {
    const name = decodeURIComponent(m[1]), seconds = Number(m[2]);
    return !/[\\/:]/.test(name) && seconds <= 21600 ? { name, seconds } : null;
  } catch { return null; }
}
