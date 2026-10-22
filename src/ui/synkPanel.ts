// Fanen Synk i Indstillinger (ADR-0054): forbind enheden, se prøvekørslen, start synken, og følg
// med i, hvad den gør. Synken selv kører i Rust (synk/service.rs). Fanen viser kun status.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { tr } from "../i18n.ts";
import { errorText, notify, showBanner } from "./banner.ts";
import { preserveFocus } from "./focus.ts";
import { group, linkButton, panel, row } from "./settingspanel.ts";

type Report = {
  uploaded: string[];
  downloaded: string[];
  merged: string[];
  conflicts: string[];
  heldDeletes: number;
  errors: string[];
};

export type SynkStatus = {
  connected: boolean;
  /** Ejerens enhed: kan dele og lave parringskoder (ADR-0064). */
  owner: boolean;
  started: boolean;
  server: string | null;
  device: string | null;
  root: string | null;
  running: boolean;
  lastSync: string | null;
  last: Report | null;
  error: string | null;
  heldDeletes: number;
  log: string[];
};

type Preview = {
  same: number;
  upload: number;
  download: number;
  merge: number;
  deleteLocal: number;
  deleteRemote: number;
  skipped: [string, string][];
};

/** En slettet fil i serverens papirkurv (synk-kerne `Trashed`). `deleted` er sekunder. */
type Trashed = { path: string; rev: number; device: string; deleted: number; hash: string; size: number };

const DEFAULT_SERVER = "https://synk.godemedier.dk";

function input(value: string, opts: { password?: boolean; placeholder?: string; label: string }): HTMLInputElement {
  const i = document.createElement("input");
  i.className = "st-input";
  i.type = opts.password ? "password" : "text";
  i.value = value;
  i.spellcheck = false;
  i.setAttribute("aria-label", opts.label);
  if (opts.placeholder) i.placeholder = opts.placeholder;
  return i;
}

/** Fanens vigtigste handling (Forbind, Start). Resten er links. */
function primary(label: string, run: () => void): HTMLButtonElement {
  const b = linkButton(label, run);
  b.classList.add("st-primary");
  return b;
}

function note(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "st-note";
  p.textContent = text;
  return p;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Prøvekørslen i ord. Kun de linjer, der har et tal. */
function previewLines(p: Preview): string[] {
  const lines: string[] = [];
  if (p.same) lines.push(tr(`${count(p.same, "fil er", "filer er")} ens begge steder.`, `${p.same} files are the same in both places.`));
  if (p.upload) lines.push(tr(`${count(p.upload, "fil", "filer")} sendes herfra.`, `${p.upload} files will be sent from here.`));
  if (p.download) lines.push(tr(`${count(p.download, "fil", "filer")} hentes fra serveren.`, `${p.download} files will be fetched.`));
  if (p.merge)
    lines.push(
      tr(
        `${count(p.merge, "fil findes", "filer findes")} begge steder med forskelligt indhold. Din udgave bliver en kopi ved siden af, så intet går tabt.`,
        `${p.merge} files differ. Your version is kept as a copy next to it.`,
      ),
    );
  if (p.deleteLocal || p.deleteRemote)
    lines.push(tr(`${p.deleteLocal + p.deleteRemote} sletninger.`, `${p.deleteLocal + p.deleteRemote} deletions.`));
  for (const [path, why] of p.skipped.slice(0, 5)) lines.push(tr(`Kommer ikke med: ${path}. ${why}`, `Not synced: ${path}. ${why}`));
  if (p.skipped.length > 5) lines.push(tr(`… og ${p.skipped.length - 5} filer mere, der ikke kan komme med.`, `… and ${p.skipped.length - 5} more.`));
  if (!lines.length) lines.push(tr("Der er ingen tekster at synkronisere endnu.", "There is nothing to sync yet."));
  return lines;
}

/** »14.02« i dag, ellers »21. okt. 14.02«. Et tidspunkt uden dato kan være fra i går (gennemgang 22/10). */
function when(stamp: string): string {
  const day = stamp.slice(0, 10);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (day === today) return stamp.slice(11);
  const date = new Date(`${day}T00:00`).toLocaleDateString(tr("da-DK", "en-GB"), { day: "numeric", month: "short" });
  return `${date} ${stamp.slice(11)}`;
}

/** Mobilfladen (mobile.html) sætter klassen på body. */
function onPhone(): boolean {
  return document.body.classList.contains("mobil");
}

export class SynkPanel {
  readonly el = document.createElement("div");
  private status: SynkStatus | null = null;
  private preview: Preview | null = null;
  private pairing: { code: string; expires: number } | null = null;
  /**
   * Felterne i formularen. De overlever, at fanen tegnes forfra, også når Forbind fejler (gennemgang
   * 22/10). Ejernøglen er ikke med: den står kun i feltet. `name` er `null`, til brugeren skriver.
   */
  private form: { server: string; name: string | null; code: string } = { server: DEFAULT_SERVER, name: null, code: "" };
  /** »Slet dem« er trykket én gang og venter på et ja (sletningerne gælder alle enheder). */
  private confirmDeletes = false;
  /** Antal delinger, der stadig virker, mens »Kobl fra« venter på et svar. */
  private offAsk: number | null = null;
  /** Serverens papirkurv. `null`, til brugeren beder om den. */
  private trash: Trashed[] | null = null;
  private busy = false;
  /** Felterne til synkserveren er foldet ud (kun ejerens enheder kan bruge dem). */
  private showServer = false;

  constructor() {
    void listen<SynkStatus>("synk-status", (e) => {
      this.status = e.payload;
      if (this.el.isConnected) this.render();
    });
  }

  async refresh(): Promise<void> {
    try {
      this.status = await invoke<SynkStatus>("synk_status");
    } catch (e) {
      showBanner(errorText(e));
    }
    this.render();
  }

  private async act(run: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      await run();
    } catch (e) {
      showBanner(errorText(e));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private render(): void {
    const s = this.status;
    const restore = preserveFocus(this.el);
    if (!s?.connected) this.el.replaceChildren(this.connectForm());
    else if (!s.started) this.el.replaceChildren(this.previewView(s));
    else this.el.replaceChildren(this.statusView(s));
    restore();
  }

  private connectForm(): HTMLElement {
    const f = this.form;
    const server = input(f.server, { label: tr("Serverens adresse", "Server address") });
    const name = input(f.name ?? (onPhone() ? tr("Telefon", "Phone") : tr("Pc", "PC")), { label: tr("Enhedens navn", "Device name") });
    const code = input(f.code, { label: tr("Parringskode", "Pairing code"), placeholder: "ABCD-EFGH" });
    const admin = input("", { password: true, label: tr("Ejernøgle", "Owner key") });
    server.addEventListener("input", () => (f.server = server.value));
    name.addEventListener("input", () => (f.name = name.value));
    code.addEventListener("input", () => (f.code = code.value));
    const go = primary(this.busy ? tr("Forbinder …", "Connecting …") : tr("Forbind", "Connect"), () =>
      void this.act(async () => {
        this.status = await invoke<SynkStatus>("synk_connect", {
          server: server.value,
          name: name.value,
          code: code.value.trim() || null,
          admin: admin.value.trim() || null,
        });
        admin.value = "";
        f.code = "";
        this.showServer = false;
        this.preview = null;
      }),
    );
    // Kun ejerens enheder kan forbindes til synkserveren (22/10). Alle andre får først vejen, der
    // virker for dem: biblioteket i deres egen skytjeneste. Felterne ligger bag en knap. Telefonen kan
    // kun synke gennem serveren, så dér står felterne fremme.
    const phone = onPhone();
    const own = group(
      tr("Dine tekster på flere computere", "Your texts on more than one computer"),
      note(
        tr(
          "Tager OneDrive backup af Dokumenter, er teksterne der allerede. Ellers så læg biblioteket i din OneDrive-, Google Drev- eller Dropbox-mappe. Teksterne er almindelige filer, så tjenesten synkroniserer dem som alle andre. På den anden computer installerer du Gode Tekster og tilføjer den samme mappe som bibliotek.",
          "If OneDrive backs up Documents, your texts are already there. Otherwise, put your library in your OneDrive, Google Drive or Dropbox folder. The texts are ordinary files, so the service syncs them like any other. On the other computer, install Gode Tekster and add the same folder as a library.",
        ),
      ),
      note(
        tr(
          "Bliver en tekst ændret på en anden computer, mens den er åben her, spørger Gode Tekster, før noget bliver overskrevet.",
          "If a text is changed on another computer while it is open here, Gode Tekster asks before anything is overwritten.",
        ),
      ),
    );
    if (!phone && !this.showServer && !this.busy) {
      const more = linkButton(tr("Forbind til en synkserver …", "Connect to a sync server …"), () => {
        this.showServer = true;
        this.render();
      });
      return panel(
        own,
        group(
          tr("Synkserver", "Sync server"),
          row("", more, {
            hint: tr(
              "Kræver en parringskode fra en enhed, der allerede er forbundet, eller serverens ejernøgle.",
              "Needs a pairing code from a device that is already connected, or the server's owner key.",
            ),
          }),
        ),
      );
    }
    return panel(
      ...(phone ? [] : [own]),
      group(
        tr("Synkserver", "Sync server"),
        note(
          tr(
            "Med en synkserver kommer teksterne i Dokumenter også på telefonen og i browseren. Kun tekst og billeder i medier-mapper kommer med.",
            "With a sync server, your texts in Documents also reach the phone and the browser. Only text and images in media folders are included.",
          ),
        ),
        row(tr("Serverens adresse", "Server address"), server),
        row(tr("Enhedens navn", "Device name"), name, { hint: tr("Står i navnet på en konfliktkopi.", "Used in the name of a conflict copy.") }),
        row(tr("Parringskode", "Pairing code"), code, {
          hint: tr("Lav koden på en enhed, der allerede er forbundet.", "Create the code on a device that is already connected."),
        }),
        row(tr("Ejernøgle", "Owner key"), admin, {
          hint: tr("Kun til den første enhed.", "Only for the first device."),
        }),
        row("", phone ? go : actions(go, linkButton(tr("Fortryd", "Cancel"), () => {
          this.showServer = false;
          this.render();
        }))),
      ),
    );
  }

  private previewView(s: SynkStatus): HTMLElement {
    const lines = this.preview ? previewLines(this.preview).map(note) : [];
    const run = linkButton(this.busy && !this.preview ? tr("Tæller …", "Counting …") : tr("Lav en prøvekørsel", "Do a dry run"), () =>
      void this.act(async () => {
        this.preview = await invoke<Preview>("synk_preview");
      }),
    );
    const start = primary(tr("Start synkroniseringen", "Start syncing"), () =>
      void this.act(async () => {
        this.status = await invoke<SynkStatus>("synk_start");
      }),
    );
    const controls = document.createElement("div");
    controls.append(run, ...(this.preview ? [start] : []));
    return panel(
      group(
        tr("Før den første synkronisering", "Before the first sync"),
        note(tr(`Forbundet til ${s.server} som »${s.device}«. Mappen er ${s.root}.`, `Connected to ${s.server} as "${s.device}". Folder: ${s.root}.`)),
        note(
          tr(
            "Prøvekørslen tæller, hvad den første synkronisering vil gøre, uden at ændre noget. Den første synkronisering sletter aldrig. Den lægger kun sammen.",
            "The dry run counts what the first sync will do without changing anything. The first sync never deletes.",
          ),
        ),
        ...lines,
        row("", controls),
      ),
      this.disconnectGroup(),
    );
  }

  private statusView(s: SynkStatus): HTMLElement {
    const state = s.running
      ? tr("Synkroniserer …", "Syncing …")
      : s.error
        ? s.error
        : s.lastSync
          ? tr(`Synkroniseret ${when(s.lastSync)}`, `Synced ${when(s.lastSync)}`)
          : tr("Venter på første runde.", "Waiting for the first round.");
    const now = linkButton(tr("Synkronisér nu", "Sync now"), () => void invoke("synk_now"));
    const rows: HTMLElement[] = [
      row(tr("Status", "Status"), Object.assign(document.createElement("span"), { textContent: state })),
      row(tr("Server", "Server"), Object.assign(document.createElement("span"), { textContent: s.server ?? "" })),
      row(tr("Enhed", "Device"), Object.assign(document.createElement("span"), { textContent: s.device ?? "" })),
      row(tr("Mappe", "Folder"), Object.assign(document.createElement("span"), { textContent: s.root ?? "" })),
      row("", now),
    ];
    if (s.heldDeletes === 0) this.confirmDeletes = false;
    if (s.heldDeletes > 0) {
      const yes = document.createElement("div");
      yes.className = "st-actions";
      if (this.confirmDeletes) {
        yes.append(
          linkButton(tr("Ja, slet på alle enheder", "Yes, delete on all devices"), () => {
            this.confirmDeletes = false;
            void invoke("synk_allow_deletes");
          }),
          linkButton(tr("Fortryd", "Cancel"), () => {
            this.confirmDeletes = false;
            this.render();
          }),
        );
      } else {
        yes.append(
          linkButton(tr("Slet dem", "Delete them"), () => {
            this.confirmDeletes = true;
            this.render();
          }),
        );
      }
      rows.push(
        row(
          tr("Bremsen", "Brake"),
          yes,
          {
            hint: tr(
              `${s.heldDeletes} filer er slettet på én gang. Synkroniseringen holder sletningerne tilbage, til du siger ja. Var det en fejl, så hent filerne tilbage fra papirkurven først.`,
              `${s.heldDeletes} files were deleted at once. The deletions wait until you confirm.`,
            ),
          },
        ),
      );
    }
    const pair = linkButton(this.pairing ? tr("Ny kode", "New code") : tr("Lav en parringskode", "Create a pairing code"), () =>
      void this.act(async () => {
        this.pairing = await invoke<{ code: string; expires: number }>("synk_pairing_code");
      }),
    );
    const pairBox = document.createElement("div");
    if (this.pairing) {
      const code = document.createElement("strong");
      code.textContent = this.pairing.code;
      pairBox.append(code, " ");
    }
    pairBox.append(pair);
    const log = document.createElement("ul");
    log.className = "st-log";
    for (const line of s.log) log.append(Object.assign(document.createElement("li"), { textContent: line }));
    // Telefonen parres fra pc'en. Dér er parringskoden kun i vejen. Kun ejeren kan lave en kode.
    const pairing = onPhone() || !s.owner
      ? []
      : [
          group(
            tr("Ny enhed", "New device"),
            row(tr("Parringskode", "Pairing code"), pairBox, {
              hint: tr("Tast koden på telefonen inden for ti minutter. Den virker én gang.", "Enter the code on the phone within ten minutes. It works once."),
            }),
          ),
        ];
    return panel(
      group(tr("Synkronisering af Dokumenter", "Sync Documents"), ...rows),
      ...pairing,
      group(tr("Sidst", "Recent"), s.log.length ? log : note(tr("Intet endnu.", "Nothing yet."))),
      this.trashGroup(),
      this.disconnectGroup(),
    );
  }

  /** Papirkurven på serveren: alt slettet på en af enhederne de sidste 30 dage. */
  private trashGroup(): HTMLElement {
    const title = tr("Papirkurv på serveren", "Trash on the server");
    const load = linkButton(this.trash ? tr("Opdatér", "Refresh") : tr("Vis papirkurven", "Show the trash"), () =>
      void this.act(async () => {
        this.trash = await invoke<Trashed[]>("synk_trash");
      }),
    );
    const head = row("", load, {
      hint: tr(
        "En tekst, der er slettet på en af enhederne, kan hentes tilbage i 30 dage. Derefter fjerner serveren den.",
        "A text deleted on any device can be brought back for 30 days. Then the server removes it.",
      ),
    });
    if (!this.trash) return group(title, head);
    if (!this.trash.length) return group(title, head, note(tr("Papirkurven er tom.", "The trash is empty.")));
    const list = document.createElement("ul");
    list.className = "st-trash";
    for (const item of this.trash.slice(0, 100)) {
      const li = document.createElement("li");
      const parts = item.path.split("/");
      const name = Object.assign(document.createElement("span"), {
        className: "st-trash-name",
        textContent: (parts.pop() ?? "").replace(/\.(md|markdown|txt)$/i, ""),
      });
      const when = new Date(item.deleted * 1000).toLocaleString(tr("da-DK", "en-GB"), {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const meta = Object.assign(document.createElement("span"), {
        className: "st-trash-meta",
        textContent: [parts.join(" › "), tr(`slettet ${when} på ${item.device}`, `deleted ${when} on ${item.device}`)]
          .filter(Boolean)
          .join(" · "),
      });
      const back = linkButton(tr("Hent tilbage", "Restore"), () =>
        void this.act(async () => {
          await invoke("synk_restore", { item });
          this.trash = (this.trash ?? []).filter((t) => t !== item);
          notify(tr(`»${name.textContent}« kommer tilbage ved næste synkronisering.`, `“${name.textContent}” comes back with the next sync.`));
        }),
      );
      li.append(name, meta, back);
      list.append(li);
    }
    const rest = this.trash.length > 100 ? [note(tr(`… og ${this.trash.length - 100} mere.`, `… and ${this.trash.length - 100} more.`))] : [];
    return group(title, head, list, ...rest);
  }

  private disconnectGroup(): HTMLElement {
    const disconnect = async (): Promise<void> => {
      this.status = await invoke<SynkStatus>("synk_disconnect");
      this.preview = null;
      this.pairing = null;
      this.offAsk = null;
    };
    // Delingerne bor på serveren, ikke på enheden. Efter »Kobl fra« virker linkene videre, men de kan
    // ikke stoppes herfra, før enheden er forbundet igen (gennemgang 22/10). Så spørg først.
    if (this.offAsk !== null) {
      const n = this.offAsk;
      const stop = linkButton(tr("Stop dem, og kobl fra", "Stop them and disconnect"), () =>
        void this.act(async () => {
          for (const s of await live()) await invoke("share_end", { id: s.id, delete: false });
          await disconnect();
        }),
      );
      const keep = linkButton(tr("Kobl fra, og lad dem virke", "Disconnect and keep them"), () => void this.act(disconnect));
      const back = linkButton(tr("Fortryd", "Cancel"), () => {
        this.offAsk = null;
        this.render();
      });
      const choices = actions(stop, keep, back);
      return group(
        null,
        row(tr("Kobl enheden fra", "Disconnect this device"), choices, {
          hint: tr(
            `${n === 1 ? "1 deling virker" : `${n} delinger virker`} stadig for gæsterne. Kobler du fra, kan du først stoppe ${n === 1 ? "den" : "dem"} igen, når enheden er forbundet.`,
            `${n === 1 ? "1 share still works" : `${n} shares still work`} for the guests. Once disconnected, you can only stop ${n === 1 ? "it" : "them"} after connecting again.`,
          ),
        }),
      );
    }
    const off = linkButton(tr("Kobl fra", "Disconnect"), () =>
      void this.act(async () => {
        // Uden net kan listen ikke hentes. Så kobles der fra som før, for det skal altid kunne lade sig gøre.
        const n = this.status?.owner ? await live().then((l) => l.length, () => 0) : 0;
        if (n > 0) this.offAsk = n;
        else await disconnect();
      }),
    );
    return group(
      null,
      row(tr("Kobl enheden fra", "Disconnect this device"), off, {
        hint: onPhone()
          ? tr("Filerne på telefonen bliver liggende, og serveren beholder sin kopi.", "Files stay on the phone, and the server keeps its copy.")
          : tr("Filerne på denne pc bliver liggende, og serveren beholder sin kopi.", "Files stay on this computer, and the server keeps its copy."),
      }),
    );
  }
}

function actions(...buttons: HTMLElement[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "st-actions";
  box.append(...buttons);
  return box;
}

/** Delinger, der stadig virker for gæsterne (samme regel som fanen Deling). */
async function live(): Promise<{ id: string }[]> {
  const all = await invoke<{ id: string; expires: number; revoked: boolean }[]>("share_list");
  return all.filter((s) => !s.revoked && s.expires * 1000 >= Date.now());
}

/** Konflikter vises som et banner, uanset hvor brugeren er i programmet. */
export function installSynkNotices(): void {
  void listen<string[]>("synk-konflikt", (e) => {
    for (const copy of e.payload) {
      showBanner(
        tr(
          `To udgaver af samme tekst. Din udgave ligger nu i »${copy}«, og filen har den nyeste fra serveren.`,
          `Two versions of the same text. Yours is now in "${copy}", and the file has the newest from the server.`,
        ),
      );
    }
  });
}
