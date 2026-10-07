# Introfilm til Gode Tekster – storyboard

60 sekunder, 30 billeder i sekundet. To formater af de samme scener: 1:1 (1080 × 1080) og 16:9
(1920 × 1080).

Udtryk: lys flade (#f7f7f7), blæk (#2b2b2b), grå (#6b6b6b), programmets blå markør (#1aa3ff) og
Gode Mediers røde (#db5230) som eneste accent. Al tekst er IBM Plex Mono, undtagen teksten i
scene 10, der står i programmets IBM Plex Serif. Overskrifter bliver skrevet tegn for tegn med
markør, og markøren glider tilbage ved linjeskift som en vognretur.

Scenerne er bygget forskelligt, så filmen ikke går i samme takt hele vejen:

- **Hel flade:** scene 1 (stor skrift), scene 2 (en hel programflade), scene 9 (gitter) og 11.
- **Delt:** tegning og tekst hver for sig. I 16:9 står teksten skiftevis til venstre og til højre.
  I 1:1 står den skiftevis under og over tegningen (scene 4 og 7 er vendt).
- **Tempo:** scene 1 og 2 er langsomme, scene 3 og 4 korte, scene 9 er lynhurtig.
- **Overgange:** papiret rykker op, vognen rykker til siden, en lodret streg kører hen over
  billedet som en vognretur, og ét hårdt klip ind i scene 9.

Øverst står »Gode Tekster« med en lille rød firkant og 11 streger, der viser, hvor i filmen man er
(fra scene 2 til 10).

## Scener

| # | Tid | På skærmen | Tekst |
|---|---|---|---|
| 1 | 0,0–7,5 | Hel flade, stor skrift. Første sætning bliver skrevet. Så falmer den til grå, og anden sætning bliver skrevet under. En rød streg tegnes under »Gode Tekster«. | **Endelig et skriveprogram, der giver dig ro til at skrive.** · **Fordi Gode Medier kræver Gode Tekster.** |
| 2 | 7,5–14,0 | En programflade i streg: værktøjslinje med knapper, panel til venstre og højre, statuslinje, tekst i midten. Knapperne falder én ad gangen, panelerne glider ud, rammen forsvinder. Tilbage står teksten og markøren, og teksten breder sig ud. Første sætning falmer, når anden bliver skrevet. | **Rolig skriveflade uden for mange valg, der distraherer.** · **Og fokus på det vigtige.** |
| 3 | 14,0–18,4 | Seks streger som tekstlinjer. En sætning midt i bliver markeret blå og falmer til lysegrå. | **Dæmp i stedet for at slette** · Er du i tvivl om en sætning, dæmper du den bare. |
| 4 | 18,4–22,8 | Tekstlinjer og en rude mærket »Fraklip«. To linjer glider over i ruden, resten lukker hullet. Til sidst glider de tilbage. | **Træk tekst over i fraklip** · Så kan du altid trække det tilbage igen. |
| 5 | 22,8–28,1 | Der bliver tastet »/«, og en liste glider frem: /interview, /faktaboks, /dato, /kilde. Der tastes »int«, listen snævrer ind, Enter. En skabelon lander med overskriften »Interview«, feltet »Dato«, der bliver udfyldt med »5. oktober 2026«, og tre linjer, der vokser frem. | **Dine egne kommandoer med /** · Skabeloner og genveje, du selv bestemmer. |
| 6 | 28,1–33,7 | Én fil, »Mit nye inputapparat.md«. Tre grene tegnes ud fra den, og en prik løber ud ad hver: Notesblok, Word, Din chatbot. | **Teksterne er almindelige filer** · Kan åbnes af alt fra Notesblok til Word. Og optimeret til at blive forstået af din chatbot. |
| 7 | 33,7–38,3 | Sætningen »Jeg tog mig selv i at researche på østtyske skrivemaskiner.« Navneord bliver rødbrune, udsagnsord blå, resten grå. Under den: »Navneord 1«, »Udsagnsord 2« og en todelt bjælke. | **Se, hvordan teksten er skruet sammen** · Ordklasser i farver og et stiltjek med LIX. |
| 8 | 38,3–43,5 | Påstanden »Jean-Dominique skrev sine erindringer ved at blinke med sit venstre øjenlåg« bliver markeret gul. To kilder tegnes under den, hver med en blå ring og en pil. | **Faktatjek med kilder, du selv kan åbne** · Kører på dit eget abonnement på Claude, ChatGPT eller Gemini. |
| 9 | 43,5–48,7 | Hårdt klip. 18 funktioner lander i et gitter, én for hver 0,115 sekund (to kolonner i 1:1, tre i 16:9). Den nyeste står fed et øjeblik. Til sidst står alle i knap to sekunder, og »Gratis« har rød markering. | **Og alt det andet** · Ro på (F11) · Stavekontrol · Versioner · Fodnoter · Disposition · Fokus på afsnittet · Noter til dig selv · Print og PDF · Gem som Word · Åbner Word-filer · Renskriv interviewnoter · Stiltjek og LIX · Lister med a) b) c) · Stjerner i biblioteket · Søg i alle tekster · Dansk og engelsk · Opdaterer sig selv · Gratis |
| 10 | 48,7–54,5 | Skrivemaskinetilstand: Teksten bliver skrevet lynhurtigt (105 tegn i sekundet) i serif. Linjen, der skrives, bliver stående i samme højde over en tynd streg, og teksten rykker op og bliver grå. | **Programmet skriver aldrig for dig** · At skrive er at tænke. Det skal vi værne om. |
| 11 | 54,5–60,0 | Slutbillede. Navnet bliver skrevet, en kort rød streg tegnes under, resten toner frem. | **Gode Tekster** · Gratis til Windows · tekster.godemedier.dk · Lavet af Gode Medier |

Teksten i scene 10 og sætningerne i scene 7 og 8 er ordrette fra teksten »Mit nye inputapparat:
En forelskelse«. I scene 8 er sætningen klippet til i begge ender, uden at ordene er ændret.
Ordklassetallene i scene 7 er talt i hånden.

## Det, der er lavet til at blive ændret

Alt står som konstanter øverst i `film.html`. Ret dem, og kør `node render.mjs` igen.

- `SLASH`: kommandoerne i scene 5 (`commands`, `typed`, `title`, `dateLabel`, `date`). `typed` skal
  være begyndelsen af præcis én af kommandoerne. Tiderne står i `SLASH_T`.
- `FUNCTIONS`: listen i scene 9, i den rækkefølge de lander. Den sidste får rød markering.
- `TYPE_TEXT`: teksten i scene 10.
- `T` og `TR`: scenernes tider og overgangene mellem dem.

## Lyd

Filmen virker uden lyd. LinkedIn afspiller uden lyd, og intet i billedet afhænger af den.
Lydsporet er lydeffekter, ingen musik, og det ligger lavt (toppe ved -20 dBFS):

- **Tastetryk:** et blødt, dæmpet dunk som en tast med filt under. En lav tone (omkring 110 Hz)
  med kort krop og kun lidt mørk støj i anslaget. Tonehøjde og styrke varierer fra slag til slag.
  Ét pr. tegn i de skrevne overskrifter, ét pr. funktion i scene 9.
- **Hurtig skrift:** i scene 10 en jævn, blød trommen i stedet for ét slag pr. tegn. Datoen i
  scene 5 får et svagt slag for hvert andet tegn.
- **Linjeskift og vognretur:** et mørkt, blødt strøg og et dæmpet stop. Bruges også, når stregen
  kører hen over billedet mellem to scener.
- **Sceneskift:** et kort papirsus, når papiret rykker op eller til siden. Klippet ind i scene 9
  har ingen lyd.
- **Tone:** én blød, dyb tone, når navnet står færdigt på slutbilledet.
- **Rumtone:** en næsten uhørlig brun støj under det hele, med korte fades i begge ender.

Alle lyde er syntetiseret i `render.mjs` (filtreret støj og sinustoner). Der er ikke hentet
lydfiler nogen steder fra. Tiderne kommer fra `FILM.events` i `film.html`, altså de samme tal, der
styrer, hvornår tegnene bliver tegnet.

## Filer

- `film.html` – hele animationen. `?format=1x1` eller `?format=16x9`, og `&t=12.5` for ét billede.
- `render.mjs` – `node render.mjs` laver begge MP4-filer og stillbillederne i `stills\`.
- `gode-tekster-1x1.mp4` og `gode-tekster-16x9.mp4` – H.264, yuv420p, 30 billeder i sekundet, AAC 48 kHz stereo.
