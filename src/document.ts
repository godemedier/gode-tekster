// Ét åbent dokument: indlæsning, automatisk gem og værnet mod at overskrive rettelser udefra
// (plan 1, ADR-0013). Gemmer 1,5 s efter sidste tastetryk, ved fokustab og ved luk.

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
  cursor: number | null;
  hasBlock: boolean;
  external: Span[];
};

type SaveError = { kind: string; message: string };
type SaveOptions = { allowEolNormalize?: boolean; overwriteExternal?: boolean; forceUtf8?: boolean };

const AUTOSAVE_MS = 1500;

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

  private show(message: string, actions: Action[] = []): void {
    // Sessionens forrige besked er forældet, når en ny kommer.
    hideBanner(this.bannerId);
    this.bannerId = showBanner(message, actions);
  }

  private hide(): void {
    hideBanner(this.bannerId);
  }

  /** Beskeden om en rettelse udefra står. Den forsvinder, når brugeren skriver videre. */
  private notice = false;

  private view: EditorView;
  private dto: DocumentDto;
  /** Lytteren fra load, så en genindlæsning ikke mister højre spalte og autosave. */
  private onChange: () => void;

  constructor(view: EditorView, dto: DocumentDto, onChange: () => void) {
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
    return session;
  }

  get path(): string {
    return this.dto.path;
  }

  /** Teksten har fået nyt navn af programmet selv (rename_open_document): gem videre i den nye fil. */
  renamed(to: string): void {
    this.dto = { ...this.dto, path: to, name: to.slice(to.lastIndexOf("\\") + 1) };
    setImageBase(to);
  }

  changed(): void {
    if (this.paused || this.syncing) return;
    if (this.notice) {
      // »Fortryd rettelsen« ville nu fortryde det, brugeren lige har skrevet.
      this.notice = false;
      this.hide();
    }
    this.dirty = true;
    if (this.blocked) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.save(), AUTOSAVE_MS);
  }

  /** Gemmer nu, hvis der er noget at gemme. Bruges ved fokustab, luk og skift af fil. */
  async flush(): Promise<void> {
    if (this.paused) return;
    window.clearTimeout(this.timer);
    if (this.saving) await this.saving;
    if (this.dirty && !this.blocked) await this.save();
  }

  /** Versioner: gem nu, og hold autosave på pause, mens en gammel udgave vises. */
  async pause(on: boolean): Promise<void> {
    if (on) await this.flush();
    this.paused = on;
  }

  /** Før en anden fil åbnes: gem, og kan det ikke lade sig gøre, læg teksten i backup. */
  async close(): Promise<void> {
    await this.flush();
    if (this.dirty) {
      await invoke("backup_text", { path: this.dto.path, text: this.view.state.doc.toString() });
      this.hide();
    }
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
    const state = this.view.state;
    const authors = this.dto.hasBlock ? state.field(authorshipField).authors : [];
    const text = state.doc.toString();
    this.dirty = false;
    try {
      await invoke("save_document", {
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
      this.blocked = false;
      this.hide();
    } catch (e) {
      this.dirty = true;
      this.handleError(e as SaveError);
    }
  }

  private handleError(err: SaveError): void {
    this.blocked = true;
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
        this.show(tr("Filen findes ikke længere her.", "The file is no longer here."), [
          { label: tr("Gem den her igen", "Save it here again"), run: () => this.save({ overwriteExternal: true }) },
        ]);
        break;
      default:
        this.show(err.message || tr("Teksten kunne ikke gemmes.", "The text could not be saved."), [
          { label: tr("Prøv igen", "Try again"), run: () => this.save() },
          {
            label: tr("Gem en kopi", "Save a copy"),
            run: async () => {
              await invoke("backup_text", { path: this.dto.path, text: this.view.state.doc.toString() });
              notify(tr("En kopi af teksten er gemt i programmets backup-mappe.", "A copy of the text is saved in the app's backup folder."));
            },
          },
        ]);
    }
  }

  /**
   * Filen er rettet udefra (filovervågningen, fokus-tjekket eller et gem, der opdagede det).
   * Rettelserne flettes ind som almindelige ændringer, så markør, rulning og fortryd overlever,
   * og det nye får en stiplet streg. Står der egne rettelser på samme linje, vælger brugeren (2/10).
   */
  externalChange(): Promise<void> {
    if (this.paused) return Promise.resolve();
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
      const fresh = await invoke<DocumentDto>("open_document", { path: this.dto.path });
      let mine = this.view.state.doc.toString();
      if (fresh.text === mine) {
        this.base = fresh.text;
        this.dto = fresh;
        this.dirty = false;
        this.blocked = wasBlocked;
        return;
      }
      type Merge = { conflict: boolean; changes: { from: number; to: number; insert: string }[] };
      let merge = await invoke<Merge>("merge_texts", { base: this.base, mine, theirs: fresh.text });
      // Har brugeren skrevet videre imens, flettes der én gang til med den nyeste tekst.
      if (this.view.state.doc.toString() !== mine) {
        mine = this.view.state.doc.toString();
        merge = await invoke<Merge>("merge_texts", { base: this.base, mine, theirs: fresh.text });
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

  /** Begge har rettet på samme linje. Den anden udgave er allerede gemt i Versioner. */
  private conflict(fresh: DocumentDto, mine: string): void {
    this.blocked = true;
    this.show(
      tr(
        "Filen er rettet udefra samme sted, som du skriver. Begge udgaver ligger i Versioner.",
        "The file was changed outside the app in the same place you are writing. Both versions are in Versions.",
      ),
      [
        {
          label: tr("Behold min", "Keep mine"),
          run: () => {
            this.base = fresh.text;
            this.dto = { ...fresh, cursor: null };
            void this.save({ overwriteExternal: true });
          },
        },
        {
          label: tr("Brug den nye", "Use the new one"),
          run: async () => {
            await invoke("history_keep", { path: this.dto.path, text: mine, authors: this.view.state.field(authorshipField).authors });
            await this.reloadFromDisk();
          },
        },
      ],
    );
  }

  /** Lægger editorens tekst i backup og henter filens nye udgave ind. */
  private async reloadFromDisk(): Promise<void> {
    await invoke("backup_text", { path: this.dto.path, text: this.view.state.doc.toString() });
    const fresh = await invoke<DocumentDto>("open_document", { path: this.dto.path });
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
    this.show(tr("Der står en gammel forfatterblok fra iA Writer midt i teksten.", "There is an old iA Writer author block in the middle of the text."), [
      {
        label: tr("Fjern den", "Remove it"),
        run: () => {
          const changes = stale.map((s) => ({ from: s.start, to: s.end }));
          this.view.dispatch({ changes, userEvent: "delete.cleanup" });
          this.hide();
        },
      },
      { label: tr("Lad den stå", "Leave it"), run: () => this.hide() },
    ]);
  }
}
