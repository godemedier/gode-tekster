// »Skriv til Gode Medier« (delbar udgave 3/10): en lille formular i stedet for en mail, så
// det også virker uden et mailprogram. Beskeden går via tekster.godemedier.dk til Gode Mediers indbakke.
// Fejlloggen kommer kun med, når der er sat flueben, og man kan se præcis, hvad der sendes.
// Kan beskeden ikke sendes, tilbydes mailen som før (about.rs write_feedback_mail).

import { invoke } from "@tauri-apps/api/core";
import { errorText, notify, showBanner } from "./banner.ts";
import { rememberFocus, trapTab } from "./focus.ts";
import { ICON, iconButton } from "./icons.ts";
import { tr } from "../i18n.ts";

export class FeedbackDialog {
  private sheet: HTMLElement;
  private restore: (() => void) | null = null;

  constructor() {
    this.sheet = document.createElement("div");
    this.sheet.className = "settings feedback";
    this.sheet.setAttribute("role", "dialog");
    this.sheet.setAttribute("aria-modal", "true");
    this.sheet.setAttribute("aria-label", tr("Skriv til Gode Medier", "Write to Gode Medier"));
    this.sheet.hidden = true;
    this.sheet.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      } else trapTab(this.sheet, e);
    });
    this.sheet.addEventListener("mousedown", (e) => {
      if (e.target === this.sheet) this.close();
    });
    document.body.append(this.sheet);
  }

  open(): void {
    this.restore = rememberFocus();
    this.render();
    this.sheet.hidden = false;
    document.body.classList.add("settings-open");
    window.setTimeout(() => this.sheet.querySelector<HTMLElement>("textarea")?.focus(), 0);
    requestAnimationFrame(() => this.sheet.classList.add("open"));
  }

  close(): void {
    if (this.sheet.hidden) return;
    document.body.classList.remove("settings-open");
    this.restore?.();
    this.restore = null;
    this.sheet.classList.remove("open");
    window.setTimeout(() => {
      if (!this.sheet.classList.contains("open")) this.sheet.hidden = true;
    }, 220);
  }

  private render(): void {
    const head = document.createElement("div");
    head.className = "settings-head";
    const title = document.createElement("span");
    title.textContent = tr("Skriv til Gode Medier", "Write to Gode Medier");
    head.append(title, iconButton(ICON.close, tr("Luk (Esc)", "Close (Esc)"), () => this.close()));

    const message = document.createElement("textarea");
    message.className = "feedback-message";
    message.placeholder = tr("Hvad virker, hvad driller, og hvad mangler du?", "What works, what bugs you, and what are you missing?");
    message.setAttribute("aria-label", tr("Besked", "Message"));
    message.maxLength = 5000;

    const reply = document.createElement("input");
    reply.type = "email";
    reply.className = "settings-name";
    reply.placeholder = tr("Din mail, hvis du vil have svar", "Your email, if you want a reply");
    reply.setAttribute("aria-label", tr("Din mail (valgfri)", "Your email (optional)"));

    const logLabel = document.createElement("label");
    logLabel.className = "feedback-check";
    const withLog = document.createElement("input");
    withLog.type = "checkbox";
    logLabel.append(withLog, tr(" Send fejlloggen med. Den indeholder ingen tekst fra dine dokumenter.", " Include the error log. It contains no text from your documents."));

    const preview = document.createElement("pre");
    preview.className = "settings-licenses";
    preview.hidden = true;
    const show = document.createElement("button");
    show.type = "button";
    show.className = "settings-link";
    show.textContent = tr("Se, hvad der sendes", "See what will be sent");
    show.addEventListener("click", async () => {
      if (preview.hidden) preview.textContent = (await invoke<string>("feedback_log")) || tr("Loggen er tom.", "The log is empty.");
      preview.hidden = !preview.hidden;
    });

    const send = document.createElement("button");
    send.type = "button";
    send.className = "feedback-send";
    send.textContent = tr("Send", "Send");
    send.addEventListener("click", async () => {
      send.disabled = true;
      send.textContent = tr("Sender …", "Sending …");
      try {
        await invoke("send_feedback", { message: message.value, replyTo: reply.value, includeLog: withLog.checked });
        this.close();
        notify(tr("Tak. Beskeden er sendt.", "Thanks. Your message has been sent."));
      } catch (e) {
        send.disabled = false;
        send.textContent = tr("Send", "Send");
        showBanner(errorText(e), [{ label: tr("Skriv en mail i stedet", "Write an email instead"), run: () => void mail() }]);
      }
    });
    const mail = () => invoke("write_feedback_mail", { subject: "Gode Tekster" }).catch((e) => showBanner(errorText(e)));
    const orMail = document.createElement("button");
    orMail.type = "button";
    orMail.className = "settings-link";
    orMail.textContent = tr("Eller skriv en mail til troels@godemedier.dk", "Or write an email to troels@godemedier.dk");
    orMail.addEventListener("click", () => void mail().then(() => this.close()));

    const actions = document.createElement("div");
    actions.className = "feedback-actions";
    actions.append(orMail, send);

    const box = document.createElement("div");
    box.className = "settings-box feedback-box";
    box.append(head, message, reply, logLabel, show, preview, actions);
    this.sheet.replaceChildren(box);
  }
}
