# Changelog

Alle ændringer, brugerne kan mærke, står her. Formen er
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), og versionerne følger
[SemVer](https://semver.org/). Et rettet sikkerhedshul står altid under Security.

Every user-visible change is listed here, in Danish, in the Keep a Changelog 1.1.0 format with SemVer
versions. Releases up to 0.2.27 are described in one paragraph each, as on the
[download page](https://godemedier.dk/apps/gode-tekster/).

## [Unreleased]

## [0.2.31] - 2026-10-29

Når der er noter fremme, bliver ikonet ved uret til et notesymbol. Klik på det, så kommer en lille oversigt med noterne som kort i deres farve, og du kan søge i alle noter. Højreklik giver menuen som før. Ikonet står nu altid fremme på proceslinjen og ligger ikke længere gemt under pilen. Når du åbner en tekst, står biblioteket i dens mappe og ruller hen til den, også når teksten ligger uden for dine biblioteker. Så kan du åbne nabofilerne derfra. Biblioteket viser nu alle mapper, også docs og de andre mapper, der før var skjult i et kodeprojekt. Kun projektfiler som README og TODO kan stadig slås fra. Udskriv og eksportér har fået et panel til højre med skabelonen, det, der skal med på siden, sidehoved og sidefod og knapperne til PDF, Word, Udskriv og Kopiér. Skabelonerne hedder nu Manuskript og Læseudgave. Forhåndsvisningen viser nu siderne, som de bliver i PDF'en, med sidehoved, sidefod og sidetal, og antallet af sider står øverst. Før var det ét langt ark. En lang tabel deles nu mellem rækkerne med overskriften gentaget øverst på næste side. Før sprang den til en ny side og efterlod resten af siden tom. En tabel på op til 15 rækker holdes stadig samlet. Åbnede man forhåndsvisningen med Ctrl+P og udskrev med Ctrl+P, kom en rød streg med øverst og nederst på hver side. Henvisninger som [@hansen2024, s. 42] tæller ikke længere med i ordtallet. Noternes placering blev ikke gemt, når mappen var angivet med skråstreger (C:/…).

## [0.2.30] - 2026-10-27

Skriv [[ for at henvise til en anden tekst. Et søgefelt viser teksterne i dine biblioteker, og den, du vælger, bliver et link med tekstens navn. Har du markeret noget, bliver det linkets tekst. Ctrl+klik åbner teksten. Linket er almindelig markdown, så det virker også i print og i andre programmer. Det samme findes under højreklik › Tilføj. I en tabel kan du nu markere flere celler på én gang. Træk med musen fra én celle til en anden, eller Shift+klik. Klik på håndtaget over en kolonne eller ud for en række, så er hele kolonnen eller rækken markeret. Ctrl+B, Ctrl+I og Ctrl+U virker så på alle cellerne, og Ctrl+Z fortryder det i ét trin. Delete tømmer cellerne, og Ctrl+C kopierer dem, så de kan sættes ind i et regneark. Ctrl+B uden markering gør hele ordet fedt, nu også i en tabelcelle og på ord som »e-mail«. Højreklikker du på et ord, kan du formatere det under Formatér uden at markere det først. Piletasterne i en tabel går nu altid lige op, ned og til siden, fra celle til celle. Pil ned i sidste række giver en ny række, og pil til højre i sidste kolonne en ny kolonne. Går du tilbage uden at skrive noget, forsvinder de igen. Flytter du en åben tekst til en anden mappe, i biblioteket eller i Stifinder, gemmer programmet videre i den nye fil. Før kom der en fejl ved hvert gem, og programmet ville ikke lukke. Et link til en delt tekst har nu koden efter et #, så den ikke sendes til serveren og ikke står i serverens log. Gamle links virker stadig. Security: versionshistorikken pakkes nu med zstd 0.14.3, som retter en række huller i biblioteket (RUSTSEC-2026-0391 og -0395 til -0406). Programmet brugte ikke de dele, hullerne sad i.

## [0.2.29] - 2026-10-26

Du kan nu sætte et sideskift i teksten. Skriv +++ på en linje for sig, eller brug /sideskift eller højreklik › Tilføj › Sideskift. Print, PDF og Word begynder en ny side dér, og i skrivefladen står en stiplet streg. Det er samme form som i iA Writer. Håndtaget til at flytte en række i en bred tabel står ikke længere oven på teksten. Et linjeskift i en tabelcelle stod som »<br>« i print, PDF og Word. Nu er det et linjeskift.

## [0.2.28] - 2026-10-26

Windows' titellinje er væk. Toppen af vinduet er tom, mens du skriver, og en tynd linje med tekstens navn og knapperne til at minimere, maksimere og lukke kommer frem, når musen er deroppe. Teksten toner ud, før den når toppen. Rækker og kolonner i en tabel kan nu flyttes. Træk i håndtaget ud for rækken eller over kolonnen, eller tryk Alt og en piletast. Udskriv og eksportér har fået et ikon nederst i højre spalte. Deler du en tekst, kan den, du deler med, nu rulle hele vejen ned og læse alle kommentarerne.

## [0.2.27] - 2026-10-22

Højreklik på et ord fryser ikke vinduet mere, mens fanen Sprog leder efter stavefejl. En lang tekst med kapitler reagerer hurtigere, når du skriver og flytter markøren. Det samme gør »Ret som forslag«. En fejlbesked i Indstillinger kan nu ses og lukkes, uden at Indstillinger lukker. Fejler forbindelsen under Synkronisering, står det, du har tastet, der stadig.

## [0.2.26] - 2026-10-22

Stavekontrollen bruger nu den danske ordbog fra Stavekontrolden. Skriver du »4. maj« først i en linje, bliver det ikke længere til en nummereret liste, og en replik som »- Hej, sagde hun.« bliver ikke til et punkt, når du trykker Enter. Replikken får tankestreg. Vil du have listen alligevel, giver Ctrl+Z den tilbage. Under Indstillinger, Synkronisering kan du nu se, hvordan du får dine tekster på flere computere med din egen OneDrive, Google Drev eller Dropbox.

## [0.2.25] - 2026-10-21

En fodnote med et link eller en henvisning kan gøres til kilde, og henvisninger kommer med som fodnoter i print og Word. En lang tekst kan samles af kapitler i hver sin fil, som content blocks i iA Writer. Favoritterne står samlet i biblioteket. Lukker Windows ned, venter programmet nu på, at teksten er gemt.

## [0.2.24] - 2026-10-21

Ikonerne i højre spalte har fået navn under sig og hver sin form. Fanen Struktur er taget ud, indtil den er færdig. Dele, du allerede har lavet, bliver liggende i teksten. Første gang du slår ordklasser til, farves kun tillægsord og biord. Dispositionen viser nu også overskrifter i lister og stopper ikke længere ved en fodnote midt i teksten. Med markdown skjult helt flytter piletasterne ét synligt tegn ad gangen, og skriver du hen over fed tekst, står der ikke halve stjerner tilbage.

## [0.2.23] - 2026-10-21

Når du deler en tekst, står dit navn nu på modtagerens side, så de kan se, hvem den er fra. Siden, modtageren ser, har fået et nyt og tydeligere design og følger mørkt tema.

## [0.2.22] - 2026-10-20

Højre spalte er lavet om. Fanerne er ikoner i en bjælke, og alle har samme knapper og skrift. Input hedder nu AI-hjælp. To nye kommandoer: /argument peger på påstande uden belæg og spørger til de antagelser, argumentet hviler på, og /modargument stiller de modargumenter, teksten ikke tager stilling til. Synken sletter ikke længere en fil på serveren, fordi den var åben i Word, og Afslut hænger ikke, når notelisten er åben. Noterne lægger sig bag de andre vinduer ved start.

## [0.2.21] - 2026-10-20

Med højreklik kan du slå »Foreslå rettelser« til. Det, du skriver og sletter, bliver forslag, som du godtager eller afviser ét ad gangen, som Spor ændringer i Word. Ctrl+N laver nu en ny tekst, og ChatGPT som AI-hjælp virker igen. Er filen åben i Word, eller er OneDrive ved at synkronisere den, gemmer Gode Tekster selv, når den bliver fri, og Afslut spørger, hvis teksten kun ligger i backup. En fil med et enkelt tegn i et gammelt tegnsæt får ikke længere forkerte æøå.

## [0.2.20] - 2026-10-19

Stod et ord i fed, kursiv eller som link lige før et komma eller punktum, kunne kommaet havne først på næste linje. Det sker ikke længere. Fodnotens tal bliver nu også stående ved ordet, det hører til, og et ord med fed midt i knækker ikke over.

## [0.2.19] - 2026-10-19

Begyndte en tabelcelle med en kantet parentes, for eksempel »[note]«, blev hele cellen til et link, når tabellen blev gemt. Teksten blev understreget, og det, du skrev, havnede bag linket. Det er rettet. Ser en celle sådan ud hos dig, ligger den rigtige tekst under Historik. Programmet lukker nu også ved første Afslut, når et notesark venter i baggrunden.

## [0.2.18] - 2026-10-19

Skriver du i en tabel med fast rulning slået til, står siden nu stille. Før kunne ét bogstav i en celle få hele teksten til at springe. Taler to i munden på hinanden i en lydfil, kan Gemini nu transskribere den. Før stoppede den med en fejl. Lydimport gennem ChatGPT er ikke færdig endnu, og det siger programmet nu i stedet for at melde klar. Det store overblik under Struktur bruger tekstens første rigtige linje som titel og ikke en skjult markering.

## [0.2.17] - 2026-10-17

Stiltjekket fanger flere fejl i retskrivningen. Det ser for eksempel »igang«, der skal stå som »i gang«, »ned af trappen«, hvor der menes »ned ad«, og »3 årig« uden bindestreg. Papirord bliver markeret, og det samme gør »omkring«, når du bare mener »om«. Med »Alle forslag« slået til følger stiltjekket også dit kommasystem, når teksten tydeligt bruger et andet end det, du har valgt. Så markerer det kun de steder, hvor du afviger. Har du valgt at skjule markdown-tegnene helt, springer markøren nu hen over dem.

## [0.2.16] - 2026-10-16

Synk hedder nu Synkronisering. Har du slettet en tekst på pc’en eller telefonen, ligger den i papirkurven på serveren i 30 dage. Du henter den tilbage under Indstillinger › Synkronisering. Installeren viser nu licensen, og hvad programmet sender, før den går i gang.

## [0.2.15] - 2026-10-15

Microsoft Defender kunne fjerne Gode Tekster lige efter opdateringen til 0.2.14. Er programmet væk fra din pc, så hent det igen her. Dine tekster er ikke rørt. Start med Windows bruger nu igen Windows’ almindelige startliste.

## [0.2.14] - 2026-10-15

Under Struktur planlægger du teksten i dele og flytter rundt på dem. Kilder og henvisninger står i selve filen og kommer med i print og Word efter APA 7. Har en kilde et DOI, henter programmet resten selv. Ctrl+H viser alle dine noter, og du kan hente en slettet note tilbage fra papirkurven. Bliver en lydoptagelse afbrudt, ligger der en nødkopi, du kan gemme. Stiltjekket viser kun de sikre fund, til du beder om flere. Er et fund ikke nyttigt, så højreklik og fjern det. I forhåndsvisningen kopierer du med eller uden markdown. Fed og kursiv virker nu på lister. I en tabel giver Shift+Enter en ny linje i cellen, og siden står stille, mens du skriver.

## [0.2.11] - 2026-10-09

Gode Tekster har fået sit eget udseende med en ny skrift og en aftenudgave, der slår til ved solnedgang. Programmet har også et nyt ikon. Biblioteket viser status på dine tekster, og du kan søge på #tags. En deadline kan nu have et klokkeslæt. Win+Alt+N lægger en note på skrivebordet, og den bliver liggende, når du viser skrivebordet. Ctrl+P åbner en roligere forhåndsvisning til print, PDF og Word, og under Design lægger du selv forfatter, dato og sidetal, hvor du vil have dem. Højreklik giver forslag til stavefejl og stilfund og kan sætte fodnoter, tabeller og billeder ind. Versioner viser, hvor i teksten du har skrevet, og hvor mange ord der er kommet til. I faktatjekket krydser du en påstand af, når du har taget stilling til den.

## [0.2.10] - 2026-10-08

Stiltjekket finder nu fejl i køn og bøjning, som »en hus« og »et stor hus«. Det tjekker også kommaer efter dit eget valg: med startkomma, uden startkomma eller slet ikke. Vælg under Indstillinger › Tekst. Har dit længdemål en frist, står der nu, hvor mange dage der er til deadline.

## [0.2.9] - 2026-10-07

Sæt et længdemål med frist i hjørnet nederst til højre. Noter og rettelser kommer med i Word som kommentarer og sporede ændringer. Stiltjekket finder nu også fejl med nutids-r og dobbelte ord.

## [0.2.8] - 2026-10-07

Research og faktatjek er lettere at læse, med kildens navn forrest. Kommandoer ligger nu under Indstillinger, og du kan selv vælge, hvordan markdown vises. Højreklik på en tekst for at kopiere stien eller vise den i Stifinder.

## [0.2.7] - 2026-10-07

Word-filer ligner nu skærmen: din skrift, luftig linjeafstand og brede margener. Et nyt vindue viser de seneste tekster som små ark. Tabeller redigeres direkte i cellerne, og Renskriv retter i selve teksten. Mistral kan vælges som AI-hjælp.

## [0.2.6]

Indstillinger er lavet om: tre faner, Generelt, Tekst og AI-hjælp, med én indstilling pr. linje.

## [0.2.5]

Tabeller vises som tabeller. Søgning i alle tekster er langt hurtigere. Markér tekst og skriv /, så gælder kommandoen det markerede, og en ny kommando beskriver du med egne ord. I Ro på kan spalterne hentes frem, og en knap slukker wifi.

## [0.2.4]

Egne kommandoer og skabeloner med /. Skriv / i starten af en linje, og vælg for eksempel /dato, /interview eller /faktaboks. 27 følger med, og du kan lave dine egne.

## [0.2.3]

Ro på: F11 giver fuld skærm med kun teksten, og musemarkøren forsvinder, mens du skriver. Wifi kan slukkes imens. Roligere udseende med titellinjen i programmets farve.

## [0.2.1]

Nye tekster får navn efter første linje. Højreklik på ikonet på proceslinjen viser stjernemarkerede og seneste tekster. Nummererede overskrifter fortsætter med næste nummer.

## [0.2.0]

Gode Tekster kan bruges på engelsk. Sproget følger Windows og kan skiftes under Indstillinger.

## [0.1.9]

Nye introtekster og bedre brug af biblioteket.

## [0.1.8]

Gode Tekster er nu åben kildekode under GPL-3.0.

## [0.1.7]

Bedre stavekontrol. Kan hentes uden installation.

## [0.1.6]

Ny fane: Sprog med ordklasser og stiltjek. Roligere layout.

## [0.1.5]

Faktatjek fungerer bedre.

## [0.1.4]

Generelle forbedringer II.

## [0.1.2]

Generelle forbedringer.

## [0.1.0]

Første udgave.

Udgaverne før 0.2.7 har ingen dato her: historikken før 7/10-2026 er ikke offentlig.
