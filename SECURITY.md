# Security

*Dansk nedenfor.*

If you find a security issue in Gode Tekster, write to troels@godemedier.dk instead of opening a
public issue. Describe what you found and how to reproduce it. I'll answer as soon as I can and
tell you when a fix is out.

Only the newest version is supported. The app updates itself, so a fix reaches users within six
hours of release, once they close the app.

What counts as a security issue here, for example:

- the interface reading or writing files outside the user's libraries
- text from a document or a fetched web page making the language model act on it
- an update being accepted without a valid signature
- the app sending document text anywhere the user didn't choose

The security model is described in [`AGENTS.md`](AGENTS.md) under »Sikkerhed i dette projekt«
and in ADR-0022 in [`ARKITEKTUR.md`](ARKITEKTUR.md).

---

**Dansk:** Finder du et sikkerhedshul, så skriv til troels@godemedier.dk i stedet for at oprette
et offentligt issue. Beskriv, hvad du fandt, og hvordan det kan gentages. Kun den nyeste version
understøttes. Programmet opdaterer sig selv, så en rettelse når ud inden for seks timer, når
brugerne lukker programmet.
