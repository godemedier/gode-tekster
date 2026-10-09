# Gode Tekster — arkitektur

> **Hvordan maskinen kører, og hvorfor den er bygget sådan.** *Hvorfor projektet findes og hvad
> der er uden for scope* står i [STRATEGI.md](STRATEGI.md). *Hvordan vi arbejder* står i
> [AGENTS.md](AGENTS.md). Synket til STANDARD v1.39 · REGISTRY v1.74.

## Overordnet billede

```
┌──────────────────────────── Gode Tekster.exe ─────────────────────────────┐
│  Fladen (WebView2)                        Kernen (Rust)                   │
│  TypeScript · CodeMirror 6     ──IPC──▶   biblioteker · fil-I/O · notify  │
│  mappetræ · editor · bakke     ◀──────    annotationer (grafemer, SHA-256)│
│  forfatterskab (StateField)               historik (SQLite, zstd, blake3) │
│  print-DOM · popup til kilder             PDF (WebView2) · Word (pandoc)  │
│                                           claude-modul · citat-tjek ──┐   │
└───────────────────────────────────────────────────────────────────────┼───┘
     .md-filer i brugerens biblioteker (tekst + parkeret + annotationer) ▼
     <data>: historik.sqlite · log · backup · tom claude-mappe           claude.exe -p
                                                                        WebSearch · WebFetch
```

Fladen rører aldrig disken eller nettet selv. Alt går gennem navngivne Rust-kommandoer.

`<data>` er Tauris `app_local_data_dir()`: `%LOCALAPPDATA%\dk.godemedier.godetekster`. Lokal og
ikke roamende, fordi historikken kan blive stor og hører til denne pc.

**Filens anatomi** (ADR-0003, ADR-0008, ADR-0009):

```
# Overskrift
Brødtekst med {--dæmpet tekst--} midt i.

<!-- gt:parkeret id=p1 dato=2026-10-02
En sætning, skribenten har flyttet ud.
-->

---
Annotations: 0,95 SHA-256 1132bf5e376a605f5bee  
@Kim Skribent: 0,60  
&Claude: 60,35  
...
```

## Stack

| Del | Valg | Hvorfor |
|---|---|---|
| Ramme | Tauri 2 | Rust-kerne, lille .exe, WebView2 findes allerede på Windows (ADR-0001) |
| Flade | TypeScript + Vite, ingen UI-ramme | Hurtig start, få afhængigheder (ADR-0002) |
| Editor | CodeMirror 6, egen live preview-udvidelse | Markdown forbliver kilden, intet hopper (ADR-0002) |
| Forfatterskab | iA Markdown Annotations v0.2 i filen | Åbent format, iA Writer læser det (ADR-0009) |
| Historik | SQLite (`rusqlite`), zstd, blake3 | Én fil, atomisk, nem udtynding (ADR-0009) |
| Sprogmodel | `claude.exe -p` som underproces | Brugerens abonnement, ingen nøgler (ADR-0004, ADR-0010) |
| Print og PDF | WebView2: `window.print()` og `PrintToPdf` | Samme motor som skærmen (ADR-0011) |
| Word | JS-pakken `docx` i fladen; import med `mammoth` | Ingen ekstern binær, danske anførselstegn bevares (ADR-0018) |
| Typografi | Recursive Halvmono (skriveflade, standard), IBM Plex Mono, Literata og Schibsted Grotesk som valg, Newsreader (læseudgave), Segoe UI Variable (rammen, følger med Windows) | OFL, bundlet, CSP tillader kun egne skrifter (ADR-0012, -0015, -0037) |

## Lokal udvikling

`npm run tauri dev` starter Vite på port 1420 og åbner vinduet. Der er ingen tjenester, ingen
database og ingen Docker. Udgivelse er `npm run tauri build`, der giver en NSIS-installer.
Ingen eksterne programmer ud over Claude Code (til fanen Claude).

## Genbrug

Kortlagt 2/10-2026. Kopieres som version-stemplede kopier, og forbedringer promotes tilbage (L-007).
Licensen er tjekket. GPL/AGPL-kode (Zettlr, Joplin) må kun bruges som inspiration.

| Hvad | Kilde | Bemærk |
|---|---|---|
| Design-tokens | `gode-medier-suite/gode-medier-ui/src/styles.css` (REGISTRY #3, v0.10.0) | Ikke brugt: iA-opsætningen (ADR-0015) har sine egne farver |
| Diff på ordniveau | Gode Ord `src/lib/diff.ts` | Versioner, AI-forslag, »ændret udefra« |
| Oprydning af indsat tekst | Gode Ord `src/lib/paste.ts` | Word/Docs-HTML → markdown |
| Fed/kursiv med æøå | Gode Ord `src/lib/editing.ts` | Ren funktion med test |
| Promptsikring | Gode Ord `src/lib/promptsafe.ts` | Samme idé skrevet i Rust (`claude.rs` `data_block`, ADR-0022) |
| Påstandsudtræk, kildeopslag | Gode Ord `fakta.ts`, `kildeopslag.ts`, `sources.ts` | Skemaer og prompts genbruges, SDK-kaldet skrives om til `claude -p` |
| Citat-verifikation | Prismet `lib/hent-dokument.ts` `lavCitatSoeger()` | Grundlag for dybe links (text fragments bygges nyt ovenpå) |
| Print | Gode Ord `src/lib/clipboard.ts` `printDocument()` | Udgangspunkt for Ctrl+P |
| Live preview-mønstre | SilverBullet (MIT), Atomic Editor (MIT) | Kun mønstre. Atomics tabeleditor bruges ikke, fordi den omskriver filen |
| Forfatterskab i CM6 | `rflpazini/obsidian-authorship` (MIT) | Implementerer iA's format i CodeMirror 6 |

Gode Ords ordlister (`clarity.ts`, `aitells.ts`) kopieres ikke (husets regel: de bor ét sted).

## Research

Fire interne noter fra 2/10-2026. Hver påstand er mærket verificeret eller usikker. Læs dem, før
en beslutning herunder afløses.

- iA Writer udtømmende, Markdown Annotations-formatet, 35 forslag.
- Ulysses, Scrivener, Highland, Typora, Obsidian m.fl., fælder.
- Teknik: live preview, opstart, fil-I/O, historik, forfatterskab, print, Word, `claude -p`.
- Dansk typografi, skrifter, print-CSS, modtagernes krav.

## ADR-log

Beslutninger rettes aldrig, de afløses af en ny ADR.

### ADR-0001 — Tauri 2 frem for ren Rust (2/10-2026)
**Beslutning:** Rust-kerne med en WebView2-flade. Rust ejer filer, historik, eksport og kald til
`claude`. Fladen er TypeScript.
**Alternativ der tabte:** ren Rust med native UI (GPUI fra Zed, egui, Slint). Hurtigere og intet
browserlag, men en skriveflade, der viser formateret markdown, skal bygges fra bunden. Det
ville tage måneder, og Gode Ords tekstlogik kunne ikke genbruges.
**Revurdér først hvis:** opstarten målt er over ét sekund, eller WebView2 giver mærkbar
forsinkelse ved skrivning.

### ADR-0002 — CodeMirror 6 og ingen UI-ramme (2/10-2026)
**Beslutning:** CodeMirror 6 med live preview: markdown-tegnene skjules med dekorationer og vises
igen, hvor markøren står. Resten af fladen er ren TypeScript og DOM.
**Alternativ der tabte:** ProseMirror/Milkdown (ægte WYSIWYG, men den læser markdown ind i sin
egen model og skriver den ud igen, så filen ændrer sig, uden at skribenten har rørt den). Svelte
eller React til fladen (unødvendig vægt til et vindue med tre paneler).
**Revurdér først hvis:** tilstanden i fladen bliver så kompleks, at fejl skyldes manglende
reaktivitet.

### ADR-0003 — Markdown-filen er sandheden (2/10-2026)
**Status:** de åbne valg herunder er truffet i ADR-0008 (syntaks) og ADR-0009 (forfatterskab).
**Beslutning:** alt, der skal følge teksten, gemmes i selve .md-filen. **Parkeret tekst** ligger
som HTML-kommentarer nederst i filen. Programmet læser dem og viser dem i
sidebaren. Andre programmer viser dem ikke. **Dæmpet tekst** markeres i teksten.
*(Den konkrete syntaks for dæmpet tekst og formatet for kommentarblokken udestår. De vælges i
første plan efter afprøvning mod iA Writer, VS Code og pandoc.)*
**Alternativ der tabte:** en sidefil pr. dokument (`navn.parkeret.md`). Det er den arbejdsgang,
skribenten vil væk fra, og den går i stykker, når filen flyttes.
**Revurdér først hvis:** kommentarblokken bliver ødelagt af et andet værktøj i praksis.

### ADR-0004 — Sprogmodellen er `claude -p` på brugerens abonnement (2/10-2026)
**Beslutning:** Rust starter `claude -p` som underproces med `--json-schema`, kun værktøjerne
`WebSearch` og `WebFetch`, og `--no-session-persistence`. Argumenterne gives som liste, aldrig
gennem en shell. Prompten står før liste-flag (L-089). Svaret valideres mod skema i Rust, og et
tomt eller afkortet svar er en fejl, ikke »intet fundet« (L-592, L-595). Et citat fra en kilde
vises først som citat, når det er fundet i den hentede tekst (L-326, Prismets citatsøger).
`--bare` kan ikke bruges, fordi den kræver `ANTHROPIC_API_KEY`. Alt bag ét modul, så motoren kan
skiftes.
**Bevidst afvigelse:** teksterne sendes til Anthropic i USA. Det bryder med »7 ting« 2f, men det
er skribentens egne udkast, uden andres persondata, og kun når skribenten beder om det.
**Alternativ der tabte:** Claude API (koster tokens oven i abonnementet), Scaleway i EU (ingen
websøgning), lokal model (for svag til faktatjek, langsom på en almindelig bærbar).
**Revurdér først hvis:** Anthropic ændrer vilkårene for programmatisk brug af abonnementet, eller
en EU-model med websøgning bliver god nok til faktatjek.

### ADR-0005 — Versionering og forfatterskab ligger uden for filen (2/10-2026)
**Status:** afløst af ADR-0009 samme dag. Forfatterskabet flytter ind i filen, historikken bliver.
**Beslutning:** historikken gemmes i `%APPDATA%\Gode Tekster`, ikke i .md-filen, så filen forbliver
ren markdown. Hvert gem fra programmet er en version. Forfatterskab regnes ud fra historikken:
tekst skrevet i programmet er skribentens. Tekst, der dukker op ved en ændring udefra, mærkes som
AI. Tekst taget ind fra research mærkes som AI. Indsat tekst fra udklipsholderen mærkes
»indsat« til skribenten har set den.
*(Lageret — SQLite, snapshots eller git — udestår. Det vælges i historikkens egen plan.)*
**Alternativ der tabte:** forfatterskab som markering i selve filen. Det ville fylde teksten med
mærker og gå i stykker ved enhver redigering udefra.
**Revurdér først hvis:** skribenten vil kunne se forfatterskabet på en anden maskine.

### ADR-0006 — Ingen telemetri, ingen server (2/10-2026)
**Beslutning:** STANDARD 1.39 (telemetri fra dag ét til projektets egen Postgres) gælder ikke. Der
er ingen server og ingen database at sende til. Fejl skrives i en lokal logfil i
`<data>\log`, uden tekstindhold.
**Revurdér først hvis:** programmet nogensinde får flere brugere end én.

### ADR-0007 — Biblioteker frem for hele arbejdsmappen (2/10-2026)
**Beslutning:** mappetræet viser kun mapper, brugeren selv tilføjer. Husets kontraktfiler vises
dæmpet med en til/fra-knap. Reglerne står i STRATEGI → »Afgrænsningen«.
**Alternativ der tabte:** hele arbejdsmappen som ét træ. Tusindvis af filer, som Claude har skrevet.
**Revurdér først hvis:** brugeren oftere søger efter filer uden for sine biblioteker end i dem.

### ADR-0008 — Syntaks for dæmpet og parkeret tekst (2/10-2026)
Udfylder det, ADR-0003 lod stå åbent.
**Beslutning:**
- **Dæmpet tekst** skrives `{--tekst--}` (CriticMarkups sletteforslag). Betydningen er præcis
  den rigtige: en foreslået sletning, der ikke er udført. Kun inden for én blok, ingen
  indlejring. Andre programmer viser tegnene bogstaveligt, og det er prisen.
- **Parkeret tekst** skrives som én HTML-kommentar pr. stykke efter teksten og før
  annotationsblokken: `<!-- gt:parkeret id=p1 dato=2026-10-02` … `-->`. Indholdet escapes, så det
  kan vendes om (`&#45;` → `&amp;#45;`, så `<!--` → `<!-&#45;`, `-->` → `-&#45;>`, `--!>` →
  `-&#45;!>`). Skjult i iA Writer, GitHub og Obsidian. pandoc dropper det i Word.
- Parkeret tekst tæller ikke i anslag, kommer ikke med i eksport og sendes ikke til modellen
  (STRATEGI, designprincip 5).

**Alternativ der tabte:** `==x==` (alle andre programmer viser det som *vigtigt*, det modsatte),
`[x]{.dim}` (pæn i pandoc, ligner et brudt link alle andre steder), `~~x~~` (betyder slettet).
For parkeret tekst: en sidefil som `FRAKLIP.md`, som er den arbejdsgang, skribenten vil væk fra.
**Ikke afprøvet endnu:** rundturen gennem iA Writer (kræver et manuelt tjek).
**Revurdér først hvis:** rundturen i iA Writer ødelægger en af de to former.

### ADR-0009 — Forfatterskab i filen som iA Markdown Annotations (2/10-2026)
Afløser ADR-0005.
**Beslutning:** forfatterskabet gemmes i selve filen i iA Writers åbne format, Markdown
Annotations v0.2 (`github.com/iainc/Markdown-Annotations`): en blok sidst i filen med SHA-256 af
teksten og intervaller i grafemer pr. forfatter. Filer skrevet i iA Writer har den allerede, og
programmet skal læse, bevare og skrive den bit-præcist, så iA Writer kan åbne filerne begge veje.

- **Tælling i Rust:** grafemer med `unicode-segmentation`. Fladen regner i UTF-16 (CodeMirror),
  og der konverteres kun ved indlæsning og gem. CRLF tæller som ét grafem.
- **Hvem er hvem:** tastet i programmet → `@Kim Skribent`. Godkendt modelforslag eller
  research → `&Claude`. Skrives der oven i AI-tekst, bliver de nye tegn skribentens
  (tegnniveau, som iA). Sletning flytter ikke ejerskab.
- **Indsat tekst** fra andre programmer mærkes »indsat, ukendt ophav« i en rolig farve, indtil
  brugeren vælger. Ctrl+Shift+V indsætter som AI. »Indsæt rettelser fra udklipsholder« tilskriver
  kun ændringerne (iA's Paste Edits From).
- **Ændret udefra:** passer hashen ikke, fordi en anden har rettet filen (typisk Claude),
  sammenlignes den med programmets seneste version i historikken (`dissimilar`). Ny tekst
  mærkes `&Claude` og vises med en stribe, til brugeren har set den. Det er bedre end iA, der kun
  kan spørge »behold eller kassér«.
  *Præcisering samme dag (review):* om en fil er ændret udefra, afgøres altid af programmets egen
  hash fra sidste gem (ADR-0013), også for filer uden annotationsblok. iA-hashen afgør kun, om
  intervallerne stadig passer. Findes der ingen tidligere version at sammenligne med (første
  gang filen åbnes, eller før historikken i trin 3), bliver de gamle intervaller til huller, som
  formatet tillader (»ukendt forfatter«), og originalen kopieres til `<data>\backup` før første gem.
- **Gamle blokke i teksten:** findes en annotationsblok inde i teksten (set i en rigtig fil
  2/10-2026, hvor iA engang ikke genkendte sin egen blok), tilbyder programmet at rydde den op.
  Det sker aldrig af sig selv.
- **Historikken** ligger i `<data>\historik.sqlite`: hele snapshots komprimeret
  med zstd og deduplikeret på blake3, med kilde (`app`, `external`, `first`, `restore`; `restore` er
  »gemt før skift«, også når brugeren vælger den anden udgave ved en konflikt) og
  forfatterskab på hver version. Versioner fra forskellige kilder slås aldrig sammen (VS Codes
  regel). Udtynding: alt fra 24 timer, så én pr. time i 14 dage, én pr. dag i 3 måneder, så én
  pr. uge. Alt andet end `app` og alle navngivne versioner udtyndes aldrig. Udtyndingen kører ved
  start og derefter højst én gang i døgnet ved et gem.
- Blokken skjules i editoren og fjernes ved al eksport.

**Alternativ der tabte:** forfatterskab uden for filen (ADR-0005). Det bryder med designprincip
6, mister forfatterskabet, når filen flyttes, og kan ikke læses af iA Writer. Git som historik:
versionerer træer, ikke enkeltfiler, og udtynding kræver omskrivning af historikken.
**Revurdér først hvis:** iA ændrer formatet uden at være bagudkompatibel, eller blokken skaber
problemer i værktøjer, skribenten sender filerne til.

### ADR-0010 — Sådan kaldes `claude` (2/10-2026)
Supplerer ADR-0004 med det, der er målt og læst samme dag.
**Beslutning:**
- **Start `claude.exe` direkte** (`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
  fundet via `claude.cmd`), aldrig `claude.cmd` og aldrig gennem `cmd.exe`. Rust kan ikke starte
  en `.cmd` uden en shell, og `.cmd`-argumenter har en kendt escape-fælde (BatBadBut).
- **Arbejdsmappe:** en tom mappe i `<data>\claude`. Uden `--bare` kører
  `claude -p` hooks og MCP-servere fra den mappe, den startes i, uden at spørge (headless-docs).
- **Flag:** prompten først (L-089), `--restricted` (fjerner alle værktøjer, der kører kode, og
  ignorerer bruger- og projektindstillinger), `--output-format stream-json --verbose`,
  `--json-schema`, `--tools WebSearch,WebFetch`, `--allowedTools` det samme, `--permission-mode dontAsk`,
  `--no-session-persistence`, `--strict-mcp-config`, `--setting-sources ""`,
  `--settings {"disableAllHooks":true}`, `--disable-slash-commands`. Miljø:
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. **Stdin lukkes**, ellers venter `claude` 3 s.
- **Abonnementsvagt:** `system/init` skal sige `apiKeySource: "none"`. Ellers stoppes kaldet med en
  dansk besked. Anthropic har varslet, at `--bare` bliver standard for `-p`, og `--bare` bruger
  ikke abonnementet.
- **Fremdrift:** værktøjskaldene i strømmen vises (»søger …«, »læser dst.dk …«). Forbruget fra
  `rate_limit_event` vises diskret.
- **Citater tjekkes af programmet selv:** Rust henter kildesiden og leder efter citatet med
  Prismets metode (præcist, derefter uden hensyn til mellemrum, mindst 8 tegn). Findes det
  ikke, vises det som »ikke fundet på siden«, aldrig som citat.
- **Målt 2/10-2026 i hovedsessionen** (Haiku, »svar ok«, Claude Code 2.1.287): uden flag ca. 8 s
  udefra, heraf 1,5 s internt. Med flagene ovenfor 3,7-5 s. Med `--restricted` og stdin lukket
  3,3 s, heraf 1,36 s internt, `apiKeySource=none`, kun `WebFetch,WebSearch`. To indbyggede
  plugins indlæses stadig. Uden lukket stdin skriver `claude` »no stdin data received in 3s«.
  Et research-kald (Sonnet, to kilder til DST's befolkningstal) tog 62 s, 12 runder og 10
  værktøjskald. Modellens første »citat« handlede om middellevetid, ikke om påstanden.

**Revurdér først hvis:** `apiKeySource` holder op med at være `none` uden `--bare`, eller en
varm reserveproces (startet, før brugeren trykker) viser sig at spare mere end 2 sekunder.

### ADR-0011 — Print, PDF og Word (2/10-2026)
**Status:** Word-delen er afløst af ADR-0018, Ctrl+P og PDF er præciseret i ADR-0021. Resten gælder.
**Beslutning:**
- **Én print-DOM og ét stylesheet** til både Ctrl+P og PDF. Markdown renderes ind i
  `<article lang="da">` med `@page`, margin-bokse til sidetal (Chromium 131+) og
  `break-inside: avoid` på overskrifter. Parkeret tekst, dæmpet tekst og annotationsblokken
  er fjernet før rendering (dæmpet tekst kan vælges med).
- **Ctrl+P** fanges i fladen og viser WebView2's egen print-forhåndsvisning
  (`ShowPrintUI(BROWSER)`), uden URL i sidehoved og -fod.
- **PDF** via `ICoreWebView2_7::PrintToPdf` fra Rust med A4 og margener sat eksplicit, fordi det
  er udokumenteret, om CSS'ens `@page` vinder.
- **Word** via pandoc 3.12 med `-f markdown-smart` og en `gt-reference.docx`. Dæmpet tekst og
  anførselstegn behandles i Gode Tekster først, fordi pandocs docx-writer hardkoder engelske
  anførselstegn. Fodnoter bliver ægte Word-fodnoter.
- **To skabeloner:** »Manuskript« (A4, 2,5 cm, Times New Roman 12/1,5, ingen orddeling, titel og
  forfatter øverst, »Side X af Y«, anslag på forsiden) og »Læseudgave« (Newsreader 11/1,4, ca.
  130 mm satsbredde, orddeling, diskret sidetal).

**Alternativ der tabte:** pandoc til PDF (kræver LaTeX og ser anderledes ud end skærmen, Typoras
fælde). JS-pakken `docx` til Word (ingen ekstern binær, men al mapping skal skrives selv). Den
er planen B, hvis pandoc bliver en byrde.
**Revurdér først hvis:** rigtige fodnoter nederst på siden bliver et krav i PDF (Chromium kan
ikke, Paged.js kan).

### ADR-0012 — Typografi og tal (2/10-2026)
**Status:** skrivefladens skrift og farver er afløst af ADR-0015 samme dag. Resten gælder.
**Beslutning:**
- **Skrivefladen:** iA Writer Quattro (SIL OFL, bundlet uændret, fordi navnet er beskyttet).
  Linjelængde ca. 65 tegn (Birkvig: højst 65, WCAG: højst 80), skriftstørrelsen følger
  vinduesbredden, linjehøjde ca. 1,5. **UI:** Schibsted Grotesk (husets skrift). **Læseudgave:** Newsreader (OFL). »Manuskript« bruger Times New Roman, som følger med Windows. Farver fra
  `gode-medier-ui`. `--gm-ink45` til dæmpet tekst.
- **Anførselstegn:** »…« som standard (Information, Berlingske og Jyllands-Posten), ”…” som
  valg. Programmet laver aldrig em-dash (—), fordi `SKRIVESTIL.md` forbyder den. ` - ` mellem
  ord kan blive til ` – `. Intervaller (`9-16`, `mandag-fredag`) røres ikke
  (Retskrivningsordbogen § 57).
- **Tal:** anslag inklusive mellemrum er hovedtallet. Ord, normalsider (2.400 anslag) og læsetid
  følger. Mål kan være et loft. Parkeret tekst og annotationsblokken tæller ikke.
- **Stavekontrol:** WebView2's indbyggede med `lang="da"`. Brugerens egen ordbog fra iA Writer
  (`%APPDATA%\iA Writer\custom_dictionary.txt`) hentes ind.

**Revurdér først hvis:** WebView2's stavekontrol ikke kan dansk på pc'en (ikke afprøvet endnu).

### ADR-0013 — Kilden røres aldrig (2/10-2026)
**Beslutning:** et gem skriver præcis de bytes, editoren viser, plus brugerens egne rettelser og en
opdateret annotationsblok. Kodning, BOM og linjeskift gemmes pr. fil og skrives tilbage uændret.
Ingen normalisering af tabeller, lister, anførselstegn eller afsluttende linjeskift. Gem er
atomisk: midlertidig fil i samme mappe, `sync_all`, `ReplaceFileW` (bevarer ACL og
oprettelsestid), med genforsøg ved fejl 1176 (OneDrive og antivirus). Egne skrivninger skelnes
fra fremmede på hash, ikke på tidsvindue. Filovervågning med `notify` 9.0-rc eller 8.2 med periodisk genscanning, valgt i plan 2
(8.2 mister hændelser i stilhed, når bufferen løber over, og 9 er kun en release candidate).
**Undtagelse:** filer med blandede linjeskift kan ikke bevares, fordi CodeMirror samler dem. De
meldes ved åbning og gemmes først, når brugeren har sagt ja.
**Alternativ der tabte:** at »rydde op« i markdown ved gem, som Typora gør. Det er den klage,
brugerne har haft længst, og det ødelægger diffs og Claudes rettelser.
**Revurdér først hvis:** aldrig for normaliseringen. Teknikken bag gem revurderes, hvis
`ReplaceFileW` giver konfliktkopier i OneDrive (ikke afprøvet endnu).

### ADR-0014 — Programmet bliver kørende i baggrunden (2/10-2026)
Registrerer, at ADR-0001's »Revurdér først hvis« blev udløst samme dag.
**Målt:** Tauris eksempel i release-byg brugte 1,25 s fra start til WebView2-processen ved første
kørsel og 0,25-0,3 s ved de næste. Tegning og JavaScript kommer oveni.
**Beslutning:** ADR-0001 står. Kold start afhjælpes i stedet ved, at programmet bliver kørende:
ét vindue (`tauri-plugin-single-instance`, så »Åbn med« fra Stifinder genbruger processen), luk
skjuler vinduet i stedet for at afslutte, og et ikon i meddelelsesområdet afslutter for alvor.
Programmet kan startes skjult ved login, så også første åbning efter en genstart er varm. Vinduet
oprettes med `visible:false` og vises, når editoren har fokus, med en nødtimer på 1,5 s.
**Alternativ der tabte:** ren Rust (ADR-0001's alternativ). Det ville starte hurtigere koldt,
men koster måneder på skrivefladen. Varm start er allerede under målet.
**Revurdér først hvis:** varm start i plan 1, målt til markør i en fil på 17.520 tegn, er over
600 ms, eller den skjulte proces bruger mere end 150 MB hukommelse.

### ADR-0015 — Udseendet er iA Writers opsætning (2/10-2026)
**Status:** skrift, farver og markør er afløst af ADR-0037 (8/10). Paneler, tal og menuer gælder.
Afløser skrift og farver i ADR-0012. Valgt på et designlærred (»A2«).
**Beslutning:**
- **Flade:** lysegrå som iA (`#f7f7f7` til teksten, `#f3f3f3` til panelerne), ingen beige. Tekst
  `#2b2b2b`. Markøren er iA's tykke blå (`#1aa3ff`, 3 px).
- **Skrift:** iA Writer Duo som standard (SIL OFL, bygget på IBM Plex Mono). Valg i indstillingerne:
  iA Writer Quattro (OFL, bundlet), Arial og Georgia (Windows) og Avenir Next, hvis den er installeret,
  ellers Segoe UI (3/10; Avenir er en købeskrift og må ikke bundles).
- **Paneler:** biblioteket til venstre som iA's liste (navn, tid, to linjers uddrag, blå markering),
  fraklip til højre som standardfane med Fakta, Research og Sprog som sekundære faner. Ctrl+E og
  Ctrl+W skjuler og viser dem. Ctrl+R viser forhåndsvisning.
- **Tal:** et ordtal i nederste højre hjørne, svagt, der vises ved hover eller altid.
- **Ingen småtekster** på skærmen: ingen hints, ingen »fra FRAKLIP.md«, ingen statuslinje.
- **Formatering ved markering:** en lille menu (B, I, U, S, lister, H1-H4, »···«). Understregning
  skrives som `<u>…</u>`, fordi markdown ikke har det. »Lav til tabel« laver en markdown-tabel af
  linjer eller tabulatorer.

*Præcisering samme dag:* panelerne er skjult som standard og glider frem ved
musen (ca. 240 ms, blød kurve, 350 ms pause før de glider væk igen). Ctrl+E og Ctrl+W
fastgør og frigør, og det gør knappenålen nederst i panelet også. Fastgjort-tilstanden huskes.
Kanten, der får et panel frem, er 56 px bred (18 px krævede, at musen gik for langt ud).
Citat: variant A (klassisk streg, afløste variant 3 samme dag). Logo: variant C, app-ikonerne genereres med `npx tauri icon assets/logo/gode-tekster-1024.png`.

**Alternativ der tabte:** »B · Redaktion« (arket og margenen, for meget på skærmen) og »C · Mørkerum«
(mørkt med fokus). Mørkerum lever videre som mørk tilstand og fokustilstand (trin 5).
**Revurdér først hvis:** brugeren efter to ugers brug savner noget fra B eller C.

### ADR-0016 — Alle datakilder via gode-mcp (2/10-2026)
**Status:** besluttet, ikke bygget. Venter på nøglen. Indtil da får `claude -p` ingen MCP.
Valgt samme dag.
**Beslutning:** Gode Tekster har én hemmelighed: en `gmcp_live_`-nøgle til gode-mcp
(`https://mcp.godemedier.dk/mcp/`) i Windows Credential Manager. Når Claude laver faktatjek eller
research, får `claude -p` gode-mcp med via `--mcp-config` og en `--allowedTools`-liste over
præcis de værktøjer, kaldet må bruge (ADR-0010). Sprogtjek (klarhed og maskinsprog) hentes via
`ord_sprogtjek`, så Gode Ords ordlister kun bor ét sted. Mangler en kilde (Retsinformation,
OpenAlex, CVR, søgning i Folketinget), tilføjes den som værktøj i gode-mcp, så alle husets
programmer får den, og nøglerne bliver på serveren.
**Kortlagt 2/10-2026:** gode-mcp eksponerer kernedata (ODA, DST, Høringsportalen), suitens apps og
`ord_sprogtjek`. Gode Fakta er et modul i Gode Ord uden API. Husets LanguageTool er stoppet
(REGISTRY blok 8), så stavning og grammatik følger ikke med `ord_sprogtjek` i dag.
**Alternativ der tabte:** at Gode Tekster kalder kilderne selv fra Rust. Hurtigere at bygge, men
logikken ville ligge to steder, og nøgler som CVR's ville havne på pc'en.
**Revurdér først hvis:** gode-mcp er nede så ofte, at faktatjek ikke kan regne med den, eller et
værktøj skal virke uden net.

### ADR-0017 — Kildehenvisninger som markdown-fodnoter (2/10-2026)
Ønsket samme dag.
**Beslutning:** fodnoter skrives som markdown-fodnoter: `[^1]` i teksten og `[^1]: …` efter
teksten (før parkeret tekst og annotationsblokken, ADR-0008/0009). iA Writer, Obsidian, GitHub og
pandoc forstår formatet, og pandoc laver ægte Word-fodnoter af det.
- **I editoren** vises henvisningen som et lille hævet tal. Definitionerne vises og redigeres i
  fanen **Noter** i højre spalte, i den rækkefølge de bruges. Klik på nummeret i fanen springer til
  henvisningen i teksten. (Klik på tallet i teksten åbner ikke noten endnu.)
- **Ny fodnote:** Ctrl+Alt+F (Words genvej) indsætter næste ledige nummer ved markøren og åbner
  noten. Eksisterende etiketter omnummereres aldrig i filen (ADR-0013). Visningen nummererer efter
  rækkefølge.
- **Fra research og faktatjek:** en fundet kilde kan sættes ind som fodnote med titel, link til
  citatet og dato. Den mærkes som AI-tekst i forfatterskabet, indtil skribenten har rettet i den.
- **Eksport:** Word får ægte fodnoter. PDF får noterne samlet sidst som »Noter«, fordi Chromium ikke
  kan sætte fodnoter nederst på siden (ADR-0011).
- **Fodnoter tæller med** i anslag som standard. Det kan slås fra, når et medie tæller uden noter.

**Alternativ der tabte:** kilder som almindelige links i teksten (forsvinder i print) og
Pandoc-inline-noter `^[…]` (fylder i teksten, færre programmer forstår dem).
**Revurdér først hvis:** skribenten skal aflevere PDF med fodnoter nederst på siden. Så skal Paged.js
eller pandoc med LaTeX ind.

### ADR-0018 — Word-eksport med JS-pakken docx (2/10-2026)
Afløser Word-delen af ADR-0011.
**Beslutning:** Word-filer laves i fladen med `docx` (MIT) ud fra de samme markdown-tokens, som
print bruger (`markdown-it`). Overskrifter, afsnit, fed, kursiv, understreget, gennemstreget,
citater, lister, tabeller og ægte Word-fodnoter. Danske anførselstegn skrives, som de står.
Dæmpet tekst, parkeret tekst og annotationsblokken kommer ikke med.
**Alternativ der tabte:** pandoc (ADR-0011). Ikke installeret på pc'en, og installationen kræver
formentlig et UAC-klik. pandoc hardkoder desuden engelske anførselstegn i docx.
**Revurdér først hvis:** Word-filerne mangler noget, pandoc ville have klaret (fx komplekse tabeller).

### ADR-0019 — Rettelser udefra flettes ind, mens skribenten skriver (2/10-2026)
Ønsket samme dag: iA spørger »File has been modified outside the editor. Reload?«.
**Beslutning:** filovervågningen (og fokus-tjekket) henter den nye udgave og fletter den ind som
en almindelig CodeMirror-ændring (`merge.rs`): tre udgaver, sidst gemt, editoren og disken.
Markør, rulning og fortryd overlever, og »Fortryd rettelsen« står i beskedlinjen, indtil skribenten
skriver videre. Rettelsen er sin egen fortryd-gruppe. Det nye bliver Claudes og får en violet
stiplet streg (ADR-0009). Har skribenten ugemte rettelser på *andre* linjer, flettes begge. Har begge
rettet på samme linje, vælger skribenten »Behold min« eller »Brug den nye«, og begge udgaver ligger i
Versioner. Gem står stille, mens der flettes, så den nye udgave aldrig overskrives.
**Alternativ der tabte:** iA's spørgsmål (afbryder hver gang) og stille genindlæsning af hele
filen (mister fortryd-historikken og kan flytte markøren).
**Revurdér først hvis:** linje-reglen giver konflikter for tit, når Claude og skribenten arbejder i
samme afsnit. Så kan konflikten gøres finere (ord i stedet for linjer).

### ADR-0020 — Ordklasser fra træbanken UD Danish-DDT (2/10-2026)
Afløser den interne LanguageTool-plan (Java og en ordbog, hvis licens ikke var tjekket).
**Beslutning:** `scripts/ordklasser.mjs` bygger `src/assets/ordklasser.json` (200 KB, 16.600
ordformer) af den danske træbank UD Danish-DDT (CC BY-SA 4.0, kildeangivelse ved filen). Hver
form får sin hyppigste ordklasse blandt de fem, iA viser. Ukendte sammensætninger får sidste leds
ordklasse, navneordsbøjning skæres af, og endelser gætter til sidst. Leksikonet hentes først, når
ordklasserne slås til.
**Alternativ der tabte:** LanguageTools morfologik-ordbog (kræver Java, ingen kontekst) og spaCy
(Python ved siden af programmet).
**Revurdér først hvis:** flertydige småord (»så«, »for«, »en«) farves forkert så tit, at det
forstyrrer. Så skal der kontekstregler eller en lille tagger til.

### ADR-0021 — Udskrift, PDF og citattjek i praksis (2/10-2026)
Supplerer ADR-0010 og -0011 med det, der blev bygget.
**Beslutning:**
- **Ctrl+P** er `window.print()`, som i WebView2 åbner samme forhåndsvisning som
  `ShowPrintUI(BROWSER)`. `ShowPrintUI` tager ingen printindstillinger, så browserens sidehoved
  og -fod kan ikke slås fra i API'et. Brugeren fjerner fluebenet én gang, og WebView2 husker det.
- **PDF** er `ICoreWebView2_7::PrintToPdf` gennem Tauris `with_webview` og den `webview2-com`, Tauri
  selv bruger (pinnet `=0.39.1`). Rust skriver kun til stien fra Gem-dialogen.
- **Citattjekket** henter kildesiden med `ureq` over Windows' egen TLS (SChannel), ikke rustls, så
  der ikke kommer en ekstra kryptokode ind, og Windows' certifikatlager gælder.
- **Print-laget og Word-koden** hentes først ved brug (dynamisk import), så opstarten ikke
  betaler for markdown-it, docx og mammoth.
**Revurdér først hvis:** sidehovedet i Ctrl+P ikke bliver væk, når det er slået fra én gang. Så
skal Ctrl+P gå over PDF i en midlertidig fil.

### ADR-0022 — Sikkerhed efter review: stier, prompt og citattjek (2/10-2026)
Fra security-reviewet samme dag (ingen XSS fundet, men forsvar i dybden manglede).
**Beslutning:**
- **Stier:** bibliotekerne ændres kun gennem Windows' mappevælger i Rust (`add_library`,
  `remove_library`). `save_settings` rører dem aldrig. Åbn tager kun `.md`, `.markdown` og `.txt`,
  og kun fra et bibliotek eller fra en fil, brugeren selv har valgt (»Åbn med«, dialogen, sidst
  åbne). Gem virker kun på åbne filer. Omdøb kun til tekstfiltyper. Fraklip hentes kun ved siden
  af en åben tekst. Billedadgang aldrig til et helt drev eller hele brugermappen.
- **Prompten** går via stdin (kommandolinjen har et loft på 32.767 tegn). Teksten står i en
  afgrænser med et tilfældigt navn pr. kald, tekstens egne `</tekst`-mærker er neutraliseret, og
  HTML-kommentarer er fjernet. Fremdriften viser hele adressen for hver side, modellen henter.
  `--model sonnet`. Et svar uden `system/init` kasseres, og `ANTHROPIC_API_KEY` fjernes fra miljøet.
- **Citattjekket** henter kun offentlige https-adresser (loopback, private net, link-local,
  CGNAT og `.local` afvises), og hvert redirect efterprøves (L-610). User-Agent'en er neutral, så
  kilden ikke ser, hvem der faktatjekker den. »Citatet står på …« nævner værtsnavnet.
**Rest-risiko:** et navn kan skifte adresse mellem tjek og hentning (blindt GET, intet svar
tilbage). Claude Codes egen WebFetch kan stadig hente frit; det er grunden til, at hele adressen
vises.
**Revurdér først hvis:** fladen nogensinde viser HTML fra en fremmed kilde.

### ADR-0023 — Claudes resultater i filen, billeder i medier (2/10-2026)
Valgt samme dag, efter personatjekket (faktatjekket forsvandt ved filskift).
**Beslutning:**
- **Faktatjek og research** gemmes som skjulte blokke sidst i teksten,
  `<!-- gt:claude id=c1 type=faktatjek|research dato=…` med JSON, escapet som fraklip (ADR-0008).
  Et nyt faktatjek erstatter det forrige; research lægges ved siden af. De følger teksten, kommer
  med i Versioner, vises i fanen Claude og fjernes fra ordtal, print, Word og det, der sendes til
  Claude. Kald står i kø; et svar til en tekst, der ikke er åben, lægges ind, når den åbnes igen.
  En vurdering uden en kilde, programmet selv har fundet citatet på, vises som »Ikke efterprøvet«.
- **Billeder** kopieres altid til `medier/` ved siden af teksten med et læsbart navn
  (`artikel-1-portraet.jpg`) og en relativ sti i teksten. Vælger (Ctrl+Alt+I), træk fra
  Stifinder og Ctrl+V. Rust skriver kun ved siden af en åben tekst. Originalen røres aldrig.
  Alle gængse fotoformater: jpg, png, gif, webp, svg, avif og bmp vises som de er. **HEIC** (iPhone)
  og **TIFF** kan WebView2 ikke vise, så de laves om til JPEG med Windows' egen WIC, med kameraets
  retning lagt ind og uden metadata (`convert.rs`). Ingen ny crate: `windows` 0.62.2 er webview2-coms egen.
- **`dragDropEnabled: false`** i vinduet: på Windows slugte Tauris egen filhåndtering al
  HTML5-træk i webviewet (fraklipskort, filer i biblioteket).
**Alternativ der tabte:** en `research/`-mappe (ekstra filer i tekstmapperne, følger ikke med
filen) og resultater kun i hukommelsen (forsvandt ved filskift).
**Revurdér først hvis:** blokkene gør filerne svære at læse i iA Writer eller hos modtagere, der
får markdown-filen direkte.

### ADR-0024 — Noter, rettelser, stiltjek og navigation (2/10-2026)
Fra research-runde 2 (intern note om små og open source-programmer), valgt samme dag.
**Beslutning:**
- **CriticMarkup ud over dæmpet tekst** (`critic.ts`): noter `<!-- … -->` (Ctrl+Alt+N, før `{>> … <<}`, som stadig læses) og rettelser
  `{++ny++}` / `{~~gammel~>ny~~}`, der godtages eller afvises ét ad gangen (boble ved markøren,
  »alle« i beskedlinjen). Ren sletning skrives som erstatning med tom ny tekst, fordi `{--…--}`
  allerede betyder dæmpet. En rettelse, der ikke er taget stilling til, tæller som den oprindelige
  tekst i ordtal, print, Word og Claude (`withoutParked`). Godtag fjerner kun mærker, så
  forfatterskabet bliver stående.
- **Redaktørens Word-rettelser:** Word-XML'en læses i to udgaver (alle ændringer afvist / godtaget);
  forskellen på ordniveau (`word_diff` i Rust) bliver rettelser, kommentarerne noter. Mammoth
  alene godkender ændringer uden at vise dem.
- **Sammenlign med en version:** samme rettelser, indsat som mærker omkring den nuværende tekst.
- **Stiltjek (F7)** med Gode Ords regler. `scripts/sprog.mjs` kopierer `clarity.ts`, `quotes.ts`
  og `aitells.ts` med commit-stempel (L-007); `sprog.test.ts` fejler ved drift. Fejl i reglerne
  rettes i Gode Ord (sætningsdeling og passiv rettet der 2/10, gode-ord 239f974). Analysen kører
  i en worker (`styleWorker.ts`): 200 sider tager 340 ms, som før frøs fladen ved hver pause.
- **Navigation:** Ctrl+J disposition (fra 2/10 en fane i venstre spalte ved siden af Bibliotek, hvor en
  overskrift kan trækkes for at flytte sektionen. Ønsket var »UI clean«, intet nyt vindue), Alt+↑/↓ flytter afsnit og sektioner, Alt+Shift+←/→ folder,
  Ctrl+Shift+F søger i hele biblioteket, Ctrl+Shift+C kopierer som formateret tekst.
**Alternativ der tabte:** et eget kommentarformat (ikke læsbart i andre programmer), pandoc til
sporede ændringer (ikke installeret, ADR-0018), egne ordlister (dobbelt vedligehold).
**Revurdér først hvis:** CriticMarkup-mærker driller i iA Writer eller hos modtagere af md-filen.

### ADR-0025 — Testrunde (2/10-2026)
Rettelser og valg efter den første test af det byggede.
**Beslutning:**
- **Skær gør arbejdet selv:** én knap (klik = lidt, dobbeltklik = meget), alle forslag dæmpes i én
  ændring, status og Fortryd i beskedlinjen. Godkendelse sted for sted (suggestions.ts) er fjernet.
  Dæmpet tekst klikkes væk med en boble (dimBubble.ts) og kan flyttes samlet til fraklip (dimming.ts).
- **Søg i alle tekster bor i Ctrl+F** med `/` foran (libraryResults.ts). Vinduet for sig er fjernet.
- **Indstillinger er et vindue midt på skærmen** med to kolonner og kontakter, ikke et ark i spalten.
- **Højreklik** viser kun klip, kopiér, sæt ind, markér alt og stavning (contextmenu.rs filtrerer
  WebView2's menu efter en positivliste).
- **»Markér som andres«** gemmes som reference i iA's format uden farve; stiltjekket springer den over.
- **Manuskript-print** har skærmens skrift og 3,5 cm marginer i stedet for Times 12 og 2,5 cm.
- Desuden: Tab rykker ind, F11 fuld skærm, biblioteksoversigt over rødderne, billedkode skjult uden
  markør, gule noter, fanerne Input og Fodnoter, dispositionen følger rulningen.
- **Installation:** NSIS-installer kun for brugeren (ingen administrator), dansk guide
  (`src-tauri/nsis/Danish.nsh`, Tauri 2.12 havde ingen dansk), og .md/.markdown tilknyttes.
  .txt bevidst ikke, så Notesblok beholder sine filer. Usigneret: SmartScreen spørger første gang.
**Revurdér først hvis:** Skær dæmper for meget til, at Ctrl+Z føles som nok, eller `/` kolliderer
med noget, brugeren søger efter i én tekst.

### ADR-0026 — Brugerens egen sprogmodel (3/10-2026)
Gode Tekster skal kunne deles, og ikke alle har Claude. Afløser den del af ADR-0010, der gjorde
Claude til eneste udbyder; kaldeopskriften for Claude står uændret.
**Beslutning:**
- **Ét lag, tre udbydere** (`ai.rs`): Skær, faktatjek, research og renskriv sender samme prompt og
  samme JSON-skema, og laget vælger udbyder efter indstillingen `aiProvider` (ellers den første, der
  er klar). Svaret valideres af kalderen, uanset udbyder.
- **Claude** via brugerens eget Claude-program og Pro/Max-abonnement (`claude.rs`). Programmet
  findes i PATH, `.local\bin`, npm og WinGet. Login tjekkes med `claude auth status`, der skal svare
  `loggedIn` og `authMethod: "claude.ai"` (en API-nøgle tæller ikke). Anthropics vilkår: brugeren
  logger selv ind i det uændrede program, og ingen funktion må hedde »Claude Code«.
- **ChatGPT** via OpenAIs Codex-program (`codex.rs`): `codex exec` med prompt på stdin,
  `--output-schema`, `--sandbox read-only`, `--ephemeral`, tom arbejdsmappe, ingen API-nøgle i
  miljøet. **Ikke prøvet mod et rigtigt login endnu** (Codex var ikke installeret 3/10).
- **Gemini** via Gemini API med brugerens egen, gratis nøgle (`gemini.rs`), fordi Gemini CLI ikke
  længere tager forbrugerkonti. Nøglen prøves, før den gemmes, og ligger i Windows'
  legitimationsadministrator under »Gode Tekster/Gemini«. Fladen kan gemme og slette den, aldrig
  læse den.
- **Lov første gang pr. udbyder:** før den første afsendelse siger fladen, hvem teksten sendes til.
- **Login-tjek kun ved brug** og i indstillingerne, gemt et minut: Claudes tjek er et program på
  250 MB i cirka 5 s og må ikke køre ved hver start.
**Revurdér først hvis:** Codex' flag ændrer sig, eller Google lukker den gratis kvote.

### ADR-0027 — Egne kommandoer med »/« (5/10-2026)
Brugeren skal selv kunne definere skabeloner og handlinger og sætte dem ind med `/`. Rammen skal
være bred, men så afgrænset, at intet går i stykker, når man prøver sig frem. Research, design og
kontrakt står i en intern plan.
**Beslutning:**
- **Fire slags, ingen kode:** skabelon (felter i `{{…}}`), omformning (kæde af højst 8 navngivne
  klodser), tjek (ordliste eller indbygget, læser kun) og AI (instruks plus svarform).
- **Én kommando er én markdown-fil** med et fladt hoved af `nøgle: værdi` og en krop. Egne
  kommandoer ligger i `Dokumenter\Gode Tekster\Kommandoer` (engelsk: `Commands`). Stien gemmes i
  `commandsDir`, når mappen laves, så den ikke flytter sig ved sprogskift, og fladen kan ikke
  flytte den (`save_settings` beholder den som bibliotekerne).
- **De indbyggede ligger i programmet** på begge sprog (`src/commands/builtin.ts`). En egen
  kommando med samme navn skygger, og hver indbygget kan slås fra (`disabledCommands`).
- **Rust er kun fil-ind/ud og de to AI-kald** (`commands.rs`). Fladen får ingen ny filadgang:
  kun .md-filer direkte i mappen, stier kanoniseres, gem er atomisk, slet går til papirkurven.
  Parser og validator er én (`src/commands/model.ts`) og bruges til filer, formularen og
  sprogmodellens forslag.
- **AI-kommandoer peger, spørger og tjekker.** To svarformer, `findings` og `questions`. Programmet
  lægger rammen: teksten og instruksen er data i hver sin afgrænser, ét kald uden værktøjer
  (`ai::run_without_tools`), og Rust validerer svaret, før fladen ser det. Uddrag, der ikke står
  ordret i teksten, kasseres, og for lange punkter kasseres frem for at blive forkortet.
- **»Beskriv en kommando«:** sprogmodellen får fladens katalog og svarer med én kommando eller
  `possible: false`. Rust tjekker form og længder, `model.ts` resten. Intet gemmes før et klik.
- **`/` åbner kun** først på en linje eller efter et blanktegn. Ctrl+Shift+P åbner menuen med
  markeringen i behold. Alt, en kommando gør i teksten, er ét fortryd-trin.

| Grænse | Værdi | Hvorfor |
|---|---|---|
| Kode, scripts, shell, regulære udtryk | findes ikke | Skrøbeligt, og et sikkerhedshul ved deling |
| Andre filer og mapper, net fra en kommando | findes ikke | Programmets filgrænse. Web kun i Faktatjek og Undersøg |
| Kommandoer, der kalder kommandoer eller kører af sig selv | findes ikke | Ingen løkker, ingen overraskelser |
| Ukendte felter, klodser og nøgler | fejl i fanen | En fejl skal ses i fanen, ikke i artiklen |
| Fil / antal filer | 20 KB / 200 | En fil med fejl ødelægger ikke de andre |
| Klodser i en kæde | 8 | Kæden kan læses fra top til bund |
| AI-instruks | 2.000 tegn | Ét kald pr. kørsel |
| AI-svar | 30 fund, 10 spørgsmål, 300 tegn pr. punkt | Uden loft bliver et forslag til brødtekst |
| AI-forslag til kommando | navn 24, beskrivelse 80, krop 4.000 tegn | Samme grænser som en håndskrevet fil |

**Alternativer, der tabte:**
- **Scripts eller regulære udtryk** (Templater, Drafts, Espanso): det er der, de andre går i
  stykker, og en delt kommando bliver kode fra fremmede.
- **YAML eller JSON som filformat:** skabeloner er tekst på flere linjer, og et fladt hoved kan
  læses af en lille egen parser uden en ny pakke.
- **De indbyggede som filer på disken:** en opdatering kunne ikke forbedre dem uden at røre
  brugerens filer, og de kunne komme i ustand.
- **Svarformen »alternativer«** (korte forslag til rubrik og manchet): fravalgt 5/10,
  fordi modellen aldrig formulerer tekst. `/rubrikker`, `/manchet` og `/mellemrubrikker` udgik.
- **Web i egne AI-kommandoer:** fremmed tekst plus værktøjer plus en delt prompt er opskriften
  fra Notion-sagen (september 2025).

**Kendt rest:** Codex har ingen kontakt, der slår dets egen skal fra. Uden `--search` har det
intet net, og sandkassen er skrivebeskyttet med en tom arbejdsmappe, men »ingen værktøjer« er
kun fuldt sandt for Claude og Gemini. Ikke prøvet mod et rigtigt login.
**Revurdér først hvis:** brugeren vil have korte AI-forslag alligevel (så er det en ny svarform
med sit eget loft, ikke et friere skema), eller en kommando får brug for en anden fil.

### ADR-0028 — Færre kommandoer, beskriv med ord, »/« på en markering (6/10-2026)
Efter første brug af 0.2.4: kommandoerne var for specifikke til brugeren, der var for mange
(»hvorfor ikke bare /tjek?«), omformningerne virkede ikke, og en ny kommando var for svær at lave.
Afløser ADR-0027 på de tre punkter herunder. Resten af ADR-0027 (filformat, klodser, grænser,
AI peger og spørger) gælder uændret.
**Årsagen til at omformningerne »ikke virkede«:** markeret tekst plus tastet »/« erstattede
markeringen med skråstregen, før menuen åbnede. Kommandoen fik et tomt afsnit og svarede »Stil
markøren i et afsnit«. Klodserne var i orden. Testene og scenariet kaldte `runCommand` direkte
og gik derfor uden om tastningen.
**Beslutning:**
- **12 indbyggede i stedet for 27:** `/dato`, `/tabel`, `/møde`, `/brev` · `/ryd`, `/liste`,
  `/sorter`, `/citat` · `/tjek` · `/nylæser`, `/redaktør`, `/halver`. Journalistskabelonerne
  (interview, pitch, rettelse, vinkel, faktaboks, kilde, aflevering, byline, nyhedsbrev, artikel)
  og `/nu`, `/fraklip`, `/husk`, `/sætning`, `/konsistens` udgik. Fraklip og noter har deres egne
  genveje, og `/konsistens` overlappede `/tjek`.
- **Ét `/tjek`:** `builtin: all` kører huller, navne og tal samt gentagelser i én liste. De tre
  enkelte id'er virker stadig i egne filer.
- **»/« på en markering åbner menuen og lader markeringen stå** (`slashOnSelection` i
  `slashMenu.ts`), som Ctrl+Shift+P. Ikke i kode og links, og ikke med flere markeringer.
- **En ny kommando beskrives med ord.** Fanen begynder med et tekstfelt. Sprogmodellen bygger
  kommandoen (samme kald og validator som før), og forslaget vises med navn, prøve og Gem. Et
  navn, der er taget, får et tal på. »Gem det markerede som skabelon« virker uden AI. Formularen
  er »Byg selv«.
**Revurdér hvis:** brugerne savner en bestemt skabelon. Så er svaret en pakke, der kan slås til,
ikke flere indbyggede, der er slået til fra start.

### ADR-0029 — Renskriv i teksten, Mistral, AI-kommandoer uden bekræftelse (6/10-2026)
Efter 0.2.6.
**Beslutning:**
- **Renskriv retter i dokumentet** (`clean.rs`, `claudepanel.ts` `clean`). Teksten er ikke
  nødvendigvis et interview. Renskriften erstatter markeringen eller teksten frem til de skjulte
  blokke, og den gamle tekst lægges i fraklip i samme transaktion (`input.ai`), så ét Ctrl+Z
  fortryder. Er teksten ændret, mens svaret var undervejs, røres den ikke: renskriften lægges i
  fraklip. Uklare steder står som [?n] og forklares i en note til skribenten nederst. Afløser
  »ny fil ved siden af« fra 3/10; `create_sibling` er fjernet.
- **Mistral som fjerde udbyder** (`mistral.rs`), bygget som Gemini: brugerens nøgle i Windows
  Credential Manager (`credentials.rs`, nu fælles), `response_format: json_schema`, ingen
  websøgning. Faktatjek og research afvises med en forklaring.
- **AI-kommandoer med »/« køres med det samme.** Visningen af instruksen med Send og Annullér før
  første kørsel er fjernet. Samtykket til at sende til en udbyder spørges der stadig om én gang
  (`allowed`): det er det eneste, en ny bruger møder.
**Revurdér hvis:** Mistrals agent-API med websøgning bliver en del af den gratis plan.

### ADR-0030 — De seneste tekster som papirark i et vindue uden tekst (7/10-2026)
**Beslutning:** Når et vindue ikke har en tekst (Ctrl+N, eller den åbne fil er flyttet eller
slettet), viser fladen de op til otte seneste tekster som små ark (`ui/recentPapers.ts`). Hvert
ark er et frimærke af tekstens første side i tekstens egen skrift: overskriften og de første
afsnit, uden markdown-tegn, skjulte blokke, tabeller og kode. Arkene ligger lidt skævt som papir
på et bord og retter sig op under musen. Under arket står tid og mappe. `recent_documents`
(`session.rs`) læser kun stier fra `session.json`, altså tekster brugeren selv har åbnet, kun
.md, .markdown og .txt, højst 16 MB, og sender de første 1.200 tegn uden forfatterblok. En
OneDrive-fil, der ikke er hentet ned, læses ikke og får et tomt ark.
**Hvorfor:** knappen »Åbn en tekst« alene var en blindgyde. Springlisten viser de samme tekster,
men kun som navne og kun fra proceslinjen.
**Ikke valgt:** at vise arkene ved hver start i stedet for den sidste tekst. Princip 8 i
STRATEGI (programmet åbner der, hvor skribenten slap) gælder stadig.
**Revurdér hvis:** der skal flere end otte ark til, eller arkene skal kunne fastgøres.

### ADR-0031 — Word følger skabelonen og stilen fra programmet (7/10-2026)
**Beslutning:** Word-eksporten (`print/word.ts`) bruger den skabelon, der er valgt i
forhåndsvisningen, og de samme mål som `print.css`. Manuskript: skriften fra Indstillinger, 10,5
pt, linjeafstand mindst 1,75, 9 pt luft efter afsnit (eller indryk på 1,5 em med afsnit som i
bøger), titelblok med navn og anslag i gråt, manchet i gråt, citat i kursiv med mørk streg til
venstre, tætte listepunkter, tabeller med tynde grå streger, sidehoved med navn, titel og dato og
»2 / 5« nederst. Læseudgave: Georgia 11, indryk på afsnit efter afsnit og orddeling, men ikke i
titel og mellemrubrikker. Margenerne i Manuskript er nu 4,5 cm i siderne og 3,5 cm foroven, i
både Word og PDF (`MARGINS`). Afløser »Times New Roman 12, 1,5 linjer« fra ADR-0018.
**Skrifterne:** programmets skrifter følger med programmet, ikke med modtagerens Office. Word får
den nærmeste skrift, der findes i Office på både Windows og Mac: IBM Plex Mono → Consolas, IBM
Plex Sans og Avenir Next → Calibri, IBM Plex Serif og Newsreader → Georgia. Arial og Georgia er
sig selv.
**Ikke valgt:** at lægge skrifterne ind i .docx-filen. Det kræver TTF-udgaver ved siden af
woff2-filerne (to til tre MB mere i programmet), og Google Docs og ældre Word på Mac ser bort fra
dem alligevel.
**Revurdér hvis:** nogen klager over, at Word-filen ikke ligner skærmen, fordi skriften er skiftet.

### ADR-0032 — Kommandoer i Indstillinger (7/10-2026)
**Beslutning:** Fanen Kommandoer er flyttet fra højre spalte til Indstillinger som fjerde fane
(`SettingsPanel.addTab`, main.ts). Den samme flade (`CommandsPanel.el`) flyttes ind, hver gang
vinduet tegnes, så en halvskrevet beskrivelse eller en åben formular ikke går tabt. Fanen har samme
højde som de andre, og listen ruller inden i den. `gt-open-settings` kan nu åbne på en bestemt
fane (knappen Indstillinger i fanen Input åbner AI-hjælp). Højre spalte har Fraklip, Fodnoter,
Sprog og Input. Afløser placeringen i ADR-0028.
**Hvorfor:** at lave og slå kommandoer til og fra er opsætning, ikke noget man gør, mens man
skriver. I spalten fyldte fanen ved siden af Input, hvor kommandoernes svar står.

### ADR-0033 — Fire visninger af markdown (7/10-2026)
**Beslutning:** Kontakten »Skjul markdown-tegn« (6/10) er afløst af fire valg under Markdown i
Indstillinger › Tekst (`markMode` i `settings.rs`, `setMarkMode` i `livePreview.ts`): »Skjul
helt« (tegnene kommer aldrig frem), »Vis tegn ved markør« (standard, som før), »Vis tegn og
formatering« (tegnene står der altid, teksten er stadig formateret, tabeller vises som markdown)
og »Vis kun ren markdown« (live preview og tabelvisning slået fra, ingen grader, fed eller kursiv
fra syntaksfarverne). Filen er den samme i alle fire. En indstillingsfil fra før med
`hideMarks: true` læses som »Skjul helt«.
**Samme dag:** gennemstregning, fed og kursiv på en markering med mellemrum i kanten satte tegnene
uden om mellemrummet (`~~tekst ~~`), og så er det ikke markdown. `toggleWrap` lader nu mellemrum i
kanten stå uden for tegnene.

### ADR-0034 — Længdemål og noter med ud i Word (7/10-2026)
Fra sammenligningen med iA Writer, Ulysses, Scrivener, Word og Docs 7/10 (de to største mangler).
**Længdemål:** højst, mindst eller cirka et antal anslag, ord eller normalsider, med en frist
(`editor/goal.ts`). Målet står som én skjult linje i filen, `<!-- gt:maal type=hoejst antal=7400
enhed=anslag frist=2026-10-10 -->`, så det følger teksten (ADR-0003). Det skjules og beskyttes som
de andre skjulte blokke (`hidden.ts`, brugerhændelse `input.goal`) og fjernes af `withoutParked`,
så det hverken tæller eller kommer med i print, Word eller prompten. Hjørnet viser fremdriften
altid, med en tynd stribe og dage til fristen.
**Noter og rettelser i Word:** noter (`<!-- … -->`, `{>> … <<}`) bliver kommentarer, og forslag,
der ikke er taget stilling til (`{++…++}`, `{~~gammel~>ny~~}`), bliver sporede ændringer
(`print/word.ts` `encodeMarkup`). De kodes som tegn fra Unicodes private område (U+E000-E006),
før markdown-it læser teksten, og findes igen i løbene. Fluebenet »Noter og rettelser i Word« i
forhåndsvisningen er slået til, og det vises kun, når teksten har noter eller forslag. PDF og
print er rene som før. Afprøvet i Word 16: 2 kommentarer og 3 rettelser læses rigtigt.

### ADR-0035 — Dansk grammatik lokalt i stiltjekket (7/10-2026)
**Beslutning:** tre regler, der kører i stiltjekkets worker uden net (`editor/grammar.ts`):
navnemåde efter »at« og mådesudsagnsord, nutid efter jeg/du/han/hun/vi/man (ikke ved omvendt
ordstilling), og dobbelte småord. Udsagnsordene er ordklasselistens (UD Danish-DDT, ca. 300 par
med navnemåde og nutid). Fundene står under »Grammatik« i fanen Sprog med en blå bølget streg.
**Prøvet:** 1.774 artikler fra et fagblad (1,65 mio. ord) gav 71 fund. Hvert blev gennemgået, og de
falske blev fjernet med undtagelser, der nu står som test: navne (»Povl Gad er«), »ved« som
forholdsord, omvendt ordstilling efter ethvert udsagnsord, navneord efter »at« som bindeord
(»at lærer og pædagog«), betingelse efter »at« (»at søger man«), endelser efter punktum og
apostrof (»ph.d.en en«), gentagne forholdsord (»på på kort sigt«). Derefter 66 fund. På 114.726
ord i prøveteksterne: ét fund, og det var en rigtig fejl.
**Ikke valgt:** LanguageTool (Gode Ord bruger en intern server, men teksten må ikke forlade
brugerens pc), kommaregler (startkomma er valgfrit efter Dansk Sprognævn) og kongruens (listen
har ikke navneordenes køn).
**Revurdér hvis:** ordklasselisten får køn og bøjning, så kongruens (»et stor hus«) kan tjekkes.

### ADR-0036 — Kongruens og komma i grammatikken (7/10-2026)
**Beslutning:** grammatikken (ADR-0035) får kongruens og komma, stadig som regler uden net.
**Kongruens:** køn og former fra træbanken UD Danish-DDT (`scripts/kongruens.mjs` →
`assets/kongruens.json`: 4.094 navneord med sikkert køn, 132 tillægsord med t- og e-form, plus
regelmæssige endelser -ig/-lig/-bar/-som). Fire mønstre: »en hus« → »et hus« (kun når navneordet
står alene foran tegnsætning eller et småord), »et stor hus« → »stort«, »en stort bil« → »stor« og
»det stor hus« → »store« (efter den/det/de kun, hvor de står som artikel).
**Komma:** Indstillinger › Tekst › »Komma i stiltjekket«: Startkomma (standard, som Troels selv
skriver), Uden startkomma eller Fra. Begge systemer: komma efter en ledsætning først i sætningen.
Med startkomma: komma foran »at« efter siger/mener/tror …, når et grundled følger, og foran
hvis/når/fordi/selvom (ikke efter biord og faste udtryk som »især når«, »hvad hvis«, »det er
fordi«). Uden startkomma: kommaet foran »at« er unødvendigt.
**Prøvet:** samme korpus som ADR-0035 (1.774 artikler, 1,65 mio. ord). Kongruens: fra 1.091 fund
til 19, næsten alle rigtige, efter at træbankens homografer (»dansk«, »helt«, »ny«) og fejlagtige køn
(boykot, spand, tidsfordriv) er sorteret fra. Komma med startkomma: fra 923 til 173, flest rigtige
efter systemet. Hvert falsk mønster står nu som test.
**Revurdér hvis:** fanget for lidt. Næste skridt er en rigtig sætningsanalyse (UDPipe eller lignende
model for dansk), der koster 15-25 MB.

### ADR-0037 — Eget udtryk: halvmono, vermilion og aften (8/10-2026)
**Baggrund:** programmet var visuelt en iA-klon: lysegrå flade, blå markør og IBM Plex Mono, som iA's
egne skrifter er tegnet over. Fem researchspor 8/10 (`docs/research/2026-10-08-design/`, oplæg med
prøveflade). Valgt 8/10: bud B, vermilion og aften, og hele brugerfladen skal med.
**Beslutning:**
- **Skrift:** standard er **Recursive Halvmono**: Recursive (OFL, intet reserveret navn) med mono-aksen
  bagt fast på 0,5 og casual på 0 (fontTools-instans, beskåret til latin, 127 KB). 17 af 29 bogstaver
  står på fast bredde, m og w får plads, og fed flytter ikke linjen. Valg: **IBM Plex Mono** (IBM's
  variable filer uændret, navnet er reserveret), **Literata** (serif til lang skærmlæsning) og
  **Schibsted Grotesk** (husets sans). Plex Sans, Plex Serif og Avenir er ude. Gemte valg flyttes til
  nærmeste af samme slags (`settingspanel.ts` RENAMED); et gemt Plex Mono bliver Plex Mono.
- **Kursiv i halvmono** er hældningsaksen: en `oblique 0deg 15deg`-face, så Chromium selv sætter
  slnt og tegner de løbende former (prøvet i Edge 8/10).
- **Farver:** gråtoner med et svagt blåt stik (flade `#f5f6f7`, blæk `#1d2125`), så vermilion står som
  farve og ikke som rust på creme (Chaykas »AI-look«). **Én accent med én betydning:** vermilion
  `--accent` (`#db5230`, 3,7:1) betyder »her er du«: markøren, den aktive fane, den valgte række,
  fokusringen, slippemarkeringer og fremdriftsstregen. Kontakter, afkrydsning og skydere står i blæk.
  Markering af tekst er neutral grå. iA-blå er væk overalt.
- **Udseende:** Lys, Mørk, Aften og »Skifter selv« (`theme` i settings.json; et gammelt `dark: true`
  bliver Mørk). Aften er ravgult lys på næsten sort (`body.dark.aften`), bygget oven på mørk. »Skifter
  selv« går til aften ved solnedgang, tidligst kl. 18, og tilbage ved solopgang. Solen regnes lokalt
  (NOAA's tilnærmelse, bredde 56°, længde 10,5° i dansk tid, ellers tidszonens midte), ses efter hvert
  minut og toner over på 1,4 s (registrerede farvevariabler). Titellinjen følger (`set_titlebar(theme)`).
  Mørk og aften skriver i vægt 360, fordi lys tekst på mørk bund ser 16-24 procent federe ud.
- **Rammen:** Segoe UI Variable i tre snit (Small under 12 px, Text, Display). Ingen spærrede versaler.
  Forhåndsvisningens værktøjslinje uden `backdrop-filter`, som slog ClearType fra.
- **Markøren** blinker blødt (toner ud og ind på 260 ms) i stedet for at klikke af og på.
**Rettet samtidig:**
- **Linjebredden** var sat i `ch`, bredden af et nul, og passede kun i mono: 72 blev til 85-106 tegn i
  de proportionale skrifter. Nu måles den gennemsnitlige tegnbredde på dansk prosa i den valgte skrift
  (`ui/lineWidth.ts`), og bredden sættes i em.
- **Avenir** fandtes ikke på de fleste pc'er og faldt tilbage til Segoe UI. Valget er væk.
- **Læseudgaven:** Newsreader som variabel fil i 12 pt (før et statisk 16pt-snit i 11 pt, der med den
  lille x-højde svarede til ca. 9,5 pt Literata), optisk størrelse sat i punkter (12, rubrikker 24-48,
  noter 9) og proportionale tal i løbende tekst. Word bruger stadig Georgia 11 pt.
**Ikke valgt:** Commit Mono (tung, „ sidder højt, ikke opdateret siden 2023), Monaspace Argon (540 KB,
ligner GitHub), Iosevka Etoile som standard (for særpræget, jf. Beier og Larson 2013). AI-tekstens lilla
markering er uændret; oplægget foreslår en vermilion streg i margenen, men det er ikke besluttet.
**Revurdér hvis:** Recursive (uhintet) ser grødet ud ved 100 procents skalering på en almindelig skærm,
eller »Skifter selv« skifter på et forkert tidspunkt uden for Danmark.

### ADR-0038 — Status, #tags, søgning og »Undervejs« i biblioteket (8/10-2026)
**Baggrund:** biblioteket var en mappeliste uden overblik (research 7/10, plan
`docs/plans/2026-10-08-bibliotek.md`). Bygget i samme omgang som designet (ADR-0037).
**Beslutning:**
- **Status** står som én skjult linje øverst i filen: `<!-- gt:status vaerdi=igang -->`. Øverst, så Rust
  læser den i de første 4 KB, som uddraget allerede læser. Skjult i editoren og beskyttet som de andre
  skjulte blokke (`hidden.ts`), ude af tal, eksport og AI (`withoutParked`).
- **Statusserne** er Idé · Kladde · Til gennemsyn · Færdig (id'er `ide`, `igang`, `gennemsyn`,
  `faerdig`; »Kladde« hed »I gang« til 8/10, id'et blev) og kan omdøbes og udvides i Indstillinger ›
  Tags (`statuses` i settings.json). Filen gemmer id'et, så et nyt navn ikke mister teksterne. Den
  sidste betyder færdig. Farver: den første er en tom ring i `--dæmpet`, så `--status-a` til `-d`, og den
  sidste `--ok`. Egne tokens, fordi `--advarsel` og `--link` betyder noget andet og i aften næsten var
  ens (ΔE 13). `tokens.test.ts` kræver 3:1 og ΔE 30 mellem de faste. Vermilion bruges ikke (ADR-0037).
- **#tags** er tekstens sidste synlige linje, når den kun er hashtags (som i Ulysses). Linjen står i
  svag farve i editoren og tæller ikke med, kommer ikke med ud og sendes ikke til AI. Ingen tags-panel.
- **Frist** er længdemålets (ADR-0034). Ingen ny frist.
- **Rust** (`textmeta.rs`, `library.rs`): `Entry` får status, tags og frist (hoved 4 KB, hale 32 KB før
  forfatterblokken). `library_index` giver alle tekster i alle biblioteker med en cache i hukommelsen
  efter (størrelse, ændret), gemt i `<data>ibliotek-indeks.json`, så en ny start kun læser nye og
  ændrede filer. Halen læses i 8 KB (64 KB, hvis der kun står forfatterblok), otte tråde. Målt 8/10 på
  5.900 filer: 105 s første gang på en kold disk, 4 s med varm disk, derefter kun ændringerne. Indekset
  bygges i baggrunden 20 s efter start. `set_status` skriver linjen i en fil, der ikke er åben, gennem samme vej
  som gem: forfatterblokken læses, intervallerne flyttes med linjens længde, og blokken skrives med ny
  hash, så iA Writer stadig ser de samme forfattere. Er filen åben, skiftes statussen i editoren.
- **Fladen:** søgefelt og chips under bibliotekets titel: »Undervejs«, statusserne og de seks mest brugte
  #tags. Uden søgning og chip er det mapperne som før. Med søgning eller chip: én flad liste fra
  indekset med mappe og #tags under uddraget. »Undervejs« (ikke »I gang«, som er en status) er alt med
  en status, der ikke er den sidste, sorteret efter frist. Prikken foran navnet (i stedet for filikonet) vælger status ved klik.
**Ikke valgt:** status i YAML-forside (iA og Notesblok viser den som tekst), status i et indeks uden
for filen (forsvinder, når filen flyttes, ADR-0003), søgesyntaks, smarte mapper og kanban.
**Revurdér hvis:** indekset er for langsomt første gang i et stort bibliotek (så et indeks på disken),
eller tags på sidste linje driller i andre programmer.

### ADR-0039 — Noter på skrivebordet (8/10-2026)
**Baggrund:** Sticky Notes er hurtig og synlig, men noterne ligger i en skjult database og bliver aldrig
til en tekst. Research 8/10 (`docs/research/2026-10-08-noter/`, plan `docs/plans/2026-10-08-sedler.md`)
og et layoutoplæg med tre varianter. Valgt: variant A »Ark«, navnet »noter«, Win+Alt+N, mappen
`Dokumenter\Gode Tekster\Noter`, altid en ny note.
**Beslutning:**
- **En note er en .md-fil** i `Dokumenter\Gode Tekster\Noter`, navngivet efter tidspunktet
  (`2026-10-08 14.32.md`) og aldrig omdøbt af programmet. `Dokumenter\Gode Tekster` bliver bibliotek,
  hvis det ikke er det. En tom note efterlader ingen fil, når den lukkes.
- **Arket** er et rammeløst vindue (`note-1` …, siden `note.html`, `src/note.ts`) med samme editor og
  autosave som teksterne (`document.rs`): ingen ramme, en top at trække i (prikkerne er fjernet 8/10), knapper ved
  musen (ny note, farve, hold øverst, mere), Windows 11's runde hjørner og skygge, uden for
  proceslinjen og Alt+Tab (`WS_EX_TOOLWINDOW`). Dobbeltklik på toppen ruller arket op til første linje.
- **Farven** står som én skjult linje sidst i filen, `<!-- gt:farve vaerdi=gul -->`, og følger noten
  til den anden pc. Seks papirtoner (gul, grøn, blå, rosa, papir, grå) i lys og mørk. Aldrig vermilion.
- **Placering, størrelse, hold øverst, rullet op og fremme** gemmes kun på denne pc i
  `<data>\noter.json` (fysiske pixel). Arkene, der var fremme, kommer igen ved start. En position på en
  skærm, der ikke findes mere, giver et nyt sted øverst til højre.
- **Win+Alt+N** er registreret med Windows' `RegisterHotKey` i en tråd med egen beskedløkke, uden ny
  crate. Er genvejen taget, står det i loggen. Menuen ved uret har »Ny note«, »Vis alle noter« og
  »Skjul alle noter«.
- **En note er ikke »den sidste tekst«**: hovedvinduet åbner aldrig på en note (`session::remember`
  springes over for `note-*`).
- **»Noter« om CriticMarkup** hedder nu »kommentarer«, som i Word, hvor de havner.
**Hukommelse:** hvert ark er et WebView2-vindue, ca. 30 MB privat hukommelse (målt 8/10).
**Ikke valgt:** ét vindue med alle noter (ikke post-its), et gennemsigtigt vindue over hele skærmen
(klik igennem og flere skærme virker ikke), native vinduer uden WebView (editoren to gange), variant B
(fane) og C (kanten).
**Revurdér hvis:** mange ark fremme bruger for meget hukommelse (så lav prioritet ved fokustab, ADR
foreslået i spor 2), eller Win+Alt+N ofte er taget.

### ADR-0040 — Noterne bliver fremme, når skrivebordet vises (8/10-2026)
**Baggrund:** Win+D og hjørnet af proceslinjen løfter skrivebordet op over alle almindelige vinduer, så
arkene forsvandt med resten (8/10). Det er Windows' opførsel, og Microsoft tilbyder ingen
indstilling for det.
**Beslutning:** Rainmeters opskrift (`Library/System.cpp`, kun fremgangsmåden): `desktop.rs` laver et
skjult vindue, lægger det nederst og nægter andre at flytte det (`WM_WINDOWPOSCHANGING` med
`SWP_NOZORDER`; egne kald går uden om med `SWP_NOSENDCHANGING`). Fire gange i sekundet ses efter, om
det står under skrivebordets ikonvindue (fra Windows 11 24H2 Progman, før det en synlig WorkerW med
`SHELLDLL_DefView`). Gør det, er skrivebordet vist: arkene, der er fremme, gendannes og lægges øverst
(`HWND_TOPMOST`, uden at tage fokus). Går skrivebordet ned, lægges de løftede ark lige under det vindue,
brugeren gik til. Et ark, der holdes øverst, røres ikke. Skjulte ark (»Skjul alle noter«) bliver skjult.
Rettet efter den natlige test 9/10: »vist« kræver også, at forgrunden er skrivebordet, proceslinjen
eller et ark (som Rainmeters krog), for har skrivebordsvinduet mistet sin plads nederst, står det over
markøren hele tiden, og så blev arkene liggende øverst over alt. Og vindueskaldene er asynkrone
(`SWP_ASYNCWINDOWPOS`, `ShowWindowAsync`) uden lås imens, så tråden aldrig venter på hovedtråden.
**Ikke valgt:** at gøre arket til barn af skrivebordet (`SetParent` ind i WorkerW): arket kan så ikke
komme frem over andre vinduer, og en WebView2 i et fremmed vindue er usikker grund. En WinEvent-krog på
forgrundsvinduet alene: Win+D skifter ikke altid forgrundsvindue (set 8/10).
**Genstart:** arkene kommer igen, fordi programmet starter skjult med Windows og `notes::restore` åbner
dem. En nedlukning lukker programmet uden luk-hændelser (tao `WM_ENDSESSION` → `exit`), så »fremme«
bliver stående. Rettet samtidig: et gem af indstillingerne skrev `Start med Windows`-nøglen om hver
gang, også fra en testkopi i `target\release`, så den installerede ikke startede efter en genstart. Nu
kun, når valget ændres.
**Revurdér hvis:** en Windows-opdatering ændrer skrivebordets vinduer (Rainmeter følger med; se deres
`GetDesktopIconsHostWindow`), eller arkene blinker synligt ved Win+D.
