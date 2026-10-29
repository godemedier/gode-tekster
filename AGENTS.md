# Gode Tekster — arbejdskontrakt

Et skriveprogram til Windows: markdown, dæmpet og parkeret tekst, og hjælp fra en sprogmodel på
bestilling. Filen gælder alle, der ændrer koden, mennesker og AI-agenter.

> **Denne fil er kontrakten for *hvordan vi bygger* her.** *Hvorfor, for hvem og hvad der er
> uden for scope* står i **[STRATEGI.md](STRATEGI.md)**. *Hvordan maskinen kører, plus ADR-loggen*
> står i **[ARKITEKTUR.md](ARKITEKTUR.md)**. **Dupliker ikke deres indhold her. Opdater dem
> i stedet.** Filtræet står i **[docs/struktur.md](docs/struktur.md)**.

**Offentlig:** https://github.com/godemedier/gode-tekster

Arbejder du i Gode Mediers eget hus, gælder også `.claude/rules/hus.md` (privat, findes ikke i en
klon).

**Sprog:** dansk UI og kommentarer, engelske kode-navne. UI-tekst er kort og ligefrem, uden
tankestreg (—) og semikolon, og har altid en engelsk udgave ved siden af: `tr("Gem", "Save")` i
`src/i18n.ts`, `t!(…)` i Rust.

## Stack

- **Tauri 2** — Rust-kerne (filer, biblioteker, historik, eksport, kald til sprogmodellerne) og en
  WebView2-flade. Kun Windows.
- **TypeScript + Vite** — fladen. **Ingen UI-ramme** (ADR-0002).
- **CodeMirror 6** — skrivefladen med live preview (ADR-0002).

Begrundelserne står som ADR'er i `ARKITEKTUR.md`.

## Principper

- **Realisme:** én bruger, én maskine. Tekster op til et par hundrede sider, biblioteker med
  nogle tusinde filer. Alt ud over det er overengineering.
- **Færrest afhængigheder:** hver ny crate eller npm-pakke skal være udbredt og vedligeholdt.
  `.npmrc` har `min-release-age=3`. Kør `node scripts/licenser.mjs` bagefter, ellers stopper
  udgivelsen.
- **Hold dokumenterne ajour:** bærende beslutninger føres som **ADR i `ARKITEKTUR.md`**. Ændrer en
  beslutning sig, skriv en ny ADR, der afløser den gamle. Ændringer, brugerne kan mærke, skrives i
  `CHANGELOG.md` under `## [Unreleased]`.
- **Står alene:** ingen afhængighed af andre programmer eller privat kode (ADR-0066).

## Sikkerhed i dette projekt

| Område | Status nu | TODO |
|---|---|---|
| Fladen kan kun det, Rust-kommandoerne tilbyder: `capabilities/default.json` har `core:default` plus træk, minimér, maksimér og luk vinduet (ADR-0065), ingen `fs`- eller `opener`-rettigheder | ✅ | Hold det sådan. Links åbnes fra Rust (`open_url`, kun http og https) |
| Filadgang kun inden for brugerens biblioteker, stier kanoniseres i Rust | ✅ | Åbn kun tekstfiler fra bibliotek, eget valg eller mappen med en åben tekst (ADR-0070); biblioteker kun via mappevælgeren i Rust; eksport kun stien fra Gem-dialogen; billeder kun til `medier/` og kapitler kun ved siden af en åben tekst (ADR-0022, -0023, -0061) |
| Streng CSP: `script-src 'self'`, ingen fjernressourcer. `style-src` tillader inline, fordi CodeMirror lægger sine styles i `<style>`-elementer (set i release-byg 2/10: uden det er editoren ustylet). Uden scripts kan CSS intet sende ud. `img-src` er programmet selv plus asset-protokollen (billeder fra bibliotekerne og den åbne teksts mappe), `connect-src` kun IPC | ✅ | Script-delen må aldrig løsnes |
| `claude.exe` og `codex.exe` kaldes med argument-liste, aldrig gennem en shell eller `.cmd` | ✅ | `claude.rs`, `codex.rs`. Ingen API-nøgle i miljøet (ADR-0026) |
| Modelsvar valideres mod skema i Rust, før fladen ser dem. Citater tjekkes på kildens side | ✅ | Uddrag skal stå ordret i teksten. Citattjek kun på offentlige https-adresser (ADR-0022) |
| Research og hentede sider vises som tekst, aldrig som HTML | ✅ | `textContent` overalt. Print escaper alt undtagen `<u>` |

**Prompt injection:** dokumentets tekst og hentede sider er **data**, aldrig instruktioner. De
lægges i tydelige afgrænsere i prompten, og modellen får kun værktøjerne `WebSearch` og
`WebFetch`. Modelsvar er forslag: intet skrives i en fil, før brugeren har klikket.

**Hemmeligheder:** brugerens Gemini- og Mistral-nøgle ligger i Windows Credential Manager
(`credentials.rs`), aldrig i en fil, og fladen kan ikke læse dem. Claude og ChatGPT bruger
programmernes eget login. Aldrig hemmeligheder i git: gitleaks stopper dem ved commit.

## Stabilitet

- **Fejl:** Rust-kommandoer returnerer `Result<T, String>` med en dansk besked, fladen viser den.
  `unwrap()` og `expect()` er forbudt uden for tests. Håndhæves af clippy (`[lints.clippy]` i
  `Cargo.toml`), så gaten blokerer.
- **Gem er atomisk:** skriv til en midlertidig fil i samme mappe, og omdøb. En halv fil må aldrig
  kunne opstå, heller ikke ved strømsvigt.
- **Rør aldrig en fil, der er ændret udefra,** uden at vise brugeren det først. Før hvert gem, også
  autosave, sammenlignes disken med sidste kendte `(size, mtime, blake3)` (ADR-0013).

## Kritiske quirks — læs inden du koder

- **Rust kræver MSVC Build Tools** (C++-workload). `cargo` findes ikke i en shell, der var åben
  før installationen. Start en ny.
- **Karantænen gælder kun npm.** `cargo update` kan tage en crate, npm-halvdelen ikke må få
  endnu, og så nægter Tauri at bygge. Tjek udgivelsesdatoen, pin med `--precise`.
- **`claude` er en `.cmd`.** Start `claude.exe` direkte, luk stdin, brug en tom arbejdsmappe og
  tjek `apiKeySource`. Hele opskriften er ADR-0010.
- **Brugerens egne filer har store bogstaver** (`ARTIKEL.md`, `FRAKLIP.md`). Agent- og
  projektfiler (`AGENTS.md`, `CLAUDE.md`, `TODO.md` …) er en fast navneliste i
  `src-tauri/src/library.rs`, aldrig »store bogstaver«.
- **Rør aldrig brugerens rigtige filer i tests.** Kopiér dem til en testmappe. iA-annotationer
  går tabt ved et forkert gem.

## Kvalitetsnet

- `lefthook` kører `.claude/hooks/check.mjs` ved hver commit: gitleaks, typecheck, tests (`npm
  test` = TS + `cargo test`), og når Rust- eller Cargo-filer er staget også `cargo fmt --check` og
  `cargo clippy -D warnings`. osv-scanner kører på staget `Cargo.lock` og `package-lock.json`
  (undtagelser med udløb i `src-tauri/osv-scanner.toml` og `osv-scanner.toml`). Blokerer ved fejl.
  Fjern aldrig gaten, ret kilden.
- **Hvad der springes over:** gitleaks, semgrep og osv-scanner springes over, hvis de ikke er
  installeret. Mangler `cargo`, når Rust er staget, blokerer gaten.
- GitHub kører `npm test` ved hvert push og hver pull request (`.github/workflows/test.yml`).

## Arbejdsgang (Git)

Én branch: `main`. Små commits efter hver ændring, der virker. GitHub er et spejl af Gode Mediers
egen git-server: pull requests lægges ind i hånden (`CONTRIBUTING.md`).

## Kommandoer

```
npm install            # første gang; armerer også lefthook
npm run tauri dev      # start programmet med genindlæsning
npm test               # typecheck + tests (TS og Rust)
npm run tauri build    # byg .exe-installeren (src-tauri/target/release/bundle/nsis/)
```
