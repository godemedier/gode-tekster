// Fanen Synk i Indstillinger (ADR-0054): forbind enheden, se prøvekørslen, start synken, og følg
// med i, hvad den gør. Synken selv kører i Rust (synk/service.rs). Fanen viser kun status.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { tr } from "../i18n.ts";
import { errorText, showBanner } from "./banner.ts";
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
  for (const [path, why] of p.skipped.slice(0, 5)) lines.push(tr(`Synkes ikke: ${path}. ${why}`, `Not synced: ${path}. ${why}`));
  if (p.skipped.length > 5) lines.push(tr(`… og ${p.skipped.length - 5} filer mere, der ikke kan synkes.`, `… and ${p.skipped.length - 5} more.`));
  if (!lines.length) lines.push(tr("Der er ingen tekster at synke endnu.", "There is nothing to sync yet."));
  return lines;
}

export class SynkPanel {
  readonly el = document.createElement("div");
  private status: SynkStatus | null = null;
  private preview: Preview | null = null;
  private pairing: { code: string; expires: number } | null = null;
  private busy = false;

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
    if (!s?.connected) this.el.replaceChildren(this.connectForm());
    else if (!s.started) this.el.replaceChildren(this.previewView(s));
    else this.el.replaceChildren(this.statusView(s));
  }

  private connectForm(): HTMLElement {
    const server = input(DEFAULT_SERVER, { label: tr("Serverens adresse", "Server address") });
    const name = input("Pc", { label: tr("Enhedens navn", "Device name") });
    const code = input("", { label: tr("Parringskode", "Pairing code"), placeholder: "ABCD-EFGH" });
    const admin = input("", { password: true, label: tr("Ejernøgle", "Owner key") });
    const go = linkButton(this.busy ? tr("Forbinder …", "Connecting …") : tr("Forbind", "Connect"), () =>
      void this.act(async () => {
        this.status = await invoke<SynkStatus>("synk_connect", {
          server: server.value,
          name: name.value,
          code: code.value.trim() || null,
          admin: admin.value.trim() || null,
        });
        admin.value = "";
        this.preview = null;
      }),
    );
    return panel(
      group(
        tr("Synk af Dokumenter", "Sync Documents"),
        note(
          tr(
            "Teksterne i Dokumenter synkes med din egen server, så du kan skrive videre på telefonen og i browseren. Kun tekst og billeder i medier-mapper kommer med.",
            "Your texts in Documents sync with your own server. Only text and images in media folders are included.",
          ),
        ),
        row(tr("Serverens adresse", "Server address"), server),
        row(tr("Enhedens navn", "Device name"), name, { hint: tr("Står i navnet på en konfliktkopi.", "Used in the name of a conflict copy.") }),
        row(tr("Parringskode", "Pairing code"), code, {
          hint: tr("Lav koden på en enhed, der allerede er forbundet.", "Create the code on a device that is already connected."),
        }),
        row(tr("Ejernøgle", "Owner key"), admin, {
          hint: tr("Kun til den første enhed. Den står i Coolify som ADMIN_TOKEN.", "Only for the first device (ADMIN_TOKEN in Coolify)."),
        }),
        row("", go),
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
    const start = linkButton(tr("Start synken", "Start syncing"), () =>
      void this.act(async () => {
        this.status = await invoke<SynkStatus>("synk_start");
      }),
    );
    const controls = document.createElement("div");
    controls.append(run, ...(this.preview ? [start] : []));
    return panel(
      group(
        tr("Før første synk", "Before the first sync"),
        note(tr(`Forbundet til ${s.server} som »${s.device}«. Mappen er ${s.root}.`, `Connected to ${s.server} as "${s.device}". Folder: ${s.root}.`)),
        note(
          tr(
            "Prøvekørslen tæller, hvad den første synk vil gøre, uden at ændre noget. Den første synk sletter aldrig. Den lægger kun sammen.",
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
          ? tr(`Synkroniseret ${s.lastSync.slice(11)}`, `Synced ${s.lastSync.slice(11)}`)
          : tr("Venter på første runde.", "Waiting for the first round.");
    const now = linkButton(tr("Synk nu", "Sync now"), () => void invoke("synk_now"));
    const rows: HTMLElement[] = [
      row(tr("Status", "Status"), Object.assign(document.createElement("span"), { textContent: state })),
      row(tr("Server", "Server"), Object.assign(document.createElement("span"), { textContent: s.server ?? "" })),
      row(tr("Enhed", "Device"), Object.assign(document.createElement("span"), { textContent: s.device ?? "" })),
      row(tr("Mappe", "Folder"), Object.assign(document.createElement("span"), { textContent: s.root ?? "" })),
      row("", now),
    ];
    if (s.heldDeletes > 0) {
      const yes = linkButton(tr("Slet dem", "Delete them"), () => void invoke("synk_allow_deletes"));
      rows.push(
        row(
          tr("Bremsen", "Brake"),
          yes,
          {
            hint: tr(
              `${s.heldDeletes} filer er slettet på én gang. Synken holder sletningerne tilbage, til du siger ja. Var det en fejl, så hent filerne tilbage fra papirkurven først.`,
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
    return panel(
      group(tr("Synk af Dokumenter", "Sync Documents"), ...rows),
      group(
        tr("Ny enhed", "New device"),
        row(tr("Parringskode", "Pairing code"), pairBox, {
          hint: tr("Tast koden på telefonen inden for ti minutter. Den virker én gang.", "Enter the code on the phone within ten minutes. It works once."),
        }),
      ),
      group(tr("Sidst", "Recent"), s.log.length ? log : note(tr("Intet endnu.", "Nothing yet."))),
      this.disconnectGroup(),
    );
  }

  private disconnectGroup(): HTMLElement {
    const off = linkButton(tr("Kobl fra", "Disconnect"), () =>
      void this.act(async () => {
        this.status = await invoke<SynkStatus>("synk_disconnect");
        this.preview = null;
        this.pairing = null;
      }),
    );
    return group(
      null,
      row(tr("Kobl enheden fra", "Disconnect this device"), off, {
        hint: tr("Filerne på denne pc bliver liggende, og serveren beholder sin kopi.", "Files stay on this computer, and the server keeps its copy."),
      }),
    );
  }
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
