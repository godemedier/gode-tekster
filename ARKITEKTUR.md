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

Kortlagt 2/10-2026. Licensen er tjekket. GPL/AGPL-kode (Zettlr, Joplin) må kun bruges som inspiration.

| Hvad | Kilde | Bemærk |
|---|---|---|
| Live preview-mønstre | SilverBullet (MIT), Atomic Editor (MIT) | Kun mønstre. Atomics tabeleditor bruges ikke, fordi den omskriver filen |
| Forfatterskab i CM6 | `rflpazini/obsidian-authorship` (MIT) | Implementerer iA's format i CodeMirror 6 |

Sprogreglerne i `src/sprog/` er programmets egne (ADR-0066).

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
ville tage måneder, og tekstlogikken i TypeScript kunne ikke genbruges.
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
vises først som citat, når det er fundet i den hentede tekst (L-326).
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
**Delvist afløst af ADR-0054 (14/10):** synken får en server. Telemetri er stadig fravalgt.

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
- **Citater tjekkes af programmet selv:** Rust henter kildesiden og leder efter citatet
  (præcist, derefter uden hensyn til mellemrum, mindst 8 tegn). Findes det
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
**Status:** skrivefladens skrift og farver er afløst af ADR-0015 samme dag, stavekontrollen af
ADR-0063. Resten gælder.
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

### ADR-0016 — Datakilder via en fælles MCP-server (2/10-2026)
**Status:** afløst af ADR-0066 (22/10-2026). Aldrig bygget.
Idéen var at hente faktatjekkets kilder og sprogtjekket fra en MCP-server, som Gode Medier driver,
med én nøgle i Windows Credential Manager. Gode Tekster står i stedet alene: faktatjek og research
bruger kun modellens egne `WebSearch` og `WebFetch` (ADR-0022), og sprogreglerne ligger i programmet.

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
- **Stiltjek (F7)** med reglerne i `src/sprog/` (`clarity.ts`, `quotes.ts`, `aitells.ts`, ADR-0066).
  Analysen kører i en worker (`styleWorker.ts`): 200 sider tager 340 ms, som før frøs fladen ved hver pause.
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

**Opdateret 10/10:** Codex' værktøjer og lokale konfiguration afgrænses nu som beskrevet i
ADR-0043. Kaldet er fortsat ikke prøvet mod et rigtigt login.
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
**Ikke valgt:** LanguageTool (kræver en server, og teksten må ikke forlade
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
**Komma:** Indstillinger › Tekst › »Komma i stiltjekket«: Startkomma (standard, som skribenten selv
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

### ADR-0041 — Flueben i faktatjekket og segl på AI-svar i filen (9/10-2026)
Supplerer ADR-0022 og ADR-0023.
**Baggrund:** En påstand i faktatjekket kunne kun læses, ikke håndteres (9/10). Sikkerhedsaudit 9/10
fund 3: en `gt:claude`-blok er bare tekst, så en fremmed .md kunne vise »Korrekt« og »Citatet står på
dst.dk«, uden at noget var tjekket.
**Beslutning:** Variant A fra `docs/research/2026-10-09-faktatjek-haandtering.md` (Google, Word,
GitHub): hver åben påstand, der ikke er korrekt, har en cirkel til højre. Et klik krydser den af,
kortet folder sig sammen i gruppen »Håndteret« nederst, og fokus går til næste cirkel. »Rettet« eller
»Står« sætter programmet selv efter, om citatet stadig står i teksten. Står det ikke længere der, får
den åbne påstand linjen »Teksten er ændret her«, men lukkes ikke af sig selv. Håndteringen gemmes i
blokken som `handled` ved siden af `claims` (nøgle = påstandens plads), som en ændring i dokumentet
(Ctrl+Z virker, Fortryd i beskedlinjen). Et nyt faktatjek tager fluebenene med for påstande med samme
citat og samme dom.
Seglet: når et svar gemmes, laver Rust `blake3::keyed_hash` over modellens del (`claims` eller
`findings` som JSON) med en nøgle, der laves første gang og ligger i Windows' legitimationsadministrator
(`seal.rs`, `Gode Tekster/Segl`). Fladen ser kun seglet. Ved visning tjekkes det. Uden et gyldigt segl
står blokken som »Fra filen, ikke tjekket her«: alle påstande er »Ikke efterprøvet«, citaterne vises
ikke som fundet, og håndterede påstande står foldet ud. Fluebenene ligger uden for seglet, så
skribentens håndtering ikke gør det ugyldigt.
**Ikke valgt:** at køre citattjekket igen ved hver åbning (netkald uden at brugeren har bedt om det).
Tre udfald pr. påstand (variant B): et valg ekstra ved hvert flueben.
**Konsekvens:** faktatjek og research fra før 9/10 har intet segl og vises som ikke tjekket her, også
på den pc, de blev lavet på. Et nyt faktatjek løser det. Skifter brugeren pc, gælder det samme.
**Revurdér hvis:** brugeren deler tekster med faktatjek mellem egne pc'er og vil have dem stolet på.
Så skal nøglen kunne flyttes med.

### ADR-0042 — Side-designeren i forhåndsvisningen (9/10-2026)
Supplerer ADR-0011.
**Baggrund:** Sidehoved og sidefod lå fast (forfatter og dato øverst, tal og sidetal nederst), og
brugeren ville selv kunne lægge dem (9/10, skitsen i samtalen).
**Beslutning:** Knappen »Design« i Ctrl+P viser siden med seks faste pladser i margenen (øverst og
nederst, til venstre, i midten og til højre, som `@page`-margenboksene) og titlen. Brikkerne
Forfatter, Dato, Titel, Sidetal, Antal tegn og ord og Egen tekst trækkes med pointer events til en
plads, mellem pladser og ud igen. Med tastaturet løfter Enter en brik, og piletasterne vælger plads.
Margener, skrift og »Første side anderledes« står i samme panel. Den rene logik bor i
`src/print/layout.ts` (testet), fladen i `designer.ts`, der først hentes, når den bruges. Én opsætning
giver både `@page`-CSS, PDF-margener (minus UDFALD) og Words sidehoved og sidefod med tabulatorstop.
»Gem som skabelon …« lægger opsætningen i skabelonvalget (localStorage `gt-sidedesign-1`, tjekket felt
for felt ved indlæsning). Uden egen skabelon er resultatet det samme som før.
**Ikke valgt:** frit placerede tekstbokse overalt på siden: Chromium kan kun lægge sidehoved og sidefod
i margenboksene, og Word kun i sidehoved og sidefod.
**Revurdér hvis:** skabeloner skal følge med til en anden pc (så hører de til i settings.json), eller
der kommer brug for logo eller billede i sidehovedet.

### ADR-0043 — Holdbar afslutning og afgrænset teksttolkning (10/10-2026)
Supplerer ADR-0013, ADR-0009 og ADR-0027.
**Baggrund:** Gennemgangen fandt gemfejl, der stadig kunne lukke et vindue, samtidige filskift og
fletninger, samt markeringer inde i kode, der blev tolket og fjernet ved eksport. Historikkens
løbende ti minutters vindue kunne også opsluge en hel dags skrivning.
**Beslutning:** Hver åben tekst har en vinduesejer i Rust. Gem og opdatering af filens kendte
stempel sker under samme lås. Hashen kontrolleres før hvert gem, også ved samme størrelse og
tidsstempel. Filer med beskadiget UTF-8- eller UTF-16-BOM afvises frem for at blive omskrevet.
Filskift køes i fladen; igangværende fletning afsluttes før lukning og beregnes igen, hvis teksten
ændres under kaldet. Afslutningen venter på gem eller en atomisk nødkopi af de seneste rettelser.
Ingen tidsgrænse må tvinge processen væk. Under lukning tager fladen ikke imod nye tastetryk;
fejl afbryder afslutningen. Sessionens metadata gemmes atomisk, også under brug.
Historikgrupper må højst vare ti minutter fra gruppens første skrivning og opdateres i en
SQLite-transaktion. Kode og afsluttede kommentarer afgrænses af fælles skannere i
`src/editor/textSyntax.ts`. Halve markeringer må ikke opsluge den næste færdige markering, og
kodeeksempler bevares ved optælling og eksport. Noter inde i rettelsesforslag behandles i
forslagets felter, så udskiftninger ikke overlapper.
Codex får en særskilt tom arbejdsmappe pr. kald. Brugerens config ignoreres; shell_tool og
unified_exec slås fra, sandkassen er skrivebeskyttet, og web_search vælges eksplicit pr. opgave.
Stderr tømmes løbende, så en fuld pipe ikke kan låse processen. Et ukendt flag er en fejl,
ikke anledning til at gentage kaldet med færre begrænsninger.
**Konsekvens:** Lukning kan blive afbrudt ved diskfejl. Det er nødvendigt for at bevare rettelserne.
Codex kræver en CLI, der understøtter disse flag; et rigtigt login er endnu ikke afprøvet.
**Revurdér hvis:** flere brugere eller maskiner skal redigere samme tekst samtidig.

### ADR-0044 — Vedvarende søgeindeks med bogstavelig delordssøgning (10/10-2026)
Supplerer ADR-0038.
**Baggrund:** En søgning læste alle kildetekster, også efter genstart. Tidligere målinger viste
op til 25 sekunder på en kold disk. Et ordindeks alene ville miste søgning efter dele af ord.
**Beslutning:** SQLite FTS5 med trigrammer i `search.sqlite` under programmets lokale data.
Den eksisterende rusqlite-afhængighed bruges. Normaliseret tekst gemmes uden iA-forfatterblok;
samme tegnkodning som ved åbning understøttes. Trigrammer vælger kandidater, og den eksisterende
bogstavelige søgning beregner uddrag og UTF-16-positioner. To tegn søges i indeksets tekst.
Brugerens søgeord citeres som ét FTS-udtryk, så OR, stjerner og citationstegn er data.
Indekset synkroniseres i en transaktion. Kun ændret størrelse, mtime med nanosekunder eller
en filhændelse giver genlæsning. En filændring under læsning kasserer posten til næste søgning.
Store, beskadigede og utilgængelige filer giver ingen gamle fund. Slettede filer og fjernede
biblioteker fjernes. Fillistens cache er knyttet til den aktuelle biblioteksliste.
Opstarten varmer indekset i baggrunden efter tre sekunder. Søgefejl falder tilbage til den
direkte søgning. Indekset er afledte data og kan genopbygges. Kildetekster ændres aldrig.
Fund står stabilt efter sti, højst 300 og højst 20 pr. fil. Der læses højst 2 MB pr. kildefil.
**Konsekvens:** Første indeksering læser stadig bibliotekerne; senere genstarter genbruger
teksterne. Indekset indeholder lokale tekstkopier, ligesom historikken, og forlader ikke pc'en.
Usete nye filer i mapper, som ikke overvåges, findes ved fillistens næste gennemgang, højst
30 sekunder senere. Eksisterende filers metadata kontrolleres ved hver søgning.
**Alternativ:** et almindeligt ordindeks ændrer søgeoplevelsen; et separat søgeprogram giver
en ny afhængighed og løser ikke genbrug efter genstart.
**Revurdér hvis:** bibliotekerne vokser væsentligt ud over nogle tusinde filer.

### ADR-0045 — Lydgenkendelse følger den valgte AI-forbindelse (10/10-2026)
**Baggrund:** Filtransskription skal bruge brugerens eksisterende AI-adgang. De
installerede tekstkommandoer har ikke samme lydmuligheder. Gemini har en dokumenteret
filindgang, mens Claude Codes dokumenterede diktering kræver interaktiv mikrofonbrug.
**Beslutning:** Lydimport skal bruge samme udbydervalg som teksthjælpen. Ingen automatisk
overgang til en anden udbyder, en separat betalings-API eller lokal lydmodel.
Udbyderens lydmodel kan være en anden end tekstmodellen. Gemini-adapteren bruger
`gemini-3.5-transcribe` gennem eksisterende Credential Manager-nøgle og HTTPS-klient.
WAV sendes inline til Interactions API, med `store: false`, ordret transskription og
ordtidskoder. Ingen værktøjer eller promptinstruktioner til lydmodellen.
Native adapter validerer tidsgrænser og ordannotationernes dækning og rækkefølge i
teksten. Fejlsvar og nøgler sendes ikke til fladen. Et dokumenteret/afprøvet tomt svar
for stilhed skelnes fra ukendt svarformat. Der er ingen automatisk modelretry.
Første interne grænse er 60 sekunder og 12 MiB pr. lydblok, højst 2 MiB modelsvar.
**Status:** Native Gemini-adapter og syntetisk live-prøve er implementeret. Der er endnu
ingen registreret lydkommando, import-UI, sammenstilling af lange filer eller afspiller.
Valget af udbyder skal håndhæves i den kommende importkommando før hvert lydkald.
**Konsekvens:** En valgt forbindelse uden filstøtte giver en forklaring. Brugeren må
selv vælge en anden forbindelse. En ekstra modelvælger vises kun for afprøvede modeller.
**Revurdér hvis:** Claude eller en anden eksisterende forbindelse får en dokumenteret
filindgang med brugerens login, eller lange prøver viser behov for andre blokgrænser.

### ADR-0046 — Struktur er metadata omkring manuskriptet (11/10-2026)
**Beslutning:** Strukturkort omslutter den eksisterende tekst med `gt:del`/`gt:slut`.
Titel, rolle og arbejdsnote ligger i JSON-kommentaren. `gt:struktur` gemmer metodevalget.
Der er ingen separat projektfil eller kopi af brødteksten. Manuel gruppering følger hele
Markdown-blokke. Tomme dele kan bruges til planlægning. Flytning flytter teksten med dens
forfattermarkeringer og kan fortrydes. Ugrupperet tekst flyttes aldrig med uden et valg.
Fortællemetoderne ligger i ét fælles JSON-katalog, grupperet efter anvendelse.
AI ser brødtekst og deltitler, men ikke arbejdsnoter, fraklip eller andre skjulte kommentarer.
Rust validerer metode, del-id'er og roller. Svar må kun indeholde metodebegrundelse og
rolle/arbejdsnote for eksisterende dele eller lokalt udpegede blokke. Ingen genereret brødtekst.
Brugeren skal godtage forslaget. Er manuskriptet ændret siden kaldet, kan det ikke indføres.
**Konsekvens:** Struktur følger med ved kopiering og genåbning af Markdown-filen. Eksport,
ordtal og AI-tekstgrundlag udelader metadata. Versionsvisning tillader ikke strukturændringer.

### ADR-0047 — Lydjob, delresultater og afspilning (11/10-2026)
Supplerer ADR-0045. **Beslutning:** Filvalg og afkodning foregår i Rust. FFmpeg og ffprobe
8.1.2 fra den afprøvede Gyan-distribution verificeres med SHA-256. De store programmer
bundles ikke. Brugeren kan udpege mappen; en understøttet lokal installation findes automatisk.
Højst 8 GiB/6 timer. Afkodning er mono 16 kHz PCM i en privat jobmappe med filprotokol alene,
tidsgrænse og Stop. Ingen shell. Kun jobbets eget vindue må styre det.
Gemini modtager 54-sekunders kerner med et sekunds overlap. Ord uden for kernens tidsrum
udelades. Tidskoder beregnes fra samples. Ved HTTP 429 ventes op til to gange med samme
forbindelse og model. Ingen fallback. Stop afbryder ventetid, men et igangværende HTTP-kald
kan tage op til et minut. Færdige dele kan gemmes eller fortsættes i samme session.
Der gemmes en lokal Markdown-nødkopi efter hver færdig del. Genstart bevarer nødkopien,
men fjerner den store afkodede lydfil. En gendannet nødkopi kan gemmes via Gem som.
En ny transskription oprettes atomisk ved originalen med et ledigt navn. Originalen ændres
aldrig. `gt:lyd` gemmer kildefilnavn, varighed, model og fuldførelsesstatus. Tidslinks åbner
kun lydfilen ved den åbne tekst. Afspilleren bruger asset-protokollen under uændret script-CSP.
**Begrænsninger:** Native filtransskription er implementeret for Gemini-nøglen. Andre valg
giver en synlig forklaring. ChatGPT-abonnementets korte WebRTC-prøve er ikke en produktadapter.
Taler-id'er er lokale for hver lydblok og foregiver ikke at være identiteter gennem hele filen.
Lydkvalitet og hastighed afhænger af optagelse, udbyder og kvote. GoodTape er reference,
ikke en påstand om samme kvalitet eller funktioner.

### ADR-0048 — Gem transskriptionen, selv om lydkilden er utilgængelig (11/10-2026)
Supplerer ADR-0047. **Beslutning:** Fejler gemning ved lydfilen, kan brugeren vælge
en anden destination i Rusts Gem-dialog. Kun en ny fil må oprettes, atomisk og uden
overskrivning. Denne redningsvej kræver ikke, at lydkilden stadig findes. Nødkopien
fjernes først efter vellykket skrivning. Fladen husker den gemte sti, så et afvist
filskift kan prøves igen uden at oprette en dublet.
**Begrundelse:** En flyttet lydfil eller skrivebeskyttet kildemappe må ikke blokere
gemning af færdige delresultater. Tidslinks kræver fortsat lyden ved teksten.

### ADR-0049 — Kilder og henvisninger i selve filen (12/10-2026)
Afløser oplæggets `referencer.json` ved siden af hovedfilen (docs/research/2026-10-10-storyboard-og-referencer.md).
**Beslutning:** Kildelisten står som CSL-JSON, én kilde pr. linje, i én skjult blok
`<!-- gt:kilder … -->` sidst i filen, som fraklip og struktur. Feltnavnene er CSL's egne
(`author`, `issued`, `container-title` …), så en eksport fra Zotero kan sættes ind uden
oversættelse. `--`, `<` og `>` skrives som `\u`-escapes, så en titel ikke kan lukke kommentaren.
En blok, der ikke kan læses, røres ikke. Henvisninger bruger Pandocs syntaks: `[@nøgle]`,
`[@nøgle, s. 42]`, `[jf. @a; @b]`, `[-@nøgle]`. @ efter et bogstav er en mailadresse.
Formateringen er APA 7 forfatter-år, skrevet i `references.ts` uden CSL-processor.
Live preview viser henvisningen formateret, til markøren står i den. En ukendt nøgle får en
bølget understregning. Print og Word sætter henvisningerne og lægger en litteraturliste med
de brugte kilder sidst, med hængende indrykning på 1,27 cm. Fanen Kilder viser listen,
indsætter henvisninger, finder brugen i teksten og har en formular med DOI-opslag. Opslaget
går gennem Rust (`references.rs`) til doi.org med CSL-JSON som svarformat, kun https, og
kun kendte felter med rigtig type kommer igennem. Svaret er et forslag, til brugeren gemmer.
**Ikke valgt nu:** citeproc-js og CSL-stilfiler (stor afhængighed for én stil), Zotero-felter
i Word, autofuldførelse ved `[@` (»/«-menuen ejer CodeMirrors autofuldførelse).
**Revurdér hvis:** der skal flere stile end APA, eller en institution kræver en bestemt CSL-fil.

### ADR-0050 — Notelisten (12/10-2026)
Supplerer ADR-0039. **Beslutning:** Et almindeligt vindue (`noteliste`, `noteliste.html`)
viser alle noter i Noter-mappen, også de lukkede, nyeste først, med søgning i hele teksten.
Dobbeltklik eller Enter åbner noten på den plads, den sidst havde på denne pc (`noter.json`).
Ctrl+H og »Noteliste« i arkets menu, menuen ved uret og springlisten åbner vinduet. Sletning
lægger noten i Windows' papirkurv efter bekræftelse. Listen viser noterne i papirkurven, der kom
fra Noter-mappen, og kan hente dem tilbage (`trash::os_limited`). Kommandoerne bruger kun
filnavnet og slår det op i Noter-mappen, så listen kan ikke åbne eller slette andet.
**Konsekvens:** Lukker man alle ark, er noterne stadig to klik væk, også uden at kende
Win+Alt+N. Sticky Notes' synkronisering med Outlook findes ikke: noterne er filer, og OneDrive
synker dem, hvis Dokumenter ligger der.

### ADR-0051 — Stiltjekket viser som standard kun målte, sikre regler (12/10-2026)
**Baggrund:** Målebænken (`scripts/stiltjek-maal.mjs`) kørte stiltjekket på 1.774 redigerede
fagbladsartikler og DaLA (CC BY 4.0). En redaktør vurderede faste stikprøver på 20 pr. regel.
Før rettelserne gav stiltjekket 34,8 fund pr. 1.000 ord, og de fleste regler ramte rigtigt i
5-30 % af tilfældene. Forskningen (docs/research/2026-10-12-stiltjek-forskning.md) viser, at
skribenter retter efter falske fund, og at redigeret dansk har 0,2-0,5 % fejl.
**Beslutning:** En regel vises kun som standard, når mindst 70 % af dens fund var nyttige.
Listen er en tilladelsesliste i `styleRules.ts` (`isStandard`): grammatikken, semikolon,
tusindtal og husets mekaniske regler. Floskel og vag kilde er også med: de fik 65 % (13 af 20),
men kun 2-3 af 20 var forkerte, og resten var tvivl. Med 20 stikprøver skiller ét fund ikke. Alt andet vises med indstillingen »Alle forslag«
(`strictStyle`). En ny regel er uden for listen, til den er målt. Målebænken måler altid alle
regler, og vurderingerne genbruges på stikprøvens id, så kun nye fund skal vurderes.
**Rettet samtidig:** citater med ”…” og replikker med tankestreg springes over, ASCII-`\b` i
stiltjekket, kombinerende tegn og blød bindestreg i grammatikken, »når« som udsagnsord og
to bindeord i træk i kommatjekket, decimaltal i tusindtalsreglen, gentagelse kun tæt på
hinanden og ikke for navne, samt ord og forslag, der oftere var forkerte end rigtige.
**Revurdér:** når en regel er omskrevet (fx passiv som tæthed for hele teksten, kløvning i stedet
for svagt anslag), måles den igen og kan komme på listen.
**Tilføjet 13/10 (fase 1):** passiv og navneordsstil er ikke længere fund i teksten. Fanen Sprog
viser dem som andel af sætningerne (`density` fra `analyze`). Hvert fund har »Ikke nyttigt« i
højreklikmenuen: samme regel og samme ord forsvinder, så længe programmet kører, og reglen tælles op
i `styleNotUseful` i settings.json. Tallet forlader aldrig pc'en, men kan bruges ved næste måling.
Hver kategori slås fra med et klik på navnet i fanen Sprog (`hiddenStyle`).

### ADR-0052 — Et forvarmet ark til næste note (13/10-2026)
Supplerer ADR-0039. **Baggrund:** En ny note tog 0,7-1,0 s i release (én måling 3,4 s) og
7-14 s, når flere ark startede samtidig med hovedvinduet. Tiden går med at starte WebView2 og
indlæse editoren, ikke med filen.
**Beslutning:** Programmet holder ét skjult ark klar (`notes.rs`, `SpareSlot`): editoren er
indlæst, men arket har ingen fil. Det er hverken i `labels`, `hwnds` eller `noter.json`, så det
ikke findes i notelisten, i Win+D, i »Vis alle noter« eller ved næste start, og der ligger ingen
tom fil på disken. Fladen spørger med `note_spare`, om den skal vente, og venter så på
»note-claim«. En ny note (Win+Alt+N, Ctrl+N, en note uden plads på denne pc) tager arket, når
fladen har meldt klar, og ellers laves et ark som før. En note med en gemt størrelse bruger det
ikke: størrelsen skal gives ved oprettelsen (set_size på et skjult rammeløst ark lægger
titellinjen oveni). Svarer arket ikke inden for 4 s, lukkes det, og noten får et nyt ark.
Afslut lukker arket, før vinduerne bliver spurgt, for det har intet at gemme.
**Lav prioritet:** Det næste ark varmes op 3 s efter, at en ny note er vist. Ved start først efter
20 s, og kun når noterne er i brug på denne pc (`noter.json` er ikke tom). Begge venter, til
intet andet ark er ved at komme frem. Testscenarierne (`GT_SCENARIE`) får ingen ark, fordi de
regner med »note-1«, »note-2« i rækkefølge.
**Konsekvens:** Cirka 30 MB hukommelse, så længe programmet kører og noterne er i brug. Den
første note efter start kan stadig være kold, hvis den kommer inden for de første 20 s.

### ADR-0053 — Android: samme kerne, desktopdele bag `cfg(desktop)` (14/10-2026)
Afløser fravalget »Kun Windows« for telefonens del (STRATEGI, ikke-mål). Plan:
`docs/plans/2026-10-10-mobil-hele-appen.md`. Prøvet på en Pixel 9a (Android 16).
**Beslutning:** Samme crate og samme flade bygges til `aarch64-linux-android` med Tauri 2
(`src-tauri/gen/android`). Det, kun pc'en har, er gated: ikonet ved uret, single-instance,
Win+Alt+N, noter i egne vinduer, autostart, springliste og opdatering (`desktop_setup` i
`lib.rs`, `#[cfg(desktop)]`). Kommandoerne findes stadig på telefonen og svarer med en dansk
fejl, så fladen ikke går i stykker. PDF, mappevælger og noteark giver fejl. Papirkurven er
`.papirkurv` ved siden af filen (`files::to_trash`). TLS er rustls med indbyggede rødder på
telefonen og Windows' egen på pc'en (`net.rs`). Dokumenter er på telefonen
`app_data_dir/Dokumenter` (`settings::documents_dir`), ikke Androids fælles lager: det er
langsomt til mange filer og tillader ikke den hårde link, et nyt gem bruger. Teksten gemmes
også ved `visibilitychange`, fordi Android lukker processen uden `RunEvent::Exit`.
`MainActivity.kt` polstrer for statuslinje og tastatur (edge-to-edge håndhæves fra Android 15).
Releasebyg signeres med `.updater/android-gode-tekster.jks` (gitignoreret, med i den natlige
backup). Uden den nøgle kan en ny udgave ikke lægges oven på den gamle.
**Alternativ der tabte:** en separat mobilcrate. To kopier af fil- og gemmelogikken, der kan
glide fra hinanden.
**Konsekvens:** Gaten kører clippy mod Windows. En Android-regression fanges først af
`cargo check --target aarch64-linux-android`. Fladen er stadig pc'ens. En egentlig mobilflade
er næste skridt. Uden Windows' Udviklertilstand kan `tauri android build` ikke lave sit symlink.
Så bygges Rust i hånden, `.so` kopieres til `jniLibs`, og Gradle køres uden rust-opgaven.
**Revurdér først hvis:** telefonens skriveoplevelse i WebView ikke kan bringes i orden
(plan: native editor som reference).

### ADR-0054 — Egen synk af Dokumenter via husets server (14/10-2026)
Afløser ADR-0006 for synkens del. Oplæg og research:
`docs/plans/2026-10-14-egen-synk-og-dokumenter.md`. Brugeren sagde ja til alle fem beslutninger 14/10.
**Beslutning:**
- **Skillelinjen:** Dokumenter er skribentens egne tekster. Arbejdsmapper, hvor agenter skriver,
  synkes ikke.
- **Omfang:** hele `Documents`, men kun `.md` og `.txt` plus billeder i `medier`-mapper. Loft
  20 MB pr. fil. Junctions følges aldrig (Windows lægger `Billeder`, `Musik` og `Videoer` i
  Dokumenter som junctions til profilens mapper).
- **Server:** `synk.godemedier.dk`, egen Coolify-app ved siden af `tekster.godemedier.dk`, som
  beholder sin profil (»intet gemmes«). SQLite plus blobs navngivet efter blake3. Al skrivning er
  compare-and-swap mod en kendt revision. Serveren fletter aldrig. Gravsten i mindst 180 dage.
  Backup hver nat.
- **Konflikter:** trevejsfletning, når ændringerne rører hvert sit afsnit (stille, med fortryd i
  synkloggen). Samme afsnit: serverens version i filen, den lokale som
  `Navn (konflikt fra <enhed> <dato tid>).md`, og et banner med sammenligning.
- **Sikkerhed:** én nøgle pr. enhed (kun hashen på serveren), i Credential Manager på pc'en og
  i appens egen database på telefonen (privat for appen). Ingen ende-til-ende-kryptering i første version: browseren og søgningen kræver, at
  serveren kan læse teksten.
**Alternativer der tabte:** OneDrive eller iCloud (to synkmotorer på samme filer, ingen fletning
i vores hænder), Syncthing (kun konfliktkopier, Android-appen lukket 12/2024), CRDT som Yjs eller
Automerge (virker kun, når al redigering går gennem den, og iA Writer og Claude skriver i filerne).
**Konsekvens:** Rækkefølgen er server og pc-motor med simulationstest, før telefonen kobles på,
og browseren til sidst. Bliver synken nogensinde åben for andre, gælder styringspakken.

### ADR-0055 — Telefonen får sin egen enkle flade uden markdown-tegn (14/10-2026)
Supplerer ADR-0053. Research: `docs/research/2026-10-14-mobil-skriveapps.md`.
**Baggrund:** Pc'ens flade på telefonen var alt for meget skrivebord: sidepaneler, seks faner,
genvejstaster og synlige markdown-tegn. Brugerens krav: enklere, og markdown-tegn vises aldrig.
**Beslutning:** Android åbner `mobile.html` (`src-tauri/tauri.android.conf.json`), ikke
`index.html`. To skærme: **Tekster** (søgefelt, liste med titel, første linje og dato, knappen +)
og **Skriv** (teksten i fuld bredde, tilbage, titel, »Gemt« og ⋮). Over tastaturet står én række:
Aa (brødtekst, overskrift, underoverskrift, citat), fed, kursiv, punktliste, fortryd, gentag og
luk tastaturet. Alt andet ligger i ⋮-menuen som et ark fra bunden. Systemets tilbage går fra
Skriv til listen (historikken i WebView'en). Editoren kører med visningen »skjul« (ADR-0033):
tegnene vises heller ikke ved markøren, i modsætning til Bear og Obsidian. Forfatterskab og
stiltjek vises ikke. Trykflader er mindst 48 px. Filen er den samme markdown som på pc'en.
**Ikke på telefonen i første omgang:** højre spalte (fraklip, fodnoter, kilder, struktur, sprog,
input), AI, versioner, print, eksport, noter i egne vinduer.
**Tilføjet 17/10:** fodnoter vises som hævet tal, og et tryk åbner noten i et ark, hvor den kan
rettes. I visningen »skjul« er de skjulte tegn atomiske (`hiddenMarkAtoms`): markøren står aldrig
inde i dem, og Backspace/Delete sletter det synlige tegn ved siden af. Skriften er sans (Schibsted
Grotesk), ikke pc'ens halvmono. En ny tekst, der stadig er tom ved Tilbage, slettes.
**Alternativ der tabte:** iA Writers model, hvor markdown vises på alle platforme. Brugeren vil
ikke se tegnene. Bear og Obsidian viser dem ved markøren, hvilket giver linjehop.
**Revurdér først hvis:** Gboard-komposition ved skjulte tegn giver tabte eller dobbelte bogstaver.
Så er en native editor næste skridt (ADR-0053).

### ADR-0056 — Start med Windows tilbage til Run-nøglen (15/10-2026)
Afløser 11/10-ændringen af ADR-0014 (logon-opgave i Opgavestyring).
**Baggrund:** Lige efter opdateringen til 0.2.14 fjernede Microsoft Defender programmet,
genvejen og opgaven (`Behavior:Win32/Persistence.A!ml`). En usigneret exe, der opretter en
planlagt opgave med `schtasks`, ligner skadelig software, der vil sikre sig en plads ved login.
Run-nøglen under `HKCU` har Defender accepteret siden 3/10.
**Beslutning:** `HKCU\...\Run` med `"<exe>" --skjult`, som før 11/10. Nøglen skrives kun, når
den mangler eller peger forkert, og samme gang fjernes en gammel logon-opgave med
`schtasks /Delete`. Ellers rører programmet intet ved start.
**Pris:** Windows kan udskyde Run-nøglen op til et minut efter login, så det første notesark
efter en genstart kan være langsommere.
**Revurdér først hvis:** programmet bliver kodesigneret. Så kan logon-opgaven prøves igen.

### ADR-0057 — Kodesignering gennem SignPath Foundation, bygget på GitHub (16/10-2026)
**Baggrund:** Defender fjernede den usignerede 0.2.14 (ADR-0056), og Smart App-kontrol advarer
ved første start. Brugeren vil ikke betale for et certifikat.
**Beslutning:** SignPath Foundations gratis signering til open source. Programmet forbliver gratis
og under GPL-3.0 uden betalt licens ved siden af (betingelse). Windows-udgaven bygges af
`.github/workflows/windows.yml` på GitHub fra det offentlige repo: exe'en signeres, installeren
pakkes om den signerede exe med `tauri bundle`, og installeren signeres. Hver signering godkendes
i hånden i SignPath. Certifikatet står i SignPath Foundations navn. Opdateringens minisign-
signatur laves stadig lokalt af `udgiv.mjs`. Installeren viser licens og privatliv
(`src-tauri/nsis/installer-info.txt`), og README har afsnittet »Code signing policy«.
**Alternativ der tabte:** Microsoft Store (gratis for enkeltpersoner, Store signerer). Kræver
MSIX og Store-opdateringer, og installeren fra hjemmesiden ville stadig være usigneret.
**Revurdér hvis:** programmet skal koste penge. Så gælder SignPaths gratis ordning ikke.
**Tilføjet 16/10, samme dag:** SignPath afviste ansøgningen, fordi projektet endnu ikke har
»social proof«. Afsnittet »Code signing policy« er taget ud af README og af godemedier.dk.
Workflowet bliver, men bygger usigneret. Alternativerne står i
`docs/research/2026-10-16-kodesignering-uden-signpath.md`. **Besluttet samme dag:** der
betales ikke for signering. Programmet udgives usigneret, og downloadsiden forklarer advarslen.
Slår Defender til igen, indsendes filen til Microsoft som falsk alarm (gratis). SignPath kan søges
igen, når programmet har brugere og omtale.

### ADR-0058 — Papirkurv på synkserveren i 30 dage (16/10-2026)
Supplerer ADR-0054.
**Baggrund:** En sletning på én enhed slettede på alle. Telefonens `.papirkurv` og Windows'
papirkurv dækker kun den enhed, hvor man slettede. Serveren gemte alle revisioner og alt indhold
for altid, uden nogen vej tilbage i programmet.
**Beslutning:** `GET /v1/papirkurv` viser filer slettet inden for 30 dage med indholdet fra før
sletningen (`Store::trash`). »Hent tilbage« under Synkronisering er en almindelig commit af den
gamle hash oven på gravstenen, så alle enheder henter filen igen ad den vej, de henter alt andet.
Serveren tømmer papirkurven ved start og én gang i døgnet (`Store::purge`): indhold, som kun filer
slettet for mere end 30 dage siden brugte, fjernes sammen med deres revisioner. Gravstenene bliver.
Indhold, som en levende fil eller en ældre udgave af den bruger, bliver. Commit tjekker indholdet
igen under lagerets lås, så oprydningen aldrig efterlader en fil uden indhold.
**Alternativ der tabte:** at beholde alt for altid. Slettet skal til sidst være slettet, og
restic-backuppen dækker længere tilbage (12 måneder).
**Konsekvens:** ældre udgaver af levende filer ryddes ikke. En versionshistorik pr. tekst er en
mulig næste ting, og pladsen skal holdes øje med.

### ADR-0059 — Stiltjek fase 2-3: retskrivning, kommakonsistens, papirord og sætningsbygning (16/10-2026)
Supplerer ADR-0051. **Baggrund:** Korrekthed var stiltjekkets svage side (plan
`docs/research/2026-10-12-stiltjek-plan.md`). COR og DSL's lister venter på svar på brevene.
**Beslutning:** Fire nye moduler i `src/editor/`, alle uden net og uden nye afhængigheder:
`retskrivning.ts` (»ro:«: faste udtryk i to ord, forvekslinger, forkortelser, tal med bindestreg og
apostrof, komma efter »Men«), `papirord.ts` (papirord i to lag og »omkring« for »om«),
`saetning.ts` (kløvning med et navn, indskud fra 15 ord) og kommakonsistens i `grammar.ts`: skriver
teksten tydeligt i det andet kommasystem end det valgte (mindst tre steder, tre gange så mange),
gælder tekstens system, og kun afvigelserne markeres (»ro:komma-konsistens«). Ordparrene er skrevet
med egne ord. LanguageTools danske regler (LGPL) er brugt som liste over fejltyper, ikke som tekst.
**Målt** på 1.774 fagbladsartikler, 20 stikprøver pr. regel, vurderet af tre agenter som redaktør
og til sidst 23 af Claude selv: ro:to-ord, ro:forkortelse, ro:tal 100 %, ro:forveksling 3 af 3,
papirord 95 %, »omkring« 88 %. De står nu på standardlisten. papirord-2 (45 %), indskud (75 %, 16
fund) og kløvning (90 %, 10 fund) vises kun med »Alle forslag«: de to sidste er justeret på de
samme stikprøver, de er målt på, så tallet er for pænt. Forvægt (2 af 20) er taget ud: den kræver en
rigtig sætningsanalyse, og UDPipe er CC BY-NC-SA. DaLA: stadig 0,3 % falske fund i rigtige sætninger.
**Ikke bygget:** Hunspell i stedet for Windows' stavekontrol (en erstatning af noget, der virker,
og et valg om ordbog og forslag i højreklik). Svære ord og forvekslinger med kontekst venter på
frekvensliste og COR.
**Revurdér:** når fundene er set i en rigtig tekst, og når COR-svaret kommer.

### ADR-0060 — Del en tekst eller en del af den med andre, som forslag og kommentarer (20/10-2026)
Supplerer ADR-0054. Plan: `docs/plans/2026-10-20-deling.md`.
**Baggrund:** skribenten deler tekster med andre og får rettelser tilbage i mails og Word-filer, som skal
skrives ind igen. Ofte er det kun et afsnit, der skal læses.
**Beslutning:**
- Et dellink pr. person, lavet på pc'en fra en markering eller hele teksten. Linket er adgangen,
  gæsten har ingen konto. Serveren gemmer kun tokenets hash. Linket udløber og kan trækkes tilbage.
- Kun det markerede sendes. Parkeret og dæmpet tekst, egne noter, forfatterblokken og
  `<!-- gt:… -->`-blokke tages ud på pc'en, før noget forlader den.
- Gæsten foreslår og kommenterer, men retter ikke: alt, gæsten skriver, bliver CriticMarkup-forslag og
  noter, som skribenten godtager eller afviser ét ad gangen.
- Delingen ligger på synkserveren som en kopi uden for skribentens synkede filer. Gæstens side gemmer med
  compare-and-swap. Pc'en fletter forslagene tilbage med trevejsfletningen (base = teksten ved deling).
**Alternativer der tabte:** samtidig redigering med en CRDT (Yjs) tabte af samme grund som i ADR-0054:
filerne er sandheden. Direkte rettelser uden forslag tabte, fordi skribenten ikke kan se eller afvise den
enkelte rettelse. Google Docs og Word online taber markdown, noter og parkeret tekst.
**Konsekvens:** STRATEGIs ikke-mål »ingen sky for andre end skribenten selv« er ændret til at tillade
dette ene: den del, skribenten selv vælger at dele. Styringspakken gælder for delingerne, og
privatlivssiden skal sige, hvad der gemmes, og hvor længe.
**Bygget 20/10** (trin 1-4): forslagstilstand (`src/editor/suggest.ts`, også til eget brug med
højreklik), delinger på serveren (`synk/kerne/src/deling.rs`, ét link og én kopi pr. person, så gæster
aldrig er i konflikt med hinanden), gæstens side (`del.html`, `/del/<link>`, bygget i
`synk/Dockerfile`) og pc'en (`src-tauri/src/shares.rs`, `src/share/`). Fletningen tilbage sætter først
det private ind igen præcist, hvor det blev taget ud, og fletter så med `merge.rs` mod den udgave,
forslagene sidst blev hentet fra, så de samme forslag aldrig kommer ind to gange. Delinger slettes 30
dage efter udløb eller stop.
**Revurdér:** hvis skribenten oftere har brug for at skrive samtidig med en anden end for at få forslag.

### ADR-0061 — Lange tekster fase 1: en hovedfil med kapitler som iA Writers content blocks (21/10-2026)
Plan: `docs/research/2026-10-07-lange-tekster.md`. Besluttet 21/10: byg fase 1, men uden en fremtrædende
plads i fladen.
**Beslutning:** En linje med kun `/Kapitel.md` (eller `.markdown`, `.txt`, også i en undermappe) er et
kapitel, som i iA Writer. Ingen ny fane, ingen kommando: hovedfilen er en almindelig tekst.
`src/editor/chapters.ts` viser hver linje som et kort med kapitlets første overskrift og ordtal og et
tal i alt under det sidste. Klik åbner kapitlet (`gt-open-link`). Print, PDF og Word samler kapitlerne
(`expandChapters`), og fodnoterne får kapitlets nummer foran, så `[^1]` i to kapitler ikke støder sammen.
**Sikkerhed:** `read_chapters` læser kun ved siden af en åben tekst, som fraklipsfilerne: relativ sti
uden `..` og drev, en tekstendelse, og efter kanonisering i hovedfilens mappe eller en undermappe
(`chapter_path`, testet). Højst 500 kapitler. Teksterne bor i et StateField og skrives aldrig.
**Ikke med i fase 1:** sideskift før hvert kapitel, indholdsfortegnelse i Word, »/« der foreslår
kapitler, kapitlernes egne kildelister (kun hovedfilens bruges) og kapitler i et kapitel.
**Revurdér:** når der er samlet en rigtig ansøgning eller bog.

### ADR-0062 — Kilder fra fodnoterne og henvisninger som fodnoter (21/10-2026)
Supplerer ADR-0049. Forslaget i tre trin blev valgt 21/10.
**Beslutning:** (1) Fanen Kilder viser under »Fra fodnoterne« de fodnoter, der har en webadresse eller
en `[@nøgle]` (`footnoteSources`). Fodnoter, der kun henviser til kilder på listen, står der ikke.
Resten er kommentarer og bliver under Fodnoter. (2) »Gør til kilde« udfylder formularen fra fodnoten
(`referenceFromFootnote`), og når kilden gemmes, bliver fodnotens tekst `[@nøgle]`. Fodnoten står,
hvor den stod. (3) Under Indhold i print vælges »Henvisninger som fodnoter«: hver henvisning bliver en
markdown-fodnote med hele kilden (`resolveCitations(…, "fodnoter")`), og litteraturlisten står stadig
sidst. Står henvisningen i en fodnote, sættes kilden ind i noten. Valget gælder print, PDF og Word.
**Revurdér:** hvis nogen skal bruge en bestemt notestil (Chicago med »ibid.«), der kræver CSL.

### ADR-0063 — Dansk stavekontrol med Hunspell og Stavekontroldens ordbog (bygget 9/10, taget ind 21/10-2026)
**Baggrund:** Windows' danske stavekontrol (ISpellChecker, som WebView2's røde streger og
`spelling.rs` brugte) kender ikke »skriveprogram«, »coronakrisen« og »gennemstreget«, og den
godkender opdigtede sammensætninger som »skrivedrogram« og »skriveprægram«. Research 9/10
(`docs/research/2026-10-09-dansk-ordbog.md`). Afløser stavekontrol-punktet i ADR-0012 og »Ikke bygget« i ADR-0059. Besluttet 21/10: ja, hvis det er bedre.
**Målt 21/10 på 129 publicerede fagartikler (105.594 ord):** Windows markerer 1,05 % af
ordene, Hunspell 1,19 %. Hunspells ekstra er næsten kun »sm«, »md«, »lg« (rester fra websiden, 295
forekomster) og skribentens eget efternavn (139), der føjes til ordbogen én gang. Uden dem markerer
Hunspell cirka en fjerdedel færre ord. Kun Windows markerer 191 almindelige danske ord, Hunspell
kender dem (»corona«, »coronakrisen«, »nedlukning«, »forperson«, »prekarisering«, »ressourceforløb«).
Kun Hunspell: 84, mest navne. Ord med »å« som a plus ring (U+030A, fra en Mac eller en PDF) komponeres, før Hunspell slår dem op, ellers blev »på« markeret. 298 lavede tastefejl i lange ord: Hunspell fanger 294, Windows 287
(Windows godkender fx »grundlægeende«, »universitetsuddanneleer«). Målingen: `maal_korpus` i `spelling.rs`.
**Beslutning:**
- **Hunspell 1.7.5** (C++, samme kode som LibreOffice, Firefox og Chrome, fuzzet) ligger uændret i
  `src-tauri/vendor/hunspell/` med kildens sha256 i `LICENSE`, og bygges statisk med `cc` i `build.rs`
  (altid `-O2`, `/utf-8`). Ingen ny crate: `cc` lå i `Cargo.lock`. Fem C-kald bag en sikker indpakning
  (`Hunspell` i `spelling.rs`). Stier sendes som `\\?\` og UTF-8, så Hunspell åbner dem med `_wfopen`.
- **Ordbogen** er da_DK fra Stavekontrolden (bygget på DSL's data), lagt i `resources/ordbog/` og med
  i installeren (`bundle.resources`). Kilde, version og sha256 står i `KILDE.txt`. Den indlæses i
  baggrunden ved start (`spelling::init`) og bor bag én `Mutex`.
- **Licens:** Hunspell og ordbogen er begge tre-licenseret (MPL 1.1, GPL 2, LGPL 2.1). Vi bruger
  begge under **LGPL 2.1**, fordi MPL 1.1 ikke kan kombineres med programmets GPL-3.0.
  `licenser.mjs` skriver sektionen »Stavekontrol og ordbog« i »Om«.
- **Egne streger:** WebView2's stavekontrol er slået fra i skrivefladen og tabelcellerne
  (`spellcheck=false`). `src/editor/spelling.ts` tegner `.gt-spell` (bølget `--fejl`, som i fanen
  Sprog) i de synlige linjer, med svaret pr. ord gemt i hukommelsen og nye ord slået op i én
  omgang 300 ms efter sidste tastetryk (`spell_check_words`). Ordet, man skriver på, får ingen streg.
  Ingen streger i kode, links, adresser, skjulte blokke, fodnotehenvisninger, #tags, ved tal og i ord
  med store bogstaver inde i ordet. Overskrifternes tekst tjekkes, #-tegnene ikke. Tabelceller får
  stregen gennem CSS Custom Highlight API. Samme ordregler i Rust (`tokens`) til fanen Sprog.
- **Forslag:** Hunspells først. Er der færre end fem, fyldes op med Windows' danske forslag, som
  Hunspell godkender. `edits()` bruges kun til engelsk. Forslagene gemmes pr. ord.
- **Egen ordbog:** `<data>\ordbog.txt`, ét ord pr. linje, gemt atomisk. »Tilføj til ordbog« skriver
  dér, kalder `Hunspell_add` og sender `spell-added`, så stregen forsvinder med det samme i alle
  vinduer. Første gang hentes Windows' `%APPDATA%\Microsoft\Spelling\da-DK\default.dic` og iA Writers
  `custom_dictionary.txt` ind, én gang.
- **Windows bliver** til engelsk brugerflade og som reserve, hvis ordbogen ikke kan indlæses. Den
  flytbare udgave er én exe uden ressourcer og bruger derfor Windows' danske.
**Målt (9/10, release-byg):** se tallene i `spelling.rs` `maal_tider`.
**Opdatering:** `node scripts/ordbog.mjs` (`--tjek` viser kun) henter nyeste .oxt fra
stavekontrolden.dk, stopper hvis version, tegnsæt eller licenslinjer ikke passer, sammenligner med
LibreOffices kopi ved samme version, viser forskellen i grundformer og skriver filerne og `KILDE.txt`.
Bagefter `cargo test spelling` (prøveordene) og `node scripts/licenser.mjs`. Én til to nye versioner
om året. Hunspell opdateres i hånden: ny kilde i `vendor/hunspell/src`, ny sha256 i `LICENSE`.
**Ikke valgt:** Windows' ISpellChecker (se baggrunden). spellbook 0.4.2 (ren Rust): afviser gyldige
bøjede sammensætninger (»fejlloggen«, »designprincipper«), godkender »skriveprægram«, forslag tager op
til 2,4 s. nuspell: også C++, men kræver ICU (stort bibliotek mere at bygge og licensere), og
ordbogen er lavet og testet mod Hunspell, ikke nuspell. Ikke målt på dansk. hunspell-rs/hunspell-sys: døde
siden 2022, gammel Hunspell og kræver libclang. Ordbogen bagt ind i exe'en (4 MB mere i hver kopi).
**Revurdér hvis:** spellbook bliver god nok til dansk (så forsvinder C++), eller den flytbare udgave
skal have samme stavekontrol som den installerede.

### ADR-0064 — Det, der kun virker for ejeren, vises kun for ejeren (22/10-2026)
**Baggrund:** gennemgangen 22/10 viste, at Synkronisering, Deling og telefonappen kræver ejerens
synkserver. En ny enhed kan kun forbindes med en parringskode eller ejernøglen, men alle så fanerne,
og »Del« endte i en fejl.
**Beslutning:**
- Deling (fanen og »Del det markerede« i højreklikmenuen) vises kun på ejerens enhed, forbundet.
  `src/share/available.ts` følger `synk-status` (`connected && owner`), så fanen kommer og går med
  forbindelsen. En enhed parret med en kode er forbundet, men ikke ejer: serveren afviser dens
  delinger og parringskoder, så den ser ingen af delene (rettet samme dag). `owner` ligger i synkens
  `meta`. Enheder forbundet før 22/10 spørger serveren én gang (`GET /v1/enheder`: 200 eller 403).
- Delingerne bor på serveren. »Kobl fra« på ejerens enhed spørger derfor først, om de aktive
  delinger skal stoppes, for bagefter kan de ikke stoppes herfra. Uden net kobles der fra som før.
- Skjulningen i fladen er ikke grænsen. Den håndhæves i Rust (`http()` fejler uden nøgle) og på
  serveren (`gate`, `owner()` i `synk/server/src/api.rs`).
- Fanen Synkronisering bliver, så ejeren kan forbinde en ny pc. Uforbundet viser den først vejen for
  alle andre: biblioteket i deres egen OneDrive-, Google Drev- eller Dropbox-mappe. Felterne til
  synkserveren ligger bag »Forbind til en synkserver …« (på telefonen står de fremme).
- Ingen deling for alle. Synkserveren åbnes ikke for fremmede.
**Alternativer der tabte:** en integration med OneDrive eller Google Drev (filerne er almindelige
filer, så tjenesterne synker dem allerede), og deling for alle (misbrug, drift og privatliv for
fremmede, besluttet nej 22/10).
**Konsekvens:** gem tåler skytjenesterne allerede: den midlertidige fil hedder `.….gt.tmp`, så
OneDrive springer den over, ReplaceFileW prøver igen ved en lås, pladsholdere læses ikke i biblioteket,
og en fil ændret udefra overskrives ikke (ADR-0013). Fejl 362 (filen ligger kun i skyen, og tjenesten
kører ikke) har fået en dansk besked. Ikke prøvet med en rigtig OneDrive-synk mellem to pc'er.

### ADR-0065 — Programmet tegner selv titellinjen, og den er væk, mens der skrives (22/10-2026)
**Baggrund:** ønske 22/10, med iA Writer som forbillede: teksten skal ikke helt op mod toppen, og
toppen af vinduet skal forsvinde af sig selv. Windows' egen titellinje stod altid fremme, og
rullet tekst gik helt op under den.
**Beslutning:**
- Hovedvinduet og tekstvinduerne har ingen Windows-ramme (`decorations: false`). Fladen tegner en
  linje på 32 px øverst (`ui/titlebar.ts`) med tekstens navn og minimér, maksimér og luk. Den er
  usynlig, til musen kommer op til den, og står fremme på startsiden uden tekst. Den kan trækkes i,
  og dobbeltklik maksimerer (`data-tauri-drag-region`). Ro på og fuld skærm har ingen.
- Luk går samme vej som Windows' kryds: `close()` giver `CloseRequested`, som Rust fanger, og fladen
  gemmer først. `capabilities/default.json` får `start-dragging`, `minimize`, `toggle-maximize` og
  `close`, intet andet.
- Skrivefladen begynder under linjen og toner teksten ud over de øverste 48 px (`mask-image` på
  rulleområdet). Panelerne og beskedlinjen rykker ned med den (`--titellinje`).
- Titlen læses med `title()`, når musen kommer ind på linjen. Rust ejer stadig titlen (`set_title`).
**Alternativer der tabte:** at beholde Windows' linje og kun give teksten mere luft (toppen ville
stadig stå fremme), og `titleBarStyle: overlay` (findes kun på macOS). Prisen: Windows 11's
snap-menu ved maksimér-knappen kommer ikke frem. Win+piletaster og træk mod kanten virker stadig.

### ADR-0066 — Gode Tekster står alene, uden forbindelser til husets andre apps (22/10-2026)
**Baggrund:** Gode Tekster er offentligt på GitHub. Sprogreglerne var en kopi af et andet af Gode
Mediers programmer og blev holdt ens af et script og en test, der kun virkede på udviklerens pc.
Kommentarer og dokumenter henviste til programmer, en udefrakommende ikke kan se.
**Beslutning:**
- `src/sprog/` (`clarity.ts`, `quotes.ts`, `aitells.ts`) er programmets egen kode. Den rettes her,
  og der er intet synkroniseringsscript og ingen test mod en anden kilde.
- Ingen kode, kommentar eller dokumentation peger på husets andre programmer. Programmet kalder
  kun sine egne tjenester (opdatering, synkronisering, deling) og de sprogmodeller, brugeren vælger.
- ADR-0016 (fælles MCP-server) er afløst og bliver ikke bygget.
**Alternativ der tabte:** at beholde kopien og synkroniseringen. Én regel ét sted er godt i et
hus, men i et offentligt repo er en afhængighed af privat kode en, ingen udefra kan følge.

### ADR-0067 — Sideskift skrives `+++` på en linje for sig, som i iA Writer (26/10-2026)
**Baggrund:** ønske 26/10: et sideskift i print, PDF og Word. Markdown har intet, og der fandtes
ingen form i programmet.
**Beslutning:**
- `+++` alene på en linje uden for kode er et sideskift. Det er iA Writers form, så filen betyder
  det samme dér. Står det lige op ad en tekstlinje, tæller det stadig.
- Print og Word: `prepare` (print/render.ts) gør linjen til et afsnit med et usynligt mærke
  (`PAGE_MARK`, U+2064), som `SPACE_MARK`. Print får `break-after: page`, Word en `PageBreak`. Et
  sideskift først eller sidst i teksten fjernes, så der ikke kommer en tom side. Kopiér uden markdown
  dropper det, kopiér med markdown skriver `+++` igen.
- Skrivefladen viser en stiplet streg med »Sideskift«, til markøren kommer ind på linjen. `/sideskift`
  og højreklik › Tilføj › Sideskift sætter det på sin egen linje (`planOwnLines` i commands/run.ts).
**Alternativer der tabte:** `\newpage` (pandoc, LaTeX: fremmed for skribenter) og
`<div style="page-break-after: always">` (HTML i teksten, som print escaper).

### ADR-0068 — Ikonet ved uret bliver til noterne, og det står altid fremme (29/10-2026)
**Baggrund:** ønske 29/10: et notesymbol ved uret, når der er noter fremme, og et tryk giver en
oversigt. Tre bud (eget ikon med menu, eget ikon med oversigt, Gode Teksters ikon skifter). Valgt
blev ét ikon, der skifter, med oversigten, og ikonet må ikke ligge under pilen ^.
**Beslutning:**
- Der er stadig ét ikon (`tray.rs`). Med noter fremme (også skjult med »Skjul alle noter«) bliver
  det til et notesymbol, ellers er det programmets ikon. Symbolet er 32 × 32 RGBA i
  `icons/note-lys.rgba` og `note-moerk.rgba` (ingen PNG-afkoder), hvidt på en mørk proceslinje og
  mørkt på en lys (`SystemUsesLightTheme`). Hjælpeteksten siger, hvor mange der er fremme. Ikonet
  skiftes kun, når en note kommer frem eller lukkes (`notes::adopt`, `destroyed`, `changed`).
- Venstreklik viser oversigten (`noteoversigt.html`, `src/noteOverview.ts`): et rammeløst vindue
  over ikonet med noterne fremme som kort i deres farve, ellers de seks nyeste, og søgning i alle
  noter. Det skjules ved klik et andet sted og lukkes efter to minutter skjult (ca. 30 MB). Første
  gang vises det først, når fladen har tegnet (`overview_ready`). Højreklik giver menuen.
- Fremme altid: `IsPromoted = 1` under `HKCU\Control Panel\NotifyIconSettings` for programmets egen
  exe-sti, før og efter ikonet registreres (Windows læser værdien ved registreringen, og første
  gang findes nøglen først bagefter). Samme opskrift som husets andre bakkeprogrammer. Testkørsler
  rører ikke registreringsdatabasen.
**Ikke valgt:** et ikon mere (to ikoner fra samme program, og det nye lægges under pilen), Windows'
egen menu som oversigt (kun tekst), et tal på ikonet (et billede pr. tal) og et forvarmet
oversigtsvindue (30 MB hele tiden).
**Revurdér hvis:** Defender reagerer på skrivningen i `NotifyIconSettings` (som schtasks 15/10,
ADR-0056), eller Windows ændrer, hvor det gemmer valget.

### ADR-0069 — Forhåndsvisningen viser sider, og valgene står i et panel (29/10-2026)
**Baggrund:** forhåndsvisningen var ét langt ark, så ingen kunne se, hvor siderne skiftede. En lang
tabel med `break-inside: avoid` sprang til næste side og efterlod en halvtom side. Linjen øverst
havde ni knapper, og skabelonnavnene »Som på skærmen« og »Som i et blad« var svære at forstå.
**Beslutning:**
- Sider: på skærmen står artiklen i spalter på en sides højde, der brydes til rækker
  (`column-wrap: wrap`, Chromium 145+, WebView2 er 156). Chromium deler spalter med samme regler
  som sider, så siderne skifter samme sted som i PDF'en (målt 6/6 sider). Hvide ark med sidehoved,
  sidefod og sidetal ligger bag. Spalter gentager ikke en tabels `thead`, så forhåndsvisningen
  lægger en kopi ind (`repeatHeads`). Print og PDF ser ingen af delene (`@media screen`).
- Tabeller over 15 rækker (`pv-long`) må deles mellem rækkerne, kortere holdes samlet.
- Panelet (bud 2 af to): skabelon, »Med på siden« som flueben, »Sidehoved, sidefod og margener …«
  (side-designeren i samme panel) og knapperne til PDF, Word, Udskriv og Kopiér. Øverst kun
  sideantallet og Luk. Et smalt vindue skalerer papiret (`zoom`), så panelet altid ses.
- Skabelonerne hedder Manuskript og Læseudgave, med en linje om, hvad de er. Designerens skrift
  hedder det, skriften fra Indstillinger hedder (fx Recursive Halvmono).
**Ikke valgt:** Paged.js (en stor afhængighed for det, Chromium kan selv) og at vise den rigtige
PDF (kræver en PDF-fremviser i fladen).

### ADR-0070 — Biblioteket viser mappen med den åbne tekst, også uden for bibliotekerne (29/10-2026)
**Baggrund:** ønske 29/10: biblioteket skal stå i mappen med den fil, der åbnes. Det gjorde det kun,
når filen lå i et bibliotek. Åbnet fra Stifinder blev biblioteket stående, og i en stor mappe skulle
man selv rulle hen til filen.
**Beslutning:** `list_folder`, `watch_folder` og åbning af en tekst tillader også mappen med en åben
tekst og mapperne under den (`library::listable`, `beside_open`), så længe teksten er åben. Aldrig
et helt drev eller hele brugermappen, som billederne (`allow_images`). Omdøbning, flytning, sletning
og nye filer kræver stadig et bibliotek, og biblioteket siger det over listen. Listen ruller hen
til den åbne tekst.
**Ikke valgt:** at gøre mappen til et bibliotek af sig selv (biblioteker vælges kun i mappevælgeren).
**Samme dag:** mappevisningen viser alle mapper, også i en kodemappe (ønske 29/10: »den må læse alle
mapper«). Før skjultes `docs`, `audit`, `lektioner`, byggemapper, punktum-mapper og worktrees, og en
kundes tekster i `docs\` kunne ikke findes. Kun projektfilerne (README, TODO, AGENTS …) dæmpes
stadig. Søgningen og hurtigåbningen (`files_in`) springer byggemapper, punktum-mapper og worktrees
over som før: de læser hver fil, og en worktree viser de samme tekster to gange.
