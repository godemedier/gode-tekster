import { defineConfig } from "vite";

// Gæstens side til en delt tekst (ADR-0060). Bygges for sig til dist-del/ og serveres af
// synkserveren under /del/ (synk/Dockerfile). Programmets eget byg (vite.config.ts) har den ikke med.
export default defineConfig({
  base: "/del/",
  build: {
    outDir: "dist-del",
    emptyOutDir: true,
    rollupOptions: { input: { del: "del.html" } },
  },
});
