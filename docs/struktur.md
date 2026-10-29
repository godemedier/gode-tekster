# Projektstruktur — Gode Tekster

Mapperne og hvad der bor i dem. Enkelte filer står kun her, når navnet ikke siger det selv.
Modulerne i hver mappe står i `ls`, og hver fil begynder med en kommentar om, hvad den gør.

```
gode-tekster/
├── README.md · README.da.md        forsiden på GitHub: engelsk · dansk
├── CHANGELOG.md                    ændringer, brugerne kan mærke (Keep a Changelog)
├── CONTRIBUTING.md · SECURITY.md · CODE_OF_CONDUCT.md
├── AGENTS.md · CLAUDE.md           arbejdskontrakten (CLAUDE.md er én linje: @AGENTS.md)
├── STRATEGI.md · ARKITEKTUR.md     hvorfor · hvordan maskinen kører, plus ADR-loggen
├── .github/                        issue-formularer, PR-skabelon, workflows (tests, Windows-byg)
├── docs/                           denne fil og skærmbilleder til README
├── assets/logo/                    logoet som SVG og PNG
├── index.html                      skrivefladens indgang
├── note.html · noteliste.html      noterne på skrivebordet og listen over dem (ADR-0039, -0050)
├── noteoversigt.html               oversigten over noterne ved uret (ADR-0068, tray.rs)
├── del.html                        gæstens side til en delt tekst (ADR-0060)
├── mobile.html                     telefonens flade (ADR-0055), ikke udgivet
├── src/                            fladen: TypeScript, CodeMirror 6, ingen UI-ramme
│   ├── editor/                     skrivefladen: live preview, forfatterskab, dæmpning, fraklip,
│   │                               tabeller, kilder og henvisninger, stavning, stiltjek (worker)
│   ├── ui/                         paneler, bibliotek, disposition, indstillinger, højre spalte,
│   │                               titellinjen, versioner, beskedlinjen
│   ├── commands/                   »/«-kommandoer: indbyggede, egne, menuen, kørsel (ADR-0027, -0028)
│   ├── sprog/                      stiltjekkets regler: klarhed, maskinsprog, citater (ADR-0066)
│   ├── structure/                  strukturkort og AI-forslag til struktur
│   ├── audio/                      lydpanel, afspilning og tidslinks
│   ├── share/                      deling fra pc'en (ADR-0060)
│   ├── print/                      print, forhåndsvisning, PDF og Word
│   ├── import/                     Word-import (.docx → .md)
│   ├── assets/                     skrifter (OFL) og ordklasser.json (CC BY-SA, UD Danish-DDT)
│   └── main.ts · document.ts …     opstart · ét åbent dokument (gem, flet udefra)
├── src-tauri/                      Rust-kernen (Tauri 2)
│   ├── src/                        én fil pr. ansvar: files, document, library, history, merge,
│   │                               export, claude/codex/gemini/mistral, spelling, synk/, notes …
│   ├── capabilities/               hvad fladen må kalde
│   ├── vendor/hunspell/            Hunspell-kilden, bygget med cc i build.rs (ADR-0063)
│   ├── resources/                  ordbogen (da_DK) og tredjepartslicenserne (LICENSES.txt)
│   ├── welcome/                    velkomstbrev og vejledning, lagt i Dokumenter ved første start
│   ├── nsis/                       dansk installer og afinstallation
│   └── gen/android/                Android-projektet (ADR-0053), ikke udgivet
├── server/                         tekster.godemedier.dk: opdateringer, feedback, privatliv (Node)
├── synk/                           synkroniseringen (ADR-0054), eget Cargo-workspace
│   ├── kerne/                      stiregler, filter, protokol og lager, delt med programmet
│   └── server/                     synkserveren: enheder, parring, delinger
├── scripts/                        udgivelse, licenser, ordklasser, ordbog, ikon, starttest.
│                                   Scripts, der kræver private prøvetekster, siger det øverst
├── .claude/hooks/check.mjs         commit-gaten (lefthook): gitleaks, typecheck, tests, fmt, clippy
└── lefthook.yml · .npmrc · .nvmrc · rust-toolchain.toml · osv-scanner.toml
```

Arbejdsfilerne (opgavelister, planer, research, testprotokoller, prøvetekster og filmen om
programmet) ligger i et privat repo i samme mappe og er ikke en del af den offentlige kode.
