# Gode Tekster

A free writing app for Windows. You write in markdown, and the text is formatted as you type.
Sentences you're unsure about can be dimmed instead of deleted. Your texts stay ordinary `.md`
files in your own folders: no account, no database, no cloud.

When you ask for it, the app can trim, fact-check and clean up a text through your own
subscription with Claude, ChatGPT, Gemini or Mistral. Nothing changes in your file until you
click.

The interface is in Danish or English. The style check and the parts-of-speech colours only work
in Danish.

**[Dansk udgave af denne side](README.da.md)** · **[Download](https://tekster.godemedier.dk)**

![Gode Tekster with the outline on the left, a dimmed sentence, a footnote and a note in the text, and Clippings on the right](docs/billeder/skrivning.webp)

## Download

Get it at [tekster.godemedier.dk](https://tekster.godemedier.dk). There's an installer and a
portable version that runs without installation. Both update themselves quietly when you close
the app.

The program isn't code-signed yet, so Windows may warn you the first time. The download page
explains what to do.

## What it does

- **Live preview.** Markdown characters hide when the cursor isn't on the line. Tables are shown
  as tables and edited directly in the cells.
- **Dimming, clippings and notes.** Dimmed text is grey and left out of the word count, exports
  and print. Clippings hold what had to go. Notes to yourself and footnotes live in the file.
- **Plain files.** Reads and writes iA Writer's authorship annotations, so files can go back and
  forth between the two programs.
- **Never loses text.** Saves 1.5 seconds after you pause. Every save is atomic (temporary file,
  then rename). Earlier versions are kept, and if another program changes the file while it's
  open, the two versions are merged or you're asked first.
- **Slash commands.** Type `/` for templates and commands. Missing one? Describe it in words, and
  the language model sets it up for you to preview before you save.
- **Calm.** Focus mode, typewriter scrolling and Quiet mode (full screen, Wi-Fi off until you
  leave).
- **Out the door.** Print, PDF and Word with templates. Word files can be dragged in and become
  markdown.
- **Search** in the open text or in all your libraries at once.

The full user guide ships with the app and is in
[`src-tauri/welcome/vejledning.en.md`](src-tauri/welcome/vejledning.en.md).

## Privacy

- Your texts never pass through Gode Medier. AI requests go from your computer straight to the
  provider you picked, through your own login or key.
- Gemini and Mistral keys are stored in Windows Credential Manager, not in a file.
- The app asks `tekster.godemedier.dk` for updates two minutes after start and every six hours.
  The server sees the version number and your IP address.
- Feedback is only sent when you write it. After a crash, the app asks once whether the error log
  may be sent. The log never contains text from your documents.
- The server stores nothing. The full statement is at
  [tekster.godemedier.dk/privatliv](https://tekster.godemedier.dk/privatliv) (Danish).

## Build it yourself

You need Windows, Node 24, Rust (`winget install Rustlang.Rustup`) and Microsoft C++ Build Tools
with the C++ workload. Open a new terminal after installing Rust, or `cargo` won't be found.

```
npm install            # install dependencies and arm the commit check
npm run tauri dev      # run the app with hot reload
npm test               # typecheck and tests (TypeScript and Rust)
npm run tauri build    # build the installer (src-tauri/target/release/bundle/nsis/)
```

## How it's built

| Layer | Choice |
|---|---|
| Shell | [Tauri 2](https://tauri.app): a Rust core and a WebView2 window. Windows only |
| Core (`src-tauri/src/`) | Rust: files, libraries, history, merging, export, calls to the language models |
| Interface (`src/`) | TypeScript and Vite. No UI framework |
| Editor | [CodeMirror 6](https://codemirror.net) with a custom live-preview extension |

The interface can only do what the Rust commands offer. It has no file system or shell
permissions, the Content Security Policy allows no remote scripts, and `claude.exe` and
`codex.exe` are started with an argument list, never through a shell. Document text and fetched
web pages are treated as data in prompts, never as instructions.

Most of the code is written with [Claude Code](https://claude.com/claude-code) under my direction.
The commit history shows which commits.

## Documentation

The project documents are in Danish. They're written to be read by both people and AI agents.

| File | What's in it |
|---|---|
| [`STRATEGI.md`](STRATEGI.md) | Why the app exists, who it's for, and what it deliberately won't do |
| [`ARKITEKTUR.md`](ARKITEKTUR.md) | How it runs, plus the decision log (ADR-0001 onwards) |
| [`AGENTS.md`](AGENTS.md) | The working contract for anyone, human or AI, changing the code |
| [`docs/struktur.md`](docs/struktur.md) | The file tree, module by module |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to report bugs and suggest changes |
| [`SECURITY.md`](SECURITY.md) | How to report a security issue |

## Contributing

Bug reports and ideas are welcome as [GitHub issues](https://github.com/godemedier/gode-tekster/issues)
or by mail to troels@godemedier.dk. This repository is a mirror of
Gode Medier's own git server, so pull requests can't be merged here directly. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Copyright © 2026 Gode Medier v/ Troels Kølln.

Gode Tekster is free software under the GNU General Public License version 3 (GPL-3.0-only). You
may use, change and share it, including at work. If you share a modified version, it must be
under the same licence and come with its source code. The full text is in [LICENSE](LICENSE).

The name Gode Tekster and the logo aren't covered by the licence (GPL-3.0 section 7e). A modified
version must have its own name.

The components the app is built on have their own licences, listed in
[`src-tauri/resources/LICENSES.txt`](src-tauri/resources/LICENSES.txt). The parts-of-speech list
and the agreement data for the grammar check are built from UD Danish-DDT and are under CC BY-SA 4.0.
