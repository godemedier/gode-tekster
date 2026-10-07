// Biblioteket i venstre panel som i iA Writer (2/10): mappenavn med pil tilbage og plus,
// sortering, mapper øverst, filer med navn, tid og to linjers uddrag. Højreklik: ny tekst, ny
// mappe, omdøb, slet (til papirkurven) og sortering. Træk en fil over på en mappe for at flytte den.
// Stjernemarkerede står øverst (højreklik eller * på en valgt linje, ui/stars.ts).
// Al adgang til disken går gennem Rust (`library.rs`), der afviser stier uden for bibliotekerne.

import { invoke } from "@tauri-apps/api/core";

import { locale, tr } from "../i18n.ts";
import { setLibraries, settings, updateSettings } from "../settings.ts";
import { formatTime } from "./format.ts";
import { ICON, iconButton } from "./icons.ts";
import { showMenu, type MenuItem } from "./menu.ts";
import { errorText, notify, showBanner } from "./banner.ts";
import { afterMove, isStarred, toggleStar } from "./stars.ts";

type Entry = { name: string; path: string; isDir: boolean; modifiedMs: number; visibility: "normal" | "dimmed"; preview: string };
type Folder = { path: string; name: string; parent: string | null; entries: Entry[] };
type Library = { path: string; name: string; exists: boolean };

export type LibraryHooks = {
  open(path: string): void;
  /** Ctrl+klik eller »Åbn i nyt vindue« (ét vindue pr. tekst, 3/10). */
  openNew(path: string): void;
  /** En åben fil er omdøbt, flyttet eller slettet. `to` er null ved sletning. */
  moved(from: string, to: string | null): void;
  activePath(): string | null;
};

const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();

export class LibraryPanel {
  private hooks: LibraryHooks;
  private list: HTMLElement;
  private title: HTMLElement;
  private back: HTMLButtonElement;
  private sortButton: HTMLButtonElement;
  private folder: Folder | null = null;
  private libraries: Library[] = [];
  private dragging: string | null = null;

  constructor(root: HTMLElement, hooks: LibraryHooks) {
    this.hooks = hooks;
    const head = document.createElement("div");
    head.className = "lib-head";
    this.back = iconButton(ICON.up, tr("Et niveau op", "Up one level"), () => void this.goUp());
    this.title = document.createElement("span");
    this.title.className = "lib-title";
    const plus = iconButton(ICON.plus, tr("Ny tekst eller mappe", "New text or folder"), () => {
      const r = plus.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, this.newItems());
    });
    head.append(this.back, this.title, plus);
    // Mappen over kan også modtage en fil: træk den over på pilen.
    this.dropTarget(this.back, () => this.folder?.parent ?? null);

    this.sortButton = document.createElement("button");
    this.sortButton.type = "button";
    this.sortButton.className = "lib-sort";
    this.sortButton.addEventListener("click", () => {
      const r = this.sortButton.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, this.sortItems());
    });

    this.list = document.createElement("div");
    this.list.className = "lib-list";
    this.list.addEventListener("contextmenu", (e) => {
      if (e.target === this.list) {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [...this.newItems(), { separator: true }, ...this.sortItems()]);
      }
    });
    root.append(head, this.sortButton, this.list);
  }

  async init(): Promise<void> {
    this.libraries = await invoke<Library[]>("list_libraries");
  }

  /** Vis mappen med filen, hvis den ligger i et bibliotek. Ellers bibliotekets rod. */
  async reveal(filePath: string | null): Promise<void> {
    const inLibrary = (p: string) => this.libraries.find((l) => norm(p).startsWith(norm(l.path) + "\\"));
    let lib = filePath ? inLibrary(filePath) : undefined;
    // Første start lægger Dokumenter\Gode Tekster til som bibliotek, efter listen blev hentet. Uden
    // et nyt opslag viste biblioteket ikke mappen med introteksterne (5/10).
    if (filePath && !lib) {
      await this.init();
      lib = inLibrary(filePath);
    }
    if (filePath && lib) {
      await this.show(filePath.slice(0, filePath.lastIndexOf("\\")));
    } else if (!this.folder) {
      const first = this.libraries.find((l) => l.exists);
      if (first) await this.show(first.path);
      // Intet bibliotek endnu: oversigten med »Tilføj mappe …« (indstillingerne har dem ikke længere).
      else this.showLibraries();
    } else {
      this.render();
    }
  }

  async show(path: string): Promise<void> {
    try {
      this.folder = await invoke<Folder>("list_folder", { path });
      await invoke("watch_folder", { path: this.folder.path });
      this.render();
    } catch (e) {
      this.renderEmpty(errorText(e));
    }
  }

  async refresh(): Promise<void> {
    if (this.folder) await this.show(this.folder.path);
  }

  /** Op ad: til mappen over, og fra et biblioteks rod til listen over alle biblioteker (2/10). */
  private async goUp(): Promise<void> {
    if (this.folder?.parent) await this.show(this.folder.parent);
    else if (this.folder) this.showLibraries();
  }

  /** Det øverste niveau: alle biblioteker og »Tilføj mappe …«. */
  showLibraries(): void {
    this.folder = null;
    this.title.textContent = tr("Biblioteker", "Libraries");
    this.back.hidden = true;
    this.sortButton.hidden = true;
    const rows: HTMLElement[] = this.libraries.map((l) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lib-row lib-folder" + (l.exists ? "" : " dimmed");
      b.title = tr(
        `${l.exists ? l.path : `${l.path} findes ikke længere`}. Højreklik for at fjerne den fra listen`,
        `${l.exists ? l.path : `${l.path} no longer exists`}. Right-click to remove it from the list`,
      );
      const icon = document.createElement("span");
      icon.innerHTML = ICON.folder;
      const name = document.createElement("span");
      name.className = "lib-name";
      name.textContent = l.name;
      const chev = document.createElement("span");
      chev.className = "lib-chev";
      chev.textContent = "›";
      b.append(icon, name, chev);
      if (l.exists) b.addEventListener("click", () => void this.show(l.path));
      // Bibliotekerne styres her, ikke i indstillingerne (3/10).
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          {
            label: tr("Fjern fra listen (mappen slettes ikke)", "Remove from the list (the folder is not deleted)"),
            run: async () => {
              try {
                setLibraries(await invoke<string[]>("remove_library", { path: l.path }));
                await this.init();
                this.showLibraries();
              } catch (err) {
                showBanner(errorText(err));
              }
            },
          },
        ]);
      });
      return b;
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "lib-row lib-add";
    add.textContent = tr("Tilføj mappe …", "Add folder …");
    // Mappen vælges i Rust: fladen kan ikke selv udvide, hvor programmet må læse og skrive.
    add.addEventListener("click", async () => {
      try {
        setLibraries(await invoke<string[]>("add_library"));
        await this.init();
        this.showLibraries();
      } catch (e) {
        showBanner(errorText(e));
      }
    });
    const hint = document.createElement("p");
    hint.className = "lib-empty";
    hint.textContent = tr("Biblioteket viser teksterne i de mapper, du vælger.", "The Library shows the texts in the folders you choose.");
    this.list.replaceChildren(...rows, add, ...(rows.length ? [] : [hint]));
  }

  private renderEmpty(message: string): void {
    this.title.textContent = "";
    const p = document.createElement("p");
    p.className = "lib-empty";
    p.textContent = message;
    this.list.replaceChildren(p);
  }

  private sorted(entries: Entry[]): Entry[] {
    const s = settings();
    const dir = s.newestFirst ? -1 : 1;
    const starred = s.starred ?? [];
    return [...entries]
      .filter((e) => s.showHouseFiles || e.visibility !== "dimmed")
      .sort((a, b) => {
        const sa = isStarred(starred, a.path);
        if (sa !== isStarred(starred, b.path)) return sa ? -1 : 1;
        if (s.foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        if (s.sortBy === "name") return dir * -1 * a.name.localeCompare(b.name, locale());
        return dir * (a.modifiedMs - b.modifiedMs);
      });
  }

  render(): void {
    const f = this.folder;
    if (!f) return;
    this.title.textContent = f.name;
    // Også i bibliotekets rod: pilen fører til listen over biblioteker.
    this.back.hidden = false;
    this.back.title = f.parent ? tr("Mappen over", "Parent folder") : tr("Alle biblioteker", "All libraries");
    this.sortButton.hidden = false;
    const s = settings();
    this.sortButton.innerHTML = "";
    const label = document.createElement("span");
    label.textContent = s.sortBy === "date" ? tr("Sorteret efter dato", "Sorted by date") : tr("Sorteret efter navn", "Sorted by name");
    const chevron = document.createElement("span");
    chevron.innerHTML = ICON.chevronDown;
    this.sortButton.append(label, chevron);

    const active = this.hooks.activePath();
    const rows = this.sorted(f.entries).map((e) => (e.isDir ? this.folderRow(e) : this.fileRow(e, active)));
    if (rows.length === 0) {
      const p = document.createElement("p");
      p.className = "lib-empty";
      p.textContent = tr("Mappen er tom.", "The folder is empty.");
      rows.push(p);
    }
    this.list.replaceChildren(...rows);
  }

  private folderRow(e: Entry): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lib-row lib-folder" + (e.visibility === "dimmed" ? " dimmed" : "");
    const icon = document.createElement("span");
    icon.innerHTML = ICON.folder;
    const name = document.createElement("span");
    name.className = "lib-name";
    name.textContent = e.name;
    const chev = document.createElement("span");
    chev.className = "lib-chev";
    chev.textContent = "›";
    b.append(icon, name, ...this.star(e), chev);
    b.addEventListener("click", () => void this.show(e.path));
    this.rowCommon(b, e, name);
    this.dropTarget(b, () => e.path);
    return b;
  }

  private fileRow(e: Entry, active: string | null): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    const isActive = active !== null && norm(active) === norm(e.path);
    b.className = "lib-row" + (isActive ? " active" : "") + (e.visibility === "dimmed" ? " dimmed" : "");
    const top = document.createElement("span");
    top.className = "lib-top";
    const icon = document.createElement("span");
    icon.innerHTML = ICON.file;
    const name = document.createElement("span");
    name.className = "lib-name";
    name.textContent = e.name;
    const time = document.createElement("span");
    time.className = "lib-time";
    time.textContent = formatTime(e.modifiedMs);
    top.append(icon, name, ...this.star(e), time);
    b.append(top);
    if (e.preview) {
      const prev = document.createElement("span");
      prev.className = "lib-preview";
      prev.textContent = e.preview;
      b.append(prev);
    }
    b.addEventListener("click", (ev) => (ev.ctrlKey ? this.hooks.openNew(e.path) : this.hooks.open(e.path)));
    this.rowCommon(b, e, name);
    return b;
  }

  /** Stjernen ved navnet, når linjen er stjernemarkeret. */
  private star(e: Entry): HTMLElement[] {
    if (!isStarred(settings().starred ?? [], e.path)) return [];
    const star = document.createElement("span");
    star.className = "lib-star";
    star.textContent = "★";
    star.title = tr("Stjernemarkeret", "Starred");
    return [star];
  }

  private toggleStar(e: Entry): void {
    void updateSettings({ starred: toggleStar(settings().starred ?? [], e.path) }).then(() => this.render());
  }

  /** Stjernerne følger en omdøbt, flyttet eller slettet fil eller mappe. */
  private async moveStars(from: string, to: string | null): Promise<void> {
    const before = settings().starred ?? [];
    const after = afterMove(before, from, to);
    if (after.length !== before.length || after.some((s, i) => s !== before[i])) await updateSettings({ starred: after });
  }

  /** Højreklik og træk, fælles for mapper og filer. */
  private rowCommon(b: HTMLElement, e: Entry, nameEl: HTMLElement): void {
    // * på en valgt linje slår stjernen til og fra (tastaturet, 5/10).
    b.addEventListener("keydown", (ev) => {
      if (ev.key === "*" && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        this.toggleStar(e);
      }
    });
    b.draggable = true;
    b.addEventListener("dragstart", (ev) => {
      this.dragging = e.path;
      ev.dataTransfer?.setData("text/plain", e.name);
      // Så højre spalte ved, at det er en fil og ikke tekst, der skal i fraklip.
      ev.dataTransfer?.setData("application/x-gt-fil", e.path);
    });
    b.addEventListener("dragend", () => (this.dragging = null));
    b.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      showMenu(ev.clientX, ev.clientY, [
        ...(e.isDir ? [] : ([{ label: tr("Åbn i nyt vindue (Ctrl+klik)", "Open in new window (Ctrl+click)"), run: () => this.hooks.openNew(e.path) }] as MenuItem[])),
        // Stien og Stifinder (7/10), til filer og mapper.
        { label: tr("Kopiér sti", "Copy path"), run: () => void copyPath(e.path) },
        { label: tr("Vis i Stifinder", "Show in File Explorer"), run: () => void invoke("reveal_entry", { path: e.path }).catch((err) => showBanner(errorText(err))) },
        { separator: true },
        { label: isStarred(settings().starred ?? [], e.path) ? tr("Fjern stjernen (*)", "Remove star (*)") : tr("Stjernemarkér (*)", "Star (*)"), run: () => this.toggleStar(e) },
        { label: tr("Omdøb", "Rename"), run: () => this.rename(e, nameEl) },
        { label: tr("Læg i papirkurven", "Move to Recycle Bin"), run: () => void this.remove(e) },
        { separator: true },
        ...this.newItems(),
        { separator: true },
        ...this.sortItems(),
      ]);
    });
  }

  private dropTarget(el: HTMLElement, dir: () => string | null): void {
    el.addEventListener("dragover", (ev) => {
      const target = dir();
      if (this.dragging && target && norm(target) !== norm(this.dragging)) {
        ev.preventDefault();
        el.classList.add("drop");
      }
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop"));
    el.addEventListener("drop", (ev) => {
      ev.preventDefault();
      el.classList.remove("drop");
      const target = dir();
      const from = this.dragging;
      if (from && target) void this.move(from, target);
    });
  }

  private newItems(): MenuItem[] {
    return [
      { label: tr("Ny tekst", "New text"), run: () => void this.create("create_file") },
      { label: tr("Ny mappe", "New folder"), run: () => void this.create("create_folder") },
    ];
  }

  private sortItems(): MenuItem[] {
    const s = settings();
    const set = (patch: Parameters<typeof updateSettings>[0]) => void updateSettings(patch).then(() => this.render());
    return [
      { label: tr("Mapper øverst", "Folders first"), checked: s.foldersFirst, run: () => set({ foldersFirst: !s.foldersFirst }) },
      { separator: true },
      { label: tr("Sorter efter dato", "Sort by date"), checked: s.sortBy === "date", run: () => set({ sortBy: "date" }) },
      { label: tr("Sorter efter navn", "Sort by name"), checked: s.sortBy === "name", run: () => set({ sortBy: "name" }) },
      { separator: true },
      { label: tr("Ældste øverst", "Oldest first"), checked: !s.newestFirst, run: () => set({ newestFirst: false }) },
      { label: tr("Nyeste øverst", "Newest first"), checked: s.newestFirst, run: () => set({ newestFirst: true }) },
      { separator: true },
      { label: tr("Vis husets filer", "Show house files"), checked: s.showHouseFiles, run: () => set({ showHouseFiles: !s.showHouseFiles }) },
    ];
  }

  private async create(command: "create_file" | "create_folder"): Promise<void> {
    if (!this.folder) return;
    try {
      const path = await invoke<string>(command, { dir: this.folder.path });
      await this.refresh();
      if (command === "create_file") this.hooks.open(path);
      const row = [...this.list.querySelectorAll<HTMLElement>(".lib-name")].find((n) => path.endsWith("\\" + n.textContent));
      const entry = this.folder.entries.find((e) => norm(e.path) === norm(path));
      // En ny tekst får navn efter sin første linje (autoName.ts). Kun en ny mappe skal navngives her.
      if (row && entry && command === "create_folder") this.rename(entry, row);
    } catch (e) {
      showBanner(errorText(e));
    }
  }

  private rename(e: Entry, nameEl: HTMLElement): void {
    const input = document.createElement("input");
    input.className = "lib-rename";
    const dot = e.isDir ? -1 : e.name.lastIndexOf(".");
    input.value = dot > 0 ? e.name.slice(0, dot) : e.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value && value !== input.defaultValue) {
        try {
          const to = await invoke<string>("rename_entry", { path: e.path, newName: value });
          await this.moveStars(e.path, to);
          this.hooks.moved(e.path, to);
        } catch (err) {
          showBanner(String(err));
        }
      }
      await this.refresh();
    };
    input.defaultValue = input.value;
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") void finish(true);
      if (ev.key === "Escape") void finish(false);
    });
    input.addEventListener("blur", () => void finish(true));
  }

  private async remove(e: Entry): Promise<void> {
    try {
      await invoke("delete_entry", { path: e.path });
      await this.moveStars(e.path, null);
      this.hooks.moved(e.path, null);
    } catch (err) {
      showBanner(String(err));
    }
    await this.refresh();
  }

  private async move(from: string, dir: string): Promise<void> {
    try {
      const to = await invoke<string>("move_entry", { path: from, dir });
      await this.moveStars(from, to);
      this.hooks.moved(from, to);
    } catch (err) {
      showBanner(String(err));
    }
    await this.refresh();
  }
}

/** Stien til udklipsholderen. Lykkes det ikke, står stien i beskeden, så den kan kopieres derfra. */
async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    notify(tr("Stien er kopieret.", "Path copied."));
  } catch {
    showBanner(path);
  }
}
