// Deling (ADR-0060): dialogen »Del …« og fanen »Deling« i højre spalte. Rust taler med
// synkserveren og husker delingerne (shares.rs). Her vælges delen, det private tages ud
// (extract.ts), og forslagene hentes ind i editoren som en rettelse udefra, så fortryd virker.

import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";

import { resolvePending } from "../editor/critic.ts";
import { errorText, notify, showBanner } from "../ui/banner.ts";
import { locale, tr } from "../i18n.ts";
import { genitive, shareable } from "./extract.ts";
import { el } from "../ui/dom.ts";

type LinkView = { id: string; name: string; url: string | null; rev: number; fetchedRev: number; updated: number | null; lastSeen: number | null };
type ShareView = { id: string; title: string; path: string | null; created: number; expires: number; revoked: boolean; links: LinkView[] };
type Change = { from: number; to: number; insert: string };
type Outcome = { kind: "nothing" } | { kind: "changes"; changes: Change[]; shadow: string } | { kind: "conflict"; part: string };
type Fetched = { outcome: Outcome; base: string; guest: string; rev: number; path: string };

/** Hvor længe linkene virker (besluttet 20/10). */
const DAYS = 30;
/** Listen hentes højst så tit, når spalten tegnes om (den tegnes om efter hvert tastetryk). */
const REFRESH_MS = 30_000;

export type ShareHost = {
  view: EditorView;
  /** Stien til den åbne tekst, eller null. */
  path: () => string | null;
  /** Åbn en tekst og vent, til den står i editoren. */
  open: (path: string) => Promise<void>;
  /** Fanen skal tegnes om (listen er hentet). */
  redraw: () => void;
};

const fileName = (p: string) => p.slice(p.lastIndexOf("\\") + 1).replace(/\.(md|markdown|txt)$/i, "");
const date = (secs: number) => new Date(secs * 1000).toLocaleDateString(locale(), { day: "numeric", month: "long" });

export class SharesPanel {
  private shares: ShareView[] = [];
  private loaded = 0;
  private loading = false;
  private error: string | null = null;

  private host: ShareHost;

  constructor(host: ShareHost) {
    this.host = host;
  }

  // --- Del ... -------------------------------------------------------------------------------

  /** Del det markerede, eller hele teksten, når intet er markeret. */
  share(): void {
    const path = this.host.path();
    if (!path) return;
    const { view } = this.host;
    const sel = view.state.selection.main;
    const whole = sel.empty;
    const from = whole ? 0 : sel.from;
    const to = whole ? view.state.doc.length : sel.to;
    const snapshot = view.state.doc.toString();
    const { base, removed } = shareable(snapshot.slice(from, to));
    if (!base.trim()) {
      showBanner(tr("Der er ikke noget at dele i det markerede.", "There is nothing to share in the selection."));
      return;
    }
    const heading = /^#{1,6}\s+(.+)$/m.exec(base)?.[1]?.trim();
    const title = heading || fileName(path);

    const dialog = el("dialog", "structure-dialog small-dialog share-dialog");
    const head = el("header", "");
    const titles = el("div", "");
    titles.append(
      el("h2", "", whole ? tr("Del teksten", "Share the text") : tr("Del det markerede", "Share the selection")),
      el(
        "p",
        "",
        tr(
          `Noter, parkeret og dæmpet tekst bliver hjemme. Linkene virker i ${DAYS} dage.`,
          `Notes, parked and dimmed text stay here. The links work for ${DAYS} days.`,
        ),
      ),
    );
    head.append(titles);
    const body = el("div", "modal-body");
    const label = el("label", "share-label", tr("Del med", "Share with"));
    const names = el("input", "share-names");
    names.type = "text";
    names.placeholder = tr("Andreas, Kim", "Andreas, Kim");
    names.spellcheck = false;
    label.append(names);
    const hint = el(
      "p",
      "share-hint",
      tr(
        "Hver person får sit eget link. Det, de skriver, bliver forslag, som du henter ind under fanen Deling.",
        "Each person gets their own link. What they write becomes suggestions you fetch from the Sharing tab.",
      ),
    );
    body.append(label, hint);
    const foot = el("footer", "");
    const cancel = el("button", "outline", tr("Annullér", "Cancel"));
    const go = el("button", "primary", tr("Del", "Share"));
    cancel.type = go.type = "button";
    foot.append(cancel, go);
    dialog.append(head, body, foot);
    document.body.append(dialog);
    const close = () => {
      dialog.close();
      dialog.remove();
      view.focus();
    };
    cancel.addEventListener("click", close);
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      close();
    });

    const submit = async () => {
      const list = names.value.split(/[,;]/).map((n) => n.trim()).filter(Boolean);
      if (!list.length) {
        names.focus();
        return;
      }
      go.disabled = true;
      try {
        const share = await invoke<ShareView>("share_create", {
          req: { path, title, snapshot, from, to, base, removed, names: list, days: DAYS },
        });
        this.loaded = 0;
        this.showLinks(dialog, body, foot, share, close);
        this.host.redraw();
      } catch (e) {
        go.disabled = false;
        hint.textContent = errorText(e);
        hint.classList.add("share-error");
      }
    };
    go.addEventListener("click", () => void submit());
    names.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    });
    dialog.showModal();
    names.focus();
  }

  /** Efter deling: linkene, som skribenten selv sender videre. */
  private showLinks(dialog: HTMLDialogElement, body: HTMLElement, foot: HTMLElement, share: ShareView, close: () => void): void {
    (dialog.querySelector("h2") as HTMLElement).textContent = tr("Delt", "Shared");
    body.replaceChildren(
      el("p", "share-hint", tr("Send linket til hver person selv. Det virker kun for den, der har det.", "Send each person their link yourself. It only works for whoever has it.")),
      ...share.links.map((l) => this.linkRow(l)),
    );
    const done = el("button", "primary", tr("Færdig", "Done"));
    done.type = "button";
    done.addEventListener("click", close);
    foot.replaceChildren(done);
    done.focus();
  }

  private linkRow(l: LinkView): HTMLElement {
    const row = el("div", "share-link");
    row.append(el("strong", "", l.name));
    if (l.url) {
      const url = el("input", "share-url");
      url.readOnly = true;
      url.value = l.url;
      url.addEventListener("focus", () => url.select());
      const copy = el("button", "outline", tr("Kopiér", "Copy"));
      copy.type = "button";
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(l.url ?? "").then(() => {
          copy.textContent = tr("Kopieret", "Copied");
        });
      });
      row.append(url, copy);
    }
    return row;
  }

  // --- fanen Deling --------------------------------------------------------------------------

  render(body: HTMLElement): void {
    if (Date.now() - this.loaded > REFRESH_MS && !this.loading) void this.load();
    const wrap = el("div", "share-panel");
    if (this.host.path()) {
      const sel = this.host.view.state.selection.main;
      const btn = el("button", "rp-btn share-new", sel.empty ? tr("Del teksten …", "Share the text …") : tr("Del det markerede …", "Share the selection …"));
      btn.type = "button";
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => this.share());
      wrap.append(btn);
    }
    if (this.error) wrap.append(el("p", "rp-empty", this.error));
    else if (!this.shares.length) {
      wrap.append(
        el(
          "p",
          "rp-empty",
          this.loading && !this.loaded
            ? tr("Henter delinger …", "Loading shares …")
            : tr("Du har ikke delt noget endnu. Brug knappen ovenfor, eller markér et stykke og højreklik.", "You haven't shared anything yet. Use the button above, or select a passage and right-click."),
        ),
      );
    }
    for (const s of this.shares) wrap.append(this.card(s));
    body.replaceChildren(wrap);
  }

  /** Personer med nye forslag, der ikke er hentet ind (tallet på ikonet i højrespalten). */
  fresh(): number {
    return this.shares.filter((s) => !s.revoked).reduce((n, s) => n + s.links.filter((l) => l.rev > l.fetchedRev).length, 0);
  }

  /** Ved start: så prikken for nye forslag står på ikonet, før fanen har været åben (UX 20/10). */
  preload(): Promise<void> {
    return this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    try {
      this.shares = await invoke<ShareView[]>("share_list");
      this.error = null;
    } catch (e) {
      this.error = errorText(e);
    } finally {
      this.loaded = Date.now();
      this.loading = false;
      this.host.redraw();
    }
  }

  private card(s: ShareView): HTMLElement {
    const card = el("div", "rp-card share-card");
    card.dataset.shareId = s.id;
    const head = el("div", "share-head");
    head.append(el("strong", "", s.title || tr("Uden titel", "Untitled")));
    const sub = s.revoked
      ? tr("Stoppet", "Stopped")
      : s.expires * 1000 < Date.now()
        ? tr("Udløbet", "Expired")
        : tr(`Virker til ${date(s.expires)}`, `Works until ${date(s.expires)}`);
    head.append(el("span", "share-sub", s.path ? `${fileName(s.path)} · ${sub}` : sub));
    card.append(head);
    const live = !s.revoked && s.expires * 1000 >= Date.now();
    for (const l of s.links) card.append(this.person(s, l, live));
    const actions = el("div", "share-actions share-end");
    // Et udløbet eller stoppet link kan ikke stoppes igen (UX 20/10).
    if (live) actions.append(this.action(tr("Stop deling", "Stop sharing"), () => this.end(s, false)));
    actions.append(this.confirmed(tr("Slet", "Delete"), tr("Slet alligevel?", "Delete anyway?"), () => this.end(s, true)));
    card.append(actions);
    return card;
  }

  /**
   * En knap, der først virker ved andet klik: »Slet« sletter også på serveren og kan ikke fortrydes.
   * Samme mønster som »Slet alligevel?« i Kilder. Spørgsmålet forsvinder igen efter 4 s.
   */
  private confirmed(label: string, ask: string, run: () => Promise<void> | void): HTMLButtonElement {
    let armed = false;
    let timer: number | undefined;
    const b = this.action(label, () => {
      if (!armed) {
        armed = true;
        b.textContent = ask;
        b.classList.add("share-armed");
        timer = window.setTimeout(() => {
          armed = false;
          b.textContent = label;
          b.classList.remove("share-armed");
        }, 4000);
        return;
      }
      window.clearTimeout(timer);
      return run();
    });
    return b;
  }

  private person(s: ShareView, l: LinkView, live: boolean): HTMLElement {
    const row = el("div", "share-person");
    const fresh = l.rev > l.fetchedRev;
    const status = fresh
      ? tr("Har nye forslag", "Has new suggestions")
      : l.updated
        ? tr("Intet nyt", "Nothing new")
        : l.lastSeen
          ? tr("Har set den", "Has seen it")
          : tr("Har ikke åbnet den", "Hasn't opened it");
    const who = el("div", "share-who");
    who.append(el("span", "", l.name), el("span", fresh ? "share-status share-fresh" : "share-status", status));
    row.append(who);
    const buttons = el("div", "share-actions");
    // Kun når der er noget at hente. Det er den handling, fanen er til, så den er en rigtig knap.
    if (s.path && fresh) {
      const get = this.action(tr("Hent forslag", "Fetch suggestions"), () => this.fetch(s, l));
      get.className = "rp-btn rp-btn-primary share-get";
      buttons.append(get);
    }
    if (l.url && live) {
      buttons.append(
        this.action(tr("Kopiér link", "Copy link"), async () => {
          await navigator.clipboard.writeText(l.url ?? "");
          notify(tr(`${genitive(l.name)} link er kopieret.`, `${l.name}'s link is copied.`));
        }),
      );
    }
    row.append(buttons);
    return row;
  }

  private action(label: string, run: () => Promise<void> | void): HTMLButtonElement {
    const b = el("button", "rp-link share-action", label);
    b.type = "button";
    b.addEventListener("click", () => {
      b.disabled = true;
      void Promise.resolve(run())
        .catch((e: unknown) => showBanner(errorText(e)))
        .finally(() => {
          b.disabled = false;
        });
    });
    return b;
  }

  private async end(s: ShareView, del: boolean): Promise<void> {
    await invoke("share_end", { id: s.id, delete: del });
    notify(
      del
        ? tr("Delingen er slettet, også på serveren.", "The share is deleted, also on the server.")
        : tr("Delingen er stoppet. Linkene virker ikke længere.", "Sharing stopped. The links no longer work."),
    );
    this.loaded = 0;
    await this.load();
  }

  /** Hent én persons forslag ind i teksten, som de står nu. */
  private async fetch(s: ShareView, l: LinkView, anyway = false): Promise<void> {
    if (!s.path) return;
    if (this.host.path()?.toLowerCase() !== s.path.toLowerCase()) await this.host.open(s.path);
    const { view } = this.host;
    const current = view.state.doc.toString();
    const r = await invoke<Fetched>("share_merge", { id: s.id, link: l.id, current });
    const who = genitive(l.name);
    // Gæstens side laver alt om til forslag. Er teksten ændret ud over det, er der rettet uden om
    // siden (eller der er en fejl), og det skal skribenten vide, før noget hentes ind.
    if (!anyway && resolvePending(r.guest) !== resolvePending(r.base)) {
      showBanner(
        tr(
          `${l.name} har ændret teksten uden for forslagene. Ændringerne vil stå direkte i din tekst.`,
          `${l.name} changed the text outside the suggestions. The changes would go straight into your text.`,
        ),
        [{ label: tr("Hent alligevel", "Fetch anyway"), run: () => void this.fetch(s, l, true).catch((e: unknown) => showBanner(errorText(e))) }],
      );
      return;
    }
    if (view.state.doc.toString() !== current) {
      showBanner(tr("Du skrev videre, mens forslagene blev hentet. Prøv igen.", "You kept writing while the suggestions loaded. Try again."));
      return;
    }
    const o = r.outcome;
    if (o.kind === "nothing") {
      notify(tr(`Ingen nye forslag fra ${l.name}.`, `No new suggestions from ${l.name}.`));
    } else if (o.kind === "changes") {
      view.dispatch({ changes: o.changes, userEvent: "input.external", scrollIntoView: true });
      await invoke("share_fetched", { id: s.id, link: l.id, shadow: o.shadow, rev: r.rev });
      notify(
        tr(
          `${who} forslag er hentet ind. Godtag eller afvis dem ét ad gangen.`,
          `${who} suggestions are in. Accept or reject them one at a time.`,
        ),
      );
    } else {
      await navigator.clipboard.writeText(o.part);
      showBanner(
        tr(
          `Du har rettet de samme steder, som ${l.name} har forslag til, så de kan ikke flettes ind af sig selv. ${who} udgave af delen ligger på udklipsholderen, så du kan sætte den ind, hvor du vil.`,
          `You changed the same places ${l.name} has suggestions for, so they can't be merged automatically. ${who} version of the part is on the clipboard, so you can paste it where you like.`,
        ),
      );
    }
    this.loaded = 0;
    await this.load();
  }
}
