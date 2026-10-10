# Gode Tekster — strategi

> **Hvorfor, for hvem og hvad der bevidst er udenfor.** Den stabile kerne. *Hvordan vi bygger*
> står i [AGENTS.md](AGENTS.md). *Hvordan maskinen kører, plus ADR-loggen* står i
> [ARKITEKTUR.md](ARKITEKTUR.md).

## Formål

Et skriveprogram til Windows for alle, der skriver længere tekster selv: artikler, rapporter,
ansøgninger, opgaver, oplæg og bøger. I markdown, og for mange som afløser for iA Writer eller Word. Det giver plads til, at skribenten selv skriver, og tager
det manuelle arbejde, når skribenten beder om det: skære, tjekke fakta og finde kilder.

Idéerne er prøvet af i Gode Ord, der blev bygget som en tjeneste til redaktioner. Gode Tekster
er det modsatte valg: et værktøj til den enkelte skribent og dens egen arbejdsgang, ikke en
tjeneste.

## Målgruppe

Folk, der skriver deres tekster selv og vil have hjælp på bestilling, ikke en maskine, der skriver
for dem: journalister og forfattere, men lige så meget studerende, konsulenter, forskere,
fundraisere og alle, der skriver meget på arbejdet (7/10: »tænk bredere end journalister«). Programmet er bygget efter en skribents faste vaner frem for at
gøre alt konfigurerbart. Kravene, de vaner fører til:

- Skriver i markdown og i mange mapper på samme tid: artikler, strategi, fælles dokumenter og
  OneDrive.
- Bruger iA Writers forfatterskab, en annotationsblok sidst i filen.
- Dæmper tekst, der måske skal ud, i stedet for at slette den med det samme.
- Parkerer klippet tekst i en separat fil ved siden af artiklen (`FRAKLIP.md`).
- Navngiver egne filer med store bogstaver (`ARTIKEL`, `VINKEL`, `RÅNOTER`, `TALEPUNKTER`).
- Har mål for længden, en egen ordbog, en printskabelon og genbrugelige tekststykker.
- Skriver til nogen, der sætter en grænse for længden i anslag, ord eller sider: redaktioner,
  fonde, forlag, uddannelser og kunder.
- Det, der kun gælder én slags skribent, er et valg, ikke en standard: status, felter og skabeloner
  kan navngives af brugeren.

## Designprincipper

Fælles for de bedste skriveprogrammer, og det, brugerne hader, når det brydes (intern research
2/10-2026).

1. **Kilden røres aldrig** ud over skribentens egne rettelser. Ingen normalisering af tabeller,
   linjeskift, kodning eller anførselstegn ved gem. (Typoras mest langvarige klage.)
2. **Intet hopper.** Markdown-tegn skjules og vises uden at teksten flytter sig. (Obsidians.)
3. **Gendan sletter aldrig.** Før en gammel version hentes frem, gemmes den nuværende.
4. **AI foreslår, skribenten vælger.** Forslag vises som liste eller diff og godkendes ét ad gangen.
   »Godkend alle« er aldrig standardknappen. Intet skrives i teksten uden et klik.
5. **Parkeret tekst er ude af regnestykket.** Den tæller ikke med i anslag, kommer ikke med i
   eksport og sendes ikke til modellen.
6. **Alt om en tekst ligger i filen:** dæmpet tekst, parkeret tekst og forfatterskab. Formatet
   er åbent og læses af iA Writer (ADR-0008, ADR-0009).
7. **Et citat er først et citat, når programmet selv har fundet det på kildens side.** Modellens
   ord alene er ikke nok (L-326, Prismet).
8. **Programmet er klar, før skribenten er.** Det åbner der, hvor skribenten slap, med markøren
   på plads.
9. **En enkel skriveflade, også når programmet vokser.** Nye funktioner kommer frem ved behov,
   bruger de eksisterende paneler og strukturer og kræver et konkret skrivebehov. Storyboard
   og referencer må ikke føre til flere faste værktøjslinjer, konkurrerende visninger eller
   indstillinger for alle tænkelige arbejdsgange. Start, skrivning og almindelige tekster skal
   forblive hurtige. Udvidelser indlæses først, når de bruges (Troels, 10/10).

## Scope og afgrænsning

**Mål:**
- Starter lynhurtigt og åbner markdown-filer, også dem med iA Writers forfatterskab.
- Markdown vises som formateret tekst, ikke som kode. Tegnene kommer frem, hvor markøren står.
- Mappeoversigt til venstre bygget på biblioteker, brugeren selv vælger. Hurtigåbning (Ctrl+O)
  og en disposition over overskrifterne.
- **Dæmpet tekst:** markeret tekst bliver grå. Det er tekst, skribenten måske vil have ud.
- **Fraklip:** højre spalte, hvor tekst flyttes ud som små kort, også ved at trække et helt
  afsnit derover, og trækkes ind igen (forbillede: Highland 2's »Bin«). Det er standardfanen.
  Fakta, Research og Sprog er sekundære faner. Afløser `FRAKLIP.md`, som kan hentes ind.
- **Kildehenvisninger som fodnoter** (2/10): et lille hævet tal i teksten, selve noten i
  fanen Noter i højre spalte. Ctrl+Alt+F som i Word. Research og faktatjek kan sætte en fundet
  kilde ind som fodnote. Word får ægte fodnoter, PDF får noterne samlet sidst (ADR-0017).
- **Formatering ved markering:** en lille menu med fed, kursiv, understreget, gennemstreget,
  lister og H1-H4, og under »···« blandt andet »Lav til tabel«, »Dæmp« og »Flyt til fraklip«.
- **Paneler, der gemmer sig:** begge sidepaneler er skjult som standard og glider blødt frem,
  når musen når kanten, og væk igen, når den forlader dem. Et løst panel lægger sig over teksten,
  et fastgjort panel får sin egen plads. En diskret knappenål nederst i panelet fastgør det, og
  det samme gør Ctrl+E (biblioteket) og Ctrl+W (højre spalte). Ctrl+R viser forhåndsvisning
  som PDF eller HTML. Design: lærredet runde 5.
- Automatisk gem uden dialoger, og versioner pr. arbejdssession, der kan sammenlignes.
- **Forfatterskab:** det, skribenten skriver, holdes adskilt fra tekst, der er kommet udefra
  (AI-rettelser, research, indsat tekst, Claudes rettelser i filen), så skribenten kan se, at
  intet AI-skrevet er gledet med. Et tal for, hvor meget af teksten skribenten selv har skrevet.
- **Tal, der passer til arbejdet:** et diskret ordtal i nederste højre hjørne, der vises
  ved hover eller altid, hvis skribenten vælger det, og folder sig ud til anslag inklusive
  mellemrum, ord, normalsider og læsetid. Mål kan være et loft (»højst 7.400 anslag«).
- Fokus på sætning eller afsnit, og fast rulning, som to selvstændige valg.
- Dansk stavekontrol og dansk typografi (»…«, aldrig em-dash). **Ordklasser på dansk**
  (adjektiver, navneord, adverbier, verber, konjunktioner) som iA's syntaksfarver, der kun findes
  på engelsk.
- **Emoji** til LinkedIn-opslag via Windows' egne vælgere (Win+. og Win+V). Skrivefladen falder
  tilbage til Segoe UI Emoji, og en emoji tæller som ét anslag.
- **Overskrifter i større grader** end brødteksten. `####` er manchet, ikke overskrift.
- **Grafer i teksten** som en kodeblok (` ```graf `) med opsætning og tal i klar tekst. Tegnes med
  Gode Grafers motor (`renderChartSVG`, 25 graftyper). Ingen fremmede scripts køres. Fotos som
  almindelige markdown-billeder med billedtekst.
- **Versioner** i en fane i højre spalte, grupperet efter dag, med navngivne milepæle. En gammel
  udgave vises med en stribet ramme og kan gendannes uden at miste den nuværende.
- **Indstillinger** nederst i venstre spalte, der folder sig op i spalten.
- **Logo:** papir i valsen med den blå markør (logo C, `assets/logo/gode-tekster.svg`).
- **Fremhævet citat** med den klassiske mørke streg til venstre, citatet i kursiv og navnet under
  (citat A, »det mest rolige«, afløser citat 3 efter første prøve 2/10).
- **Rent at skrive i:** ingen småtekster, hints eller metadata på skærmen. Lysegråt som iA,
  iA Writer Duo og iA's tykke blå markør (design A2).
- **Husets datakilder** (Folketinget, Retsinformation, DST, CVR, kernedata, Gode Ords sprogtjek)
  via gode-mcp, med én nøgle (ADR-0016).
- Hjælp fra en sprogmodel, når skribenten beder om det: forslag til at skære lidt eller meget (det
  foreslåede bliver dæmpet), faktatjek som kort ud for påstanden, og research med kilder, hvor
  citatet er fundet på siden og linket springer direkte til det.
- Ctrl+P giver en forhåndsvisning, der er klar til print. PDF og Word med to skabeloner:
  »Manuskript« (til redaktører, fonde og forlag) og »Læseudgave«.

**Ikke-mål:**
- Ingen sky og ingen synkronisering. Filerne ligger i mapper på pc'en.
- Kun Windows. Ingen Mac.
- Modellen formulerer aldrig ny tekst, heller ikke »bedre« sætninger. Den må vise research,
  som skribenten selv vælger at tage med eller ej.

## Afgrænsningen mellem skribentens tekster og husets

En arbejdsmappe kan være fuld af markdown, som Claude skriver: kontraktfiler, handoffs, planer,
lektioner. De skal ikke drukne skribentens egne tekster. Reglerne er afprøvet mod et bibliotek
med godt tusind .md-filer og ligger i `src-tauri/src/library.rs` med tests (flyttet fra
TypeScript 2/10, så skjulte mapper aldrig læses).

1. **Biblioteker:** venstre side viser de mapper, brugeren selv har tilføjet, ikke hele
   arbejdsmappen.
2. **Skjult:** mapper, der starter med punktum (`.claude`, `.git`, `.next`, `.venv`),
   afhængigheder og byggeoutput (`node_modules`, `target`, `dist`, `build`, `out`,
   `__pycache__`, `vendor`), lokale repo-spejle og git-worktrees (en mappe med en
   `.git`-*fil*), som ellers viser de samme filer flere gange.
3. **Dæmpet, med en til/fra-knap:** husets kontraktfiler efter en fast navneliste med præcis
   husets stavemåde (`AGENTS`, `TODO`, `KUNDE`, `ARKIV` …, plus `HANDOFF-*`), aldrig efter »store
   bogstaver«, og mapperne `docs\`, `audit\` og `lektioner\`. En skribents egen `strategi.md`
   dæmpes derfor ikke.
4. **Delte filer:** programmet ved, hvad det selv gemte sidst. Er filen rettet udefra siden,
   mærkes rettelsen, og den kan ses og spores som AI (ADR-0009).

## Succeskriterier

- En skribent skriver i Gode Tekster i stedet for iA Writer i to uger i træk.
- Programmet er klar til at skrive i, før skribenten kan nå at tænke over det: under ét sekund
  fra klik til markør i en fil (målt i release-byg på en almindelig bærbar).
- Skribenten kan pege på hver sætning i en tekst og se, om den er skrevet af skribenten selv.
- En fil, der har været igennem Gode Tekster, åbner i iA Writer med forfatterskabet intakt.
- Ctrl+P i en artikel giver en udskrift, skribenten ikke behøver at rette i Word bagefter.

## Forudsætninger og risici

- **Abonnementet som motor:** sprogmodellen kører gennem brugerens Claude Code-login (ADR-0004,
  ADR-0010). Anthropic har varslet, at `--bare` bliver standard for `claude -p`, og `--bare`
  bruger ikke abonnementet. Programmet tjekker derfor ved hvert kald, at abonnementet bruges,
  og siger tydeligt fra, hvis ikke.
- **Teksterne går til USA**, når skribenten beder om hjælp. Det er en bevidst afvigelse fra »7 ting«
  punkt 2f og står som ADR-0004.
- **Husets første Rust-projekt.** Der er ingen lektioner, ingen registerblokke og intet
  commit-tjek at arve. Det, der læres her, skal skrives ned, så det næste Rust-projekt får det.

## Persondata

Ingen andres persondata ud over det, skribenten selv skriver i sine tekster. Programmet har ingen
server, intet login og deler intet. Styringspakken fra `standard\templates\styring\` gælder ikke.
