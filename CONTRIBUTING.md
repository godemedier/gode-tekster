# Contributing to Gode Tekster

*[Dansk nedenfor](#dansk)*

Gode Tekster is a one-person project. I read everything, but I can't promise to fix it or answer
right away.

## Bugs and ideas

Open an [issue](https://github.com/godemedier/gode-tekster/issues), or write to
troels@godemedier.dk. The speech bubble in the bottom left corner of the app sends a message too.

A good bug report says what you did, what you expected and what happened instead, plus the version
number at the bottom of Settings. Never attach a text you don't want others to read: issues are
public.

## Code

GitHub is a mirror of Gode Medier's own git server, where the work happens. A pull request here can't be merged directly, but I can read it and apply
the change by hand with credit in the commit. Open an issue first if the change is bigger than a
bug fix, so you don't build something that falls outside [`STRATEGI.md`](STRATEGI.md).

Before you start, read [`AGENTS.md`](AGENTS.md). It's the working contract, and it applies equally
to people and AI agents. In short:

- `npm test` must pass (TypeScript and Rust). The commit hook also runs `cargo fmt`, `cargo clippy
  -D warnings`, gitleaks and osv-scanner.
- No `unwrap()` or `expect()` outside tests. Rust commands return `Result<T, String>` with a
  message the user can read.
- The interface gets no new permissions. Everything that touches files or the network goes
  through a Rust command.
- New dependencies must be widely used and maintained. Run `node scripts/licenser.mjs` afterwards,
  or the release stops.
- Load-bearing decisions go in the ADR log in [`ARKITEKTUR.md`](ARKITEKTUR.md).
- UI text is Danish first, with English alongside in `src/i18n.ts`. Code identifiers are English.

### A note on the documents

The ADRs in `ARKITEKTUR.md` sometimes mention lessons numbered `L-123` or link to `docs/plans/`
and `docs/research/`. Those are my private working notes and lessons, kept in a separate
repository. The decisions they led to are written out in the ADRs themselves, so you don't need
them. Everything that applies to this repository is in `AGENTS.md`.

User-visible changes go in [`CHANGELOG.md`](CHANGELOG.md). Everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md).

---

## Dansk

Gode Tekster er et enmandsprojekt. Jeg læser alt, men kan ikke love at rette det eller svare med
det samme.

**Fejl og idéer:** opret et [issue](https://github.com/godemedier/gode-tekster/issues), eller skriv
til troels@godemedier.dk. Taleboblen nederst til venstre i programmet sender også en besked.
Skriv, hvad du gjorde, hvad du ventede, og hvad der skete, og tag versionsnummeret med nederst i
Indstillinger. Vedhæft aldrig en tekst, andre ikke må læse. Issues er offentlige.

**Kode:** GitHub er et spejl af Gode Mediers egen git-server.
En pull request kan ikke flettes her, men jeg kan læse den og lægge ændringen ind i hånden med
din kredit i commit'en. Er ændringen større end en fejlrettelse, så opret et issue først. Læs
[`AGENTS.md`](AGENTS.md), før du går i gang. Den gælder både mennesker og AI-agenter.

ADR'erne i `ARKITEKTUR.md` nævner nogle gange lektioner som `L-123` eller linker til
`docs/plans/` og `docs/research/`. Det er mine private arbejdsnoter i et andet repo.
Beslutningerne står i ADR'erne selv, og alt, der gælder her, står i `AGENTS.md`.
Ændringer, brugerne kan mærke, skrives i [`CHANGELOG.md`](CHANGELOG.md), og alle følger
[adfærdskodekset](CODE_OF_CONDUCT.md).
