# Projektstruktur — Gode Tekster

```
gode-tekster/
├── README.md · README.da.md     forsiden på GitHub: engelsk · dansk
├── CONTRIBUTING.md · SECURITY.md  fejl, forslag og sikkerhedshuller udefra
├── AGENTS.md · CLAUDE.md        arbejdskontrakt (CLAUDE.md er én linje: @AGENTS.md)
├── STRATEGI.md · ARKITEKTUR.md  hvorfor · hvordan maskinen kører + ADR-log
├── docs/
│   ├── struktur.md              denne fil
│   └── billeder/                skærmbilleder til README
├── server/                      tekster.godemedier.dk: opdateringer, feedback, privatliv (Node uden afhængigheder)
├── video/                       filmen om programmet: kilde, storyboard, stills og MP4
├── index.html · vite.config.ts  fladens indgang og byg
├── src/                         fladen: TypeScript, CodeMirror 6, ingen UI-ramme
│   ├── editor/                  CodeMirror: live preview, forfatterskab, genveje, søg, fraklip,
│   │                            tilstande, ordtal, ordklasser, dæmpning, kilder, stiltjek (worker),
│   │                            links (Ctrl+klik), tabeller vist som tabeller (tables.ts), markeringen (wordSelection.ts)
│   ├── ui/                      paneler, bibliotek, disposition, hurtigåbning, menu, højre spalte, indstillinger
│   │                            (med AI-hjælp og Om), versioner, fanen Input, ordtal-hjørnet, genveje (F1), beskedlinje
│   ├── commands/                »/«-kommandoer: indbyggede, egne, menuen, kørsel og tjek (ADR-0027, -0028)
│   ├── sprog/                   stiltjek: klarhed, AI-fingeraftryk, anførselstegn
│   ├── main.ts · document.ts    opstart og binding · ét åbent dokument (gem, flet udefra)
│   ├── i18n.ts                  dansk og engelsk: tr("Gem", "Save")
│   ├── settings.ts · measure.ts indstillinger · måling og scenarier i testtilstand (GT_MEASURE, GT_SCENARIE)
│   ├── print/                   print-DOM, skabeloner, forhåndsvisning, PDF og Word
│   ├── import/                  Word-import (.docx → .md)
│   └── assets/                  skrifter (OFL) og ordklasser.json (CC BY-SA)
├── scripts/
│   ├── ordklasser.mjs           bygger ordklasse-leksikonet af UD Danish-DDT
│   ├── licenser.mjs             samler src-tauri/resources/LICENSES.txt (licens-tillaeg/: tekster hentet ved kilden)
│   ├── udgiv.mjs                bygger, signerer og lægger en ny version op
│   └── trykproeve.sh · scenarier.sh · testkoersel.sh   test på kopier i tests/private
├── src-tauri/                   Rust-kernen
│   ├── Cargo.toml · Cargo.lock
│   ├── tauri.conf.json          vindue, CSP, bundle
│   ├── capabilities/            hvad fladen må kalde
│   ├── nsis/                    dansk installer (Danish.nsh) og afinstallation (hooks.nsh)
│   ├── welcome/                 velkomsthilsen og vejledning, lagt i Dokumenter ved første start
│   ├── resources/LICENSES.txt   tredjepartslicenser (lavet af scripts/licenser.mjs)
│   └── src/                     lib.rs (kommandoerne) · files · annotations · document ·
│                                library · watcher · history · authorship · merge · export ·
│                                ai (vælger udbyder) · claude · codex · gemini · mistral ·
│                                credentials (nøgler i Windows) · clean (renskriv) · commands ·
│                                search · spelling · ro · updater · feedback · i18n · jumplist ·
│                                settings · session · autostart · applog · about · welcome ·
│                                windows (ét vindue pr. tekst) · contextmenu · convert · media
├── .claude/
│   ├── hooks/check.mjs          commit-gaten (lefthook)
│   └── constitution.md
└── lefthook.yml · .npmrc · .gitattributes
```

Holdes i synk, når der kommer moduler til. `ls` svarer på resten.

Arbejdsfilerne (opgavelister, planer, research, testprotokoller, `.claude/rules/`) ligger i et
privat repo i samme mappe (`.noter`) og er gitignoreret her.
