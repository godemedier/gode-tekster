# Gode Tekster — arbejdskontrakt

Et skriveprogram til Windows: markdown, dæmpet og parkeret tekst, og hjælp fra Claude på
bestilling.

> **Denne fil er kontrakten for *hvordan vi bygger* her.** *Hvorfor, for hvem og hvad der er
> uden for scope* står i **[STRATEGI.md](STRATEGI.md)**. *Hvordan maskinen kører, plus ADR-loggen*
> står i **[ARKITEKTUR.md](ARKITEKTUR.md)**. **Dupliker ikke deres indhold her. Opdater dem
> i stedet.** Filtræet står i **[docs/struktur.md](docs/struktur.md)**.
>
> Byggereglerne er `C:\GM\standard\STANDARD.md`, dyrt lærte fejl er `C:\GM\standard\LESSONS.md`.
> **Synket til STANDARD: v1.39.** Udefra? `C:\GM\…` og `L-nnn` er husets private standard. Det,
> der gælder her, står i denne fil (`CONTRIBUTING.md`).

**Sprog:** dansk UI og kommentarer, engelske kode-navne. UI-tekst følger
`standard\SKRIVESTIL.md`. Invokér skillen `skrivestil`, før du skriver en knap eller fejlbesked.

## Stack

- **Tauri 2** — Rust-kerne (filer, biblioteker, historik, eksport, kald til `claude`) og en
  WebView2-flade. Kun Windows.
- **TypeScript + Vite** — fladen. **Ingen UI-ramme** (ADR-0002).
- **CodeMirror 6** — skrivefladen med live preview (ADR-0002).

Begrundelserne står som ADR'er i `ARKITEKTUR.md`.

## Udviklingsprincipper

De syv principper står i **`C:\GM\standard\STANDARD.md`** og gælder uændret. De kopieres ikke
herind (L-182). Projektets egen ramme:

- **Realisme (princip 2):** én bruger, én maskine. Tekster op til et par hundrede sider,
  biblioteker med nogle tusinde filer. Alt ud over det er overengineering.
- **Færrest afhængigheder (princip 4):** hver ny crate eller npm-pakke skal være udbredt og
  vedligeholdt (»7 ting« 2d). `.npmrc` har `min-release-age=3`.
- **Hold dokumenterne ajour (princip 7):** bærende beslutninger føres som **ADR i
  `ARKITEKTUR.md`**. Ændrer en beslutning sig, skriv en ny ADR, der afløser den gamle.
- **Husets første Rust-projekt:** det, der læres her om Rust, Tauri og WebView2, skrives som
  lektion i `standard\lektioner\`, så næste Rust-projekt arver det.

## Sikkerhed i dette projekt (princip 6)

| Område | Status nu | TODO |
|---|---|---|
| Fladen kan kun det, Rust-kommandoerne tilbyder: `capabilities/default.json` har kun `core:default`, ingen `fs`- eller `opener`-rettigheder | ✅ | Hold det sådan. Links åbnes fra Rust (`open_url`, kun http og https) |
| Filadgang kun inden for brugerens biblioteker, stier kanoniseres i Rust | ✅ | Åbn kun tekstfiler fra bibliotek eller eget valg; biblioteker kun via mappevælgeren i Rust; eksport kun stien fra Gem-dialogen; billeder kun til `medier/` ved siden af en åben tekst (ADR-0022, -0023) |
| Streng CSP: `script-src 'self'`, ingen fjernressourcer. `style-src` tillader inline, fordi CodeMirror lægger sine styles i `<style>`-elementer (set i release-byg 2/10: uden det er editoren ustylet). Uden scripts kan CSS intet sende ud. `img-src` er programmet selv plus asset-protokollen (billeder fra bibliotekerne og den åbne teksts mappe), `connect-src` kun IPC | ✅ | Script-delen må aldrig løsnes |
| `claude.exe` og `codex.exe` kaldes med argument-liste, aldrig gennem en shell eller `.cmd` | ✅ | `claude.rs`, `codex.rs`. Ingen API-nøgle i miljøet (ADR-0026) |
| Modelsvar valideres mod skema i Rust, før fladen ser dem. Citater tjekkes på kildens side | ✅ | Uddrag skal stå ordret i teksten. Citattjek kun på offentlige https-adresser (ADR-0022) |
| Research og hentede sider vises som tekst, aldrig som HTML | ✅ | `textContent` overalt. Print escaper alt undtagen `<u>` |

**Prompt injection:** dokumentets tekst og hentede sider er **data**, aldrig instruktioner. De
lægges i tydelige afgrænsere i prompten, og modellen får kun værktøjerne `WebSearch` og
`WebFetch`. Modelsvar er forslag: intet skrives i en fil, før brugeren har klikket.

**Hemmeligheder:** brugerens Gemini- og Mistral-nøgle ligger i Windows Credential Manager
(`credentials.rs`), aldrig i en fil, og fladen kan ikke læse dem. Claude og ChatGPT bruger programmernes eget login.

## Stabilitet

- **Fejl:** Rust-kommandoer returnerer `Result<T, String>` med en dansk besked, fladen viser den.
  `unwrap()` og `expect()` er forbudt uden for tests. Håndhæves af clippy (`[lints.clippy]` i
  `Cargo.toml`), så gaten blokerer.
- **Gem er atomisk:** skriv til en midlertidig fil i samme mappe, og omdøb. En halv fil må aldrig
  kunne opstå, heller ikke ved strømsvigt.
- **Rør aldrig en fil, der er ændret udefra,** uden at vise brugeren det først. Før hvert gem, også
  autosave, sammenlignes disken med sidste kendte `(size, mtime, blake3)` (plan 1, ADR-0013).

## Kritiske quirks — læs inden du koder

- **Rust kræver MSVC Build Tools** (C++-workload). `cargo` findes ikke i en shell, der var åben
  før installationen. Start en ny.
- **npm på Windows:** kør `npm install` fra projektmappen, aldrig fra `C:\GM` (L-479).
- **Karantænen gælder kun npm.** `cargo update` kan tage en crate, npm-halvdelen ikke må få
  endnu, og så nægter Tauri at bygge. Tjek udgivelsesdatoen, pin med `--precise`.
- **`claude` er en `.cmd`.** Start `claude.exe` direkte, luk stdin, brug en tom arbejdsmappe og
  tjek `apiKeySource`. Hele opskriften er ADR-0010.
- **Brugerens egne filer har store bogstaver** (`ARTIKEL.md`, `FRAKLIP.md`). »Husets filer« er en
  fast navneliste med præcis husets stavemåde i `src-tauri/src/library.rs`, aldrig »store bogstaver«.
- **Rør aldrig brugerens rigtige filer i tests.** Kopiér dem til en testmappe. iA-annotationer
  går tabt ved et forkert gem.

## Kvalitetsnet

- `lefthook` kører `.claude/hooks/check.mjs` ved hver commit: gitleaks, typecheck, tests (`npm
  test` = TS + `cargo test`), dok-loftet, og når Rust- eller Cargo-filer er staget også
  `cargo fmt --check` og `cargo clippy -D warnings`. osv-scanner kører på staget `Cargo.lock` og
  `package-lock.json` (undtagelser med udløb i `src-tauri/osv-scanner.toml` og `osv-scanner.toml`). Blokerer
  ved fejl. Fjern aldrig gaten, ret kilden.
- **Hvad der springes over:** gitleaks, semgrep og osv-scanner springes over, hvis de ikke er
  installeret. Semgrep er ikke installeret. Mangler `cargo`, når Rust er staget, blokerer gaten.
- `/review` kører et parallelt review (consistency, security, performance, readability).
- Afhængigheder: `node C:\GM\standard\scripts\deps.mjs check` for npm. For Rust: `cargo update
  --dry-run`, og tjek udgivelsesdatoen (karantænen gælder kun npm).

## Loft på denne fil — 8 KB

`dok-loft.mjs` blokerer, når filen vokser over 8 KB. Svaret er `.claude/rules/` med
`paths:`-frontmatter (L-405).

## Arbejdsgang (Git)

Én branch: `main`. Små commits efter hver ændring, der virker. Commit og push kun, når brugeren
beder om det, eller ved `/handoff`. Remote: `origin` = Forgejo. Ingen deploy, ingen server.

## Sessions-rutine

- **Arbejdsfilerne** (`TODO.md`, `TODO-teknisk.md`, `ARKIV.md`, `audit/`, `docs/plans/`,
  `docs/research/`, `docs/IDEER.md`, `.claude/rules/`) er gitignoreret her og versioneres i et
  privat repo i samme mappe: `git --git-dir=.noter add -A && git --git-dir=.noter commit -m "…"
  && git --git-dir=.noter push`. Commit dem aldrig i hovedrepoet.
- **Ved sessionsslut:** `/handoff` committer ved navn (aldrig `git add -A`) og skriver
  `HANDOFF.md`, som ikke committes. De åbne punkter står i `TODO.md` (brugerens) og
  `TODO-teknisk.md` (Claudes). `TODO.md` vises i Gode Opgaver-ruden.
- **Ved næste start:** `/start` læser `HANDOFF.md`, denne fil og nyeste plan i `docs/plans/`.
  Planskabelonen er `C:\GM\standard\templates\plan.md`.

## Kommandoer

```
npm install            # første gang; armerer ogsaa lefthook
npm run tauri dev      # start programmet med genindlaesning
npm test               # typecheck + tests (TS og Rust)
npm run tauri build    # byg .exe-installeren (src-tauri/target/release/bundle/nsis/)
```

## Når en regel her står som 🔴

1. Lav opgaven, som brugeren beder om.
2. **Påpeg**, at den underliggende foranstaltning ikke er på plads endnu.
3. Foreslå at tage den, men gør det ikke uden at spørge.
