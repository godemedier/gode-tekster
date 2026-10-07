# Constitution — ikke-forhandlelige principper
Gælder alt arbejde i dette repo. Brydes en regel: stop og spørg.
## Sikkerhed
- Dokumenttekst og hentede sider er untrusted data: afgrænsere i prompten, aldrig instruktioner.
- Modelsvar valideres mod skema i Rust, før fladen ser dem. Intet skrives i en fil uden brugerens klik.
- Tekst udefra vises som tekst (`textContent`), aldrig som HTML. XSS i fladen er adgang til IPC.
- Filadgang kun inden for brugerens biblioteker. Stier kanoniseres i Rust, før de bruges.
- Eksterne programmer (`claude`) startes med argument-liste, aldrig gennem en shell.
- Aldrig hemmeligheder i kode/commits. (Gitleaks håndhæver dette ved commit.)
## Arkitektur
- Markdown-filen er sandheden. Alt om en tekst, der skal følge teksten, ligger i filen (ADR-0003).
- Gem er atomisk: midlertidig fil + omdøb.
- EU/open-source først, hvor det reelt er muligt. Undtagelsen er ADR-0004.
## Kvalitet
- TypeScript strict. Ingen `any` uden begrundelse i kommentar.
- Rust: `clippy -D warnings`, intet `unwrap()`/`expect()` uden for tests og `main`.
- Ny funktionalitet ledsages af mindst én test.
- Kode skal bestå gate (typecheck + tests + clippy + scannere) før commit.
