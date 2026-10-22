// Ét åbent dokument: indlæsning, automatisk gem og værnet mod at overskrive rettelser udefra
// (ADR-0013). Gemmer 1,5 s efter sidste tastetryk, ved fokustab og ved luk.

import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";

import { isolateHistory, undo } from "@codemirror/commands";

import { authorshipField, setAuthorship, type Author, type Authorship, type Span } from "./editor/authorship.ts";
import { createState } from "./editor/setup.ts";
import { setImageBase } from "./editor/images.ts";
import { errorText, hideBanner, notify, showBanner, type Action } from "./ui/banner.ts";
import { tr } from "./i18n.ts";

export type DocumentDto = {
  path: string;
  name: string;
  text: string;
  authors: Authorship[];
  me: Author;
  staleBlocks: Span[];
  mixedEol: boolean;
  /** Fremmede bytes i en UTF-8-fil, læst som Windows-1252 (Rust, `files::mostly_utf8`). */
  repaired: number;
  cursor: number | null;
  hasBlock: boolean;
  external: Span[];
};

type SaveError = { kind: string; message: string };
type SaveOptions = { allowEolNormalize?: boolean; overwriteExternal?: boolean; forceUtf8?: boolean };

const AUTOSAVE_MS = 1500;
/** Pauserne mellem nye forsøg, når filen er låst et øjeblik (Word, OneDrive, en virusscanner). */
const RETRY_MS = [2000, 5000, 15000];

/**
 * Teksten står kun i backup, ikke i filen. Afslut og luk spørger så først. Før lukkede programmet
 * alligevel, og ved næste start åbnede den gamle udgave (fejljagt 19/10).
 */
export class NotSaved extends Error {}
export type SessionIO = { invoke: typeof invoke; showBanner: typeof showBanner; hideBanner: typeof hideBanner; notify: typeof notify };
const sessionIO: SessionIO = { invoke, showBanner, hideBanner, notify };

export class DocumentSession {
  private timer: number | undefined;
  private dirty = false;
  private saving: Promise<void> | null = null;
  /** Sat, når et gem kræver et valg. Autosave venter så. */
  private blocked = false;
  private allowEol = false;
  /** Mens en gammel version vises, gemmes intet (ellers ville den gamle tekst blive gemt). */
  private paused = false;
  /** Teksten, som den sidst stod på disken (indlæst eller gemt). Grundlaget for at flette. */
  private base: string;
  /** Mens en rettelse udefra flettes ind, er ændringen ikke brugerens, og der gemmes ikke. */
  private syncing = false;
  private merging: Promise<void> | null = null;
  /** Nummeret på sessionens egen besked, så den kun skjuler sine egne (ui/banner.ts). */
  private bannerId = -1;
  private closed = false;
  private closing = false;
  private retries = 0;
  /** Teksten i den seneste backupkopi, så en pause uden nye rettelser ikke giver en kopi mere. */
  private backedUp: string | null = null;

  private show(message: string, actions: Action[] = []): void {
    // Sessionens forrige besked er forældet, når en ny kommer.
    this.io.hideBanner(this.bannerId);
    this.bannerId = this.io.showBanner(message, actions, { perText: true });
  }

  private hide(): void {
    this.io.hideBanner(this.bannerId);
  }

  /** Beskeden om en rettelse udefra står. Den forsvinder, når brugeren skriver videre. */
  private notice = false;

  private view: EditorView;
  private dto: DocumentDto;
  /** Lytteren fra load, så en genindlæsning ikke mister højre spalte og autosave. */
  private onChange: () => void;
  private readonly io: SessionIO;

  constructor(view: EditorView, dto: DocumentDto, onChange: () => void, io: SessionIO = sessionIO) {
    this.io = io;
    this.view = view;
    this.dto = dto;
    this.onChange = onChange;
    this.base = dto.text;
  }

  static load(view: EditorView, dto: DocumentDto, onChange: () => void): DocumentSession {
    setImageBase(dto.path);
    view.setState(createState(dto.text, { authors: dto.authors, me: dto.me, pasted: [], external: dto.external }, dto.cursor, onChange));
    view.dispatch({ effects: [], scrollIntoView: true });
    const session = new DocumentSession(view, dto, onChange);
    session.offerStaleCleanup();
    if (dto.repaired > 0) {
      const n = dto.repaired;
      notify(
        n === 1
          ? tr("Et tegn i filen stod i et andet tegnsæt (Windows-1252). Det bliver gemt som UTF-8 som resten af teksten.", "One character in the file was in another encoding (Windows-1252). It will be saved as UTF-8 like the rest of the text.")
          : tr(`${n} tegn i filen stod i et andet tegnsæt (Windows-1252). De bliver gemt som UTF-8 som resten af teksten.`, `${n} characters in the file were in another encoding (Windows-1252). They will be saved as UTF-8 like the rest of the text.`),
      );
    }
    return session;
  }

  get path(): string {
    return this.dto.path;
  }

  /** Der er rettelser, som ikke er gemt i filen. */
  get unsaved(): boolean {
    return this.dirty;
  }

  /** Teksten har fået nyt navn af programmet selv (rename_open_document): gem videre i den nye fil. */
  renamed(to: string): void {
    this.dto = { ...this.dto, path: to, name: to.slice(to.lastIndexOf("\\") + 1) };
    setImageBase(to);
  }

  changed(): void {
    if (this.paused || this.syncing || this.closed) return;
    if (this.notice) {
      // »Fortryd rettelsen« ville nu fortryde det, brugeren lige har skrevet.
      this.notice = false;
      this.hide();
    }
    this.dirty = true;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      if (this.closed) return;
      if (this.blocked) void this.backup().catch((e: unknown) => this.show(errorText(e)));
      else void this.save();
    }, AUTOSAVE_MS);
  }

  /** Gemmer nu, hvis der er noget at gemme. Bruges ved fokustab, luk og skift af fil. */
  async flush(): Promise<void> {
    if (this.paused) return;
    window.clearTimeout(this.timer);
    if (this.merging) await this.merging;
    if (this.saving) await this.saving;
    if (this.dirty && !this.blocked) await this.save();
    window.clearTimeout(this.timer);
  }

  /** Versioner: gem nu, og hold autosave på pause, mens en gammel udgave vises. */
  async pause(on: boolean): Promise<void> {
    if (on) await this.saveForHandoff();
    this.paused = on;
  }

  /**
   * Før en anden fil åbnes: gem, og kan det ikke lade sig gøre, læg teksten i backup. Uden `force`
   * kastes `NotSaved`, når teksten kun nåede backup.
   */
  async close(force = false): Promise<void> {
    await this.prepareExit(force);
    await this.io.invoke("release_document", { path: this.dto.path });
    this.closed = true;
    this.hide();
  }

  async prepareExit(force = false): Promise<void> {
    this.closing = true;
    try {
      await this.flush();
      if (this.dirty) {
        await this.backup();
        if (!force) {
          throw new NotSaved(
            tr(
              "Teksten er ikke gemt i filen. En kopi ligger i programmets backup-mappe.",
              "The text is not saved in the file. A copy is in the app's backup folder.",
            ),
          );
        }
      }
    } finally {
      this.closing = false;
    }
  }

  /** Lægger teksten i backup. Falsk, når den samme tekst allerede ligger dér. */
  private async backup(): Promise<boolean> {
    let wrote = false;
    for (;;) {
      const text = this.view.state.doc.toString();
      if (text === this.backedUp) return wrote;
      await this.io.invoke("backup_text", { path: this.dto.path, text });
      this.backedUp = text;
      wrote = true;
    }
  }

  /** Et andet vindue eller en genindlæsning skal kunne læse de seneste rettelser fra filen. */
  async saveForHandoff(): Promise<void> {
    await this.flush();
    if (this.dirty) throw new Error(tr("Teksten kunne ikke gemmes. Vinduet bliver åbent, så du kan prøve igen.", "The text could not be saved. The window stays open so you can try again."));
  }

  prepareReload(): Promise<void> {
    return this.saveForHandoff();
  }

  private async save(opts: SaveOptions = {}): Promise<void> {
    if (this.saving) {
      await this.saving;
      if (!this.dirty) return;
    }
    this.saving = this.doSave(opts).finally(() => {
      this.saving = null;
    });
    return this.saving;
  }

  private async doSave(opts: SaveOptions): Promise<void> {
    // En lukket session skriver aldrig: skrivefladen viser måske allerede en anden tekst
    // (kodegennemgang 20/10, tekst B endte i fil A).
    if (this.closed) return;
    const state = this.view.state;
    const authors = this.dto.hasBlock ? state.field(authorshipField).authors : [];
    const text = state.doc.toString();
    this.dirty = false;
    try {
      await this.io.invoke("save_document", {
        req: {
          path: this.dto.path,
          text,
          authors,
          cursor: state.selection.main.head,
          allowEolNormalize: this.allowEol || !!opts.allowEolNormalize,
          overwriteExternal: !!opts.overwriteExternal,
          forceUtf8: !!opts.forceUtf8,
        },
      });
      if (opts.allowEolNormalize) this.allowEol = true;
      this.base = text;
      // Et gem kan være en ny version: fanen Versioner tegnes om (ikke ved hvert tastetryk).
      window.dispatchEvent(new Event("gt-versions"));
      // Telefonen skriver »Gemt«, når gemmet er lykkedes, ikke på et ur (fejljagt F4-M2).
      if (this.base === this.view.state.doc.toString()) window.dispatchEvent(new CustomEvent("gt-saved", { detail: this.dto.path }));
      this.blocked = false;
      this.retries = 0;
      this.hide();
    } catch (e) {
      this.dirty = true;
      this.handleError(e as SaveError);
    }
  }

  /** Filen er låst et øjeblik: prøv igen om lidt, så længe der er noget at gemme. */
  private retryLater(): void {
    const ms = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      if (this.dirty && !this.blocked && !this.closed && !this.paused) void this.save();
    }, ms);
  }

  private handleError(err: SaveError): void {
    // En låst fil eller en anden kortvarig fejl går over af sig selv. Før stoppede ét mislykket
    // autogem al autogem resten af sessionen (fejljagt 19/10).
    const transient = err.kind === "io" || err.kind === "locked";
    this.blocked = !transient;
    if (transient && !this.closing) this.retryLater();
    // Blandede linjeskift og tegnsæt er valg, ikke fejl: teksten står stadig i editoren.
    if (err.kind !== "changed-on-disk" && err.kind !== "moved" && err.kind !== "mixed-eol" && err.kind !== "unencodable") {
      void this.backup()
        .then((wrote) => {
          if (wrote && !this.closed) this.io.notify(tr("En kopi af teksten er gemt i programmets backup-mappe.", "A copy of the text is saved in the app's backup folder."));
        })
        .catch((e: unknown) => {
          if (!this.closed) this.show(errorText(e));
        });
    }
    switch (err.kind) {
      case "changed-on-disk":
        // Opdaget først ved gem: flet som ved enhver anden rettelse udefra.
        this.blocked = false;
        void this.externalChange();
        break;
      case "mixed-eol":
        this.show(tr("Filen har blandede linjeskift. De bliver ensrettet, når du gemmer.", "The file has mixed line breaks. They are made consistent when you save."), [
          { label: tr("Ensret og gem", "Make consistent and save"), run: () => this.save({ allowEolNormalize: true }) },
        ]);
        break;
      case "unencodable":
        this.show(tr("Teksten har tegn, som filens gamle tegnsæt ikke kan gemme.", "The text has characters that the file's old encoding can't save."), [
          { label: tr("Gem som UTF-8", "Save as UTF-8"), run: () => this.save({ forceUtf8: true }) },
        ]);
        break;
      case "moved": {
        // Omdøbt eller flyttet i mappen udefra (Rust fandt den på indholdet): følg med og gem igen.
        const from = this.dto.path;
        this.dto = { ...this.dto, path: err.message };
        this.blocked = false;
        window.dispatchEvent(new CustomEvent("gt-moved", { detail: { from, to: err.message } }));
        const newName = err.message.slice(err.message.lastIndexOf("\\") + 1);
        notify(tr(`Filen er omdøbt udefra. Der gemmes nu i ${newName}.`, `The file was renamed outside the app. It now saves to ${newName}.`));
        void this.save();
        break;
      }
      case "gone":
        this.show(tr("Filen findes ikke længere her. Er den flyttet, så åbn den, hvor den ligger nu.", "The file is no longer here. If it was moved, open it where it is now."), [
          { label: tr("Gem den her igen", "Save it here again"), run: () => this.save({ overwriteExternal: true }) },
        ]);
        break;
      default:
        this.show(err.message || tr("Teksten kunne ikke gemmes.", "The text could not be saved."), [
          { label: tr("Prøv igen", "Try again"), run: () => this.save() },
          {
            label: tr("Gem en kopi", "Save a copy"),
            run: async () => {
              await this.io.invoke("backup_text", { path: this.dto.path, text: this.view.state.doc.toString() });
              this.io.notify(tr("En kopi af teksten er gemt i programmets backup-mappe.", "A copy of the text is saved in the app's backup folder."));
            },
          },
        ]);
    }
  }

  /**
   * Filen er væk fra disken (filovervågningen, fejljagt F4-M6). Et gem finder den, hvis den er
   * omdøbt i mappen, og ellers kommer beskeden med det samme i stedet for ved næste gem.
   */
  fileGone(): void {
    if (this.paused || this.closed || this.closing) return;
    void this.save();
  }

  /**
   * Filen er rettet udefra (filovervågningen, fokus-tjekket eller et gem, der opdagede det).
   * Rettelserne flettes ind som almindelige ændringer, så markør, rulning og fortryd overlever,
   * og det nye får en stiplet streg. Står der egne rettelser på samme linje, vælger brugeren (2/10).
   */
  externalChange(): Promise<void> {
    if (this.paused || this.closed || this.closing) return Promise.resolve();
    this.merging ??= this.mergeExternal().finally(() => {
      this.merging = null;
    });
    return this.merging;
  }

  private async mergeExternal(): Promise<void> {
    if (this.saving) await this.saving;
    // Intet må gemmes, mens den nye udgave hentes, ellers kunne den blive overskrevet.
    const wasBlocked = this.blocked;
    this.blocked = true;
    window.clearTimeout(this.timer);
    try {
      const fresh = await this.io.invoke<DocumentDto>("open_document", { path: this.dto.path });
      // Lukket imens: skrivefladen kan vise en anden tekst nu. Intet må flettes ind i den.
      if (this.closed) return;
      let mine = this.view.state.doc.toString();
      if (fresh.text === mine) {
        this.base = fresh.text;
        this.dto = fresh;
        this.dirty = false;
        this.blocked = wasBlocked;
        return;
      }
      type Merge = { conflict: boolean; changes: { from: number; to: number; insert: string }[] };
      let merge: Merge;
      // Tastetryk under et IPC-kald må aldrig anvende positioner fra en ældre tekst.
      for (;;) {
        mine = this.view.state.doc.toString();
        merge = await this.io.invoke<Merge>("merge_texts", { base: this.base, mine, theirs: fresh.text });
        if (this.closed) return;
        if (this.view.state.doc.toString() === mine) break;
      }
      if (merge.conflict) {
        this.conflict(fresh, mine);
        return;
      }
      const clean = mine === this.base;
      this.syncing = true;
      try {
        this.view.dispatch({ changes: merge.changes, userEvent: "input.external", annotations: isolateHistory.of("full") });
        // Uden egne rettelser er filens forfatterskab det præcise (Rust har flyttet det).
        if (clean) {
          this.view.dispatch({
            effects: setAuthorship.of({ authors: fresh.authors, me: fresh.me, pasted: [], external: fresh.external }),
          });
        }
      } finally {
        this.syncing = false;
      }
      this.base = fresh.text;
      this.dto = { ...fresh, cursor: null };
      this.blocked = wasBlocked;
      // Flettet med brugerens egne rettelser: den samlede tekst skal gemmes.
      if (clean) this.dirty = false;
      else this.changed();
      this.notice = true;
      this.show(tr("Teksten er rettet udefra. Det nye er markeret med en stiplet streg.", "The text was changed outside the app. What's new is marked with a dotted line."), [
        {
          label: tr("Fortryd rettelsen", "Undo the change"),
          run: () => {
            undo(this.view);
            this.hide();
          },
        },
        { label: tr("Fint", "OK"), run: () => this.hide() },
      ]);
    } catch (e) {
      this.blocked = wasBlocked;
      this.show(tr(`Den nye udgave af filen kunne ikke hentes. ${errorText(e)}`, `The new version of the file could not be loaded. ${errorText(e)}`));
    }
  }

  /**
   * Begge har rettet på samme linje. Den anden udgave er allerede gemt i Versioner, og brugerens
   * kommer derind nu. Før lå den kun i backup, hvis vinduet blev lukket (fejljagt 19/10).
   */
  private conflict(fresh: DocumentDto, mine: string): void {
    if (this.closed) return;
    this.blocked = true;
    void this.io
      .invoke("history_keep", { path: this.dto.path, text: mine, authors: this.view.state.field(authorshipField, false)?.authors ?? [] })
      .catch((e: unknown) => this.show(errorText(e)));
    this.show(
      tr(
        "Filen er rettet udefra samme sted, som du skriver. Begge udgaver ligger i Versioner.",
        "The file was changed outside the app in the same place you are writing. Both versions are in Versions.",
      ),
      [
        {
          label: tr("Behold min", "Keep mine"),
          run: () => {
            if (this.closed) return;
            this.base = fresh.text;
            this.dto = { ...fresh, cursor: null };
            void this.save({ overwriteExternal: true });
          },
        },
        {
          label: tr("Brug den nye", "Use the new one"),
          run: () => this.reloadFromDisk(),
        },
      ],
    );
  }

  /** Lægger editorens tekst i backup og henter filens nye udgave ind. */
  private async reloadFromDisk(): Promise<void> {
    const state = this.view.state;
    await this.io.invoke("backup_text", { path: this.dto.path, text: state.doc.toString() });
    if(this.closed || this.view.state.doc !== state.doc)return;
    const fresh = await this.io.invoke<DocumentDto>("open_document", { path: this.dto.path });
    if(this.closed || this.view.state.doc !== state.doc) {
      this.show(tr("Du skrev videre, mens filen blev hentet. Din tekst er bevaret. Vælg igen, hvilken udgave du vil bruge.", "You continued writing while the file loaded. Your text is preserved. Choose again which version to use."));
      return;
    }
    this.dto = fresh;
    this.base = fresh.text;
    this.dirty = false;
    this.blocked = false;
    this.hide();
    this.view.setState(createState(fresh.text, { authors: fresh.authors, me: fresh.me, pasted: [], external: fresh.external }, fresh.cursor, this.onChange));
  }

  /** En gammel iA-blok midt i teksten (ADR-0009). Ryddes kun op, hvis brugeren vælger det. */
  private offerStaleCleanup(): void {
    const stale = this.dto.staleBlocks;
    if (stale.length === 0) return;
    const text = this.view.state.doc.toString();
    this.notice = true;
    this.show(tr("Der står en gammel forfatterblok fra iA Writer midt i teksten.", "There is an old iA Writer author block in the middle of the text."), [
      {
        label: tr("Fjern den", "Remove it"),
        run: () => {
          if (this.closed || this.view.state.doc.toString() !== text) { this.hide(); return; }
          const changes = stale.map((s) => ({ from: s.start, to: s.end }));
          this.view.dispatch({ changes, userEvent: "delete.cleanup" });
          this.hide();
        },
      },
      { label: tr("Lad den stå", "Leave it"), run: () => this.hide() },
    ]);
  }
}
