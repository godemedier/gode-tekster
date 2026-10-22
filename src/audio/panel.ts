import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { audioSource } from "./document.ts";
import { errorText, showBanner } from "../ui/banner.ts";
import { tr } from "../i18n.ts";
import { aiStatus } from "../ui/ai.ts";

type Info = { id: string; name: string; duration: number; playbackPath: string };
type Support = { ready: boolean; provider: string | null; detail: string };
type Progress = { done: number; total: number; retry: number; waitSeconds: number };
const button = (label: string, run: () => void, cls = "rp-btn") => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.onclick = run;
  return b;
};
const note = (text: string, cls = "") => {
  const p = document.createElement("p");
  if (cls) p.className = cls;
  p.textContent = text;
  return p;
};
const row = (...items: HTMLElement[]) => {
  const d = document.createElement("div");
  d.className = "rp-row";
  d.append(...items);
  return d;
};
export class AudioPanel {
  private view: EditorView;
  private path: () => string | null;
  private open: (path: string) => Promise<void>;
  private body: HTMLElement | null = null;
  private id: string | null = null;
  private info: Info | null = null;
  private support: Support | null = null;
  /** Navnet på tjenesten, der skriver lyden ud (Gemini), til linjen i den tomme fane. */
  private service: string | null = null;
  /** FFmpeg mangler: kun da vises »Vælg FFmpeg …« (UX 20/10). */
  private toolsMissing = false;
  private player = document.createElement("audio");
  private controls = document.createElement("div");
  private busy = false;
  private status = "";
  private partial = false;
  private complete = false;
  private language = "da";
  private openedPath: string | null = null;
  private recoveries: string[] = [];
  private progress: Progress | null = null;
  private phase: "prepare" | "transcribe" | "save" | null = null;
  private started = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private saveFailed = false;
  private savedPath: string | null = null;
  constructor(view: EditorView, path: () => string | null, open: (path: string) => Promise<void>) {
    this.view = view; this.path = path; this.open = open;
    this.player.controls = true; this.player.preload = "metadata";
    this.player.onerror = () => showBanner(tr("Lyden kunne ikke afspilles. Prøv at åbne optagelsen igen.", "Audio could not be played. Try reopening the recording."));
    window.addEventListener("gt-ai-changed", () => { void this.refreshSupport(); });
    void invoke<string[]>("audio_recoveries").then(ids => {this.recoveries=ids;this.refresh();}).catch(e=>showBanner(errorText(e)));
    void this.refreshSupport();
    void this.checkTools();
  }
  render(host: HTMLElement): void {
    this.body = host;
    if (this.player.parentElement !== host) host.replaceChildren(this.player, this.controls);
    this.player.hidden = !this.info;
    const body = this.controls;
    body.className = "audio-panel";
    const parts: HTMLElement[] = [];
    if (!this.info) {
      // Tom fane (UX 20/10): én linje om hvad fanen gør, og én knap.
      const who = this.support?.ready && this.service ? this.service : null;
      parts.push(note(
        who
          ? tr(`Vælg en optagelse, så skriver ${who} den ud.`, `Choose a recording and ${who} will transcribe it.`)
          : tr("Vælg en optagelse, så skriver AI-hjælpen den ud.", "Choose a recording and AI help will transcribe it."),
        "rp-lead",
      ));
      const pick = button(tr("Vælg optagelse …", "Choose recording …"), () => void this.pick(), "rp-btn rp-btn-primary");
      pick.disabled = this.busy;
      const actions = row(pick);
      const current = audioSource(this.view.state.doc.toString());
      if (current && !this.busy) actions.append(button(tr("Åbn optagelsen", "Open recording"), () => void this.seek(current.audio, 0)));
      parts.push(actions);
      if (this.support && !this.support.ready && !this.busy) parts.push(note(this.support.detail, "audio-note"));
      if (this.toolsMissing && !this.busy) {
        parts.push(row(
          note(tr("FFmpeg mangler. Programmet bruger det til at læse lydfilen.", "FFmpeg is missing. The app uses it to read the audio file."), "audio-note"),
          button(tr("Vælg FFmpeg …", "Select FFmpeg …"), () => void this.pickTools(), "rp-link"),
        ));
      }
    } else {
      parts.push(note(this.info.name, "audio-name"));
      const speed = document.createElement("select");
      speed.setAttribute("aria-label", tr("Afspilningshastighed", "Playback speed"));
      for (const rate of [0.75, 1, 1.25, 1.5, 2]) speed.add(new Option(`${rate}×`, String(rate)));
      speed.value = String(this.player.playbackRate);
      speed.onchange = () => { this.player.playbackRate = Number(speed.value); };
      const language = document.createElement("select");
      language.setAttribute("aria-label", tr("Sprog i optagelsen", "Recording language"));
      for (const [id, label] of [["da", tr("Dansk", "Danish")], ["en", tr("Engelsk", "English")], ["auto", tr("Find sproget", "Detect language")]]) language.add(new Option(label, id));
      const hasCompleted = this.partial || (this.progress?.done ?? 0) > 0;
      language.value = this.language;
      language.disabled = this.busy || hasCompleted;
      language.onchange = () => { this.language = language.value; };
      parts.push(row(speed, language));
      if (this.support) parts.push(note(this.support.detail, "audio-note"));
      const start = button(hasCompleted ? tr("Fortsæt transskription", "Continue transcription") : tr("Transskriber", "Transcribe"), () => void this.transcribe(), "rp-btn rp-btn-primary");
      start.disabled = this.busy || this.complete || !this.support?.ready;
      const actions = row(start);
      if (this.partial) {
        const save = button(tr("Gem og ret teksten", "Save and edit text"), () => void this.save());
        save.disabled = this.busy;
        actions.append(save);
      }
      parts.push(actions);
    }
    if (this.busy && this.phase !== "save") {
      parts.push(row(button(tr("Stop", "Stop"), () => {
        if (this.id) void invoke("audio_cancel", { id: this.id }).catch((e) => showBanner(errorText(e)));
        this.status = tr("Stopper. Venter på det aktuelle svar …", "Stopping. Waiting for the current response …");
        this.refresh();
      })));
    }
    if (this.busy && this.phase) {
      const progress = document.createElement("progress");
      progress.className = "audio-progress";
      progress.setAttribute("aria-label", tr("Transskriptionens fremdrift", "Transcription progress"));
      if (this.phase === "transcribe" && this.progress) { progress.max = this.progress.total; progress.value = this.progress.done; }
      parts.push(progress, note("", "audio-elapsed"));
    }
    if (this.saveFailed && this.partial && !this.busy) parts.push(row(button(tr("Gem et andet sted …", "Save elsewhere …"), () => void this.save(true))));
    if (this.status) {
      const p = note(this.status, "audio-note");
      p.setAttribute("role", "status");
      parts.push(p);
    }
    // Det sjældne samles i én række links nederst.
    const links: HTMLElement[] = [];
    if (this.info) {
      const other = button(tr("Vælg en anden optagelse …", "Choose another recording …"), () => void this.pick(), "rp-link");
      other.disabled = this.busy;
      links.push(other);
    }
    if (this.id && !this.busy) links.push(button(tr("Luk optagelsen", "Close recording"), () => void this.close(), "rp-link"));
    if (this.partial && !this.busy) links.push(button(tr("Kassér transskription …", "Discard transcript …"), () => {
      const id = this.id;
      showBanner(tr("Kassér den ugemte transskription? Optagelsen bliver liggende.", "Discard the unsaved transcript? The recording is kept."), [{ label: tr("Kassér", "Discard"), run: async () => {
        if (this.id !== id || !this.partial || this.busy) return;
        this.busy = true;
        try { await invoke("audio_discard", { id }); this.partial = false; await this.close(); }
        finally { this.busy = false; this.refresh(); }
      } }], { closable: true });
    }, "rp-link"));
    if (links.length) parts.push(row(...links));
    if (this.recoveries.length) {
      const details = document.createElement("details");
      details.className = "audio-recoveries";
      const summary = document.createElement("summary");
      summary.textContent = tr(`Ugemte transskriptioner (${this.recoveries.length})`, `Unsaved transcripts (${this.recoveries.length})`);
      details.append(summary);
      for (const id of this.recoveries) {
        const when = new Date(Number(id.split("-")[1])).toLocaleString();
        details.append(row(
          note(when),
          button(tr("Gem …", "Save …"), () => void this.recover(id)),
          button(tr("Slet …", "Delete …"), () => showBanner(tr(`Slet den ugemte transskription fra ${when}? Den kan ikke hentes tilbage.`, `Delete the unsaved transcript from ${when}? It cannot be recovered.`), [{ label: tr("Slet", "Delete"), run: () => void this.forget(id) }], { closable: true }), "rp-link"),
        ));
      }
      parts.push(details);
    }
    body.replaceChildren(...parts);
    this.updateElapsed();
  }
  private refresh():void { if(this.body?.dataset.tab==="lyd")this.render(this.body); }
  private async reloadRecoveries():Promise<void> { this.recoveries=await invoke<string[]>("audio_recoveries");this.refresh(); }
  /** Nødkopien gemmes, hvor brugeren vælger, og åbnes derfra. Aldrig i den skjulte jobmappe. */
  private async recover(id:string):Promise<void> {
    try { const path=await invoke<string|null>("audio_recover",{id});if(!path)return;await this.reloadRecoveries();await this.open(path); }
    catch(e){showBanner(errorText(e));}
  }
  private async forget(id:string):Promise<void> {
    try { await invoke("audio_forget_recovery",{id});await this.reloadRecoveries(); }
    catch(e){showBanner(errorText(e));}
  }
  private updateElapsed(): void {
    const elapsed = this.controls.querySelector(".audio-elapsed");
    if (!elapsed) return;
    const seconds = Math.floor((Date.now() - this.started) / 1000);
    const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    elapsed.textContent = tr(`Tid: ${time}`, `Elapsed: ${time}`);
  }
  private startClock(phase: "prepare" | "transcribe" | "save"): void {
    this.stopClock(); this.phase = phase; this.started = Date.now();
    this.timer = setInterval(() => this.updateElapsed(), 1000);
  }
  private stopClock(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.phase = null; }
  private async refreshSupport(): Promise<void> {
    try {
      const [support, ai] = await Promise.all([invoke<Support>("audio_support"), aiStatus().catch(() => null)]);
      this.support = support;
      this.service = ai?.providers.find((p) => p.id === support.provider)?.name ?? null;
      this.refresh();
    } catch (e) { showBanner(errorText(e)); }
  }
  private async checkTools(): Promise<void> {
    // Kan det ikke afgøres, vises knappen som før.
    this.toolsMissing = !(await invoke<boolean>("audio_tools_ready").catch(() => false));
    this.refresh();
  }
  private async pickTools(): Promise<void> {
    try { if (await invoke<boolean>("pick_audio_tools")) { this.toolsMissing = false; this.refresh(); } }
    catch (e) { showBanner(errorText(e)); }
  }
  private async prepare(id:string):Promise<void> {
    this.id=id;this.busy=true;this.startClock("prepare");this.status=tr("Gør optagelsen klar …","Preparing recording …");this.refresh();
    try {
      this.info=await invoke<Info>("audio_prepare",{id});
      this.player.src=convertFileSrc(this.info.playbackPath);
      this.support=await invoke<Support>("audio_support");this.status="";
    } catch(e) {this.status=errorText(e);void this.checkTools();}
    finally {this.stopClock();this.busy=false;this.refresh();}
  }
  private async pick():Promise<void> {
    if(this.partial){showBanner(tr("Gem de færdige lyddele, før du vælger en ny optagelse.","Save completed segments before choosing another recording."));return;}
    if(this.busy)return;this.busy=true;this.refresh();
    try { const id=await invoke<string|null>("pick_audio");if(!id)return;await this.close();await this.prepare(id); }
    catch(e){showBanner(errorText(e));}
    finally{this.busy=false;this.refresh();}
  }
  async seek(name:string,seconds:number):Promise<void> {
    if(this.busy)return;
    const path=this.path(), source=audioSource(this.view.state.doc.toString());
    if(!path || source?.audio!==name || seconds>source.duration)return;
    if(this.partial && (this.openedPath!==path || this.info?.name!==name)){showBanner(tr("Gem de færdige lyddele, før du åbner en anden optagelse.","Save completed segments before opening another recording."));return;}
    this.busy=true;
    try {
      if(this.openedPath!==path || this.info?.name!==name) {
        await this.close();const id=await invoke<string>("transcript_audio",{doc:path,name});
        await this.prepare(id);this.openedPath=path;
      }
      if(!this.info)return;
      this.player.currentTime=seconds;await this.player.play();
    }catch(e){showBanner(errorText(e));}
    finally{this.busy=false;this.refresh();}
  }
  /**
   * Samtykket er klikket: linjen lige over knappen siger, hvor lyden sendes hen og med hvis nøgle
   * (audio_support i audio.rs). Derfor ingen ekstra boks som `claude.allowed()` (kodegennemgang 20/10).
   */
  private async transcribe():Promise<void> {
    if(!this.id || this.busy)return;
    const id = this.id;
    this.busy=true;this.savedPath=null;this.startClock("transcribe");this.status=tr("Transskriberer …","Transcribing …");this.refresh();
    const progress=new Channel<Progress>();
    progress.onmessage=p=> {
      if (this.id !== id || this.phase !== "transcribe") return;
      this.progress=p;this.partial=p.done>0;
      this.status=p.waitSeconds>0
        ? tr(`Venter på Gemini. Pausen varer op til ${p.waitSeconds} sekunder før næste forsøg. ${p.done} af ${p.total} lyddele er klar.`, `Waiting for Gemini. Pausing for up to ${p.waitSeconds} seconds before retrying. ${p.done} of ${p.total} segments are ready.`)
        : tr(`${p.done} af ${p.total} lyddele klar · ${Math.floor(p.done/p.total*100)} procent`, `${p.done} of ${p.total} segments ready · ${Math.floor(p.done/p.total*100)} percent`);
      this.refresh();
    };
    try {const text=await invoke<string>("audio_transcribe",{id:this.id,language:this.language,progress});this.partial=true;this.complete=audioSource(text)?.complete===true;this.status=this.complete ? tr("Teksten er klar til at gemme og gennemgå.","The text is ready to save and review.") : tr("Transskriptionen er stoppet. Gem de færdige dele, eller fortsæt.","Transcription stopped. Save the completed segments or continue.");}
    catch(e){this.status=errorText(e);}
    finally{this.stopClock();this.busy=false;this.refresh();}
  }
  private async save(elsewhere=false):Promise<void> {
    if(!this.id || this.busy)return;
    this.busy=true;this.startClock("save");this.refresh();
    try{
      const path=(!elsewhere && this.savedPath) || await invoke<string|null>("save_transcript",{id:this.id,elsewhere});
      if (!path) return;
      this.savedPath=path;
      await this.open(path);
      if (this.path()?.toLowerCase() !== path.toLowerCase()) {
        this.saveFailed=true;
        this.status=tr("Teksten er gemt, men kunne ikke åbnes her. Prøv igen med Gem og ret teksten.", "Text saved, but could not be opened here. Try Save and edit text again.");
        return;
      }
      this.openedPath=path;this.partial=false;this.saveFailed=false;
      this.status=elsewhere
        ? tr("Teksten er gemt. Læg lydfilen i samme mappe for at bruge tidskoderne.", "Text saved. Put the audio file in the same folder to use the timestamps.")
        : tr("Teksten er gemt og åben til rettelser.", "Text saved and open for editing.");
    }
    catch(e){this.saveFailed=true;showBanner(errorText(e));}
    finally{this.stopClock();this.busy=false;this.refresh();}
  }
  async close():Promise<void> {
    if(this.partial){showBanner(tr("Gem de færdige lyddele, før du lukker optagelsen.","Save completed segments before closing the recording."));return;}
    this.player.pause();this.player.removeAttribute("src");this.player.load();
    const id=this.id;this.id=null;this.info=null;this.partial=false;this.complete=false;this.openedPath=null;this.status="";this.progress=null;this.saveFailed=false;this.savedPath=null;
    if(id)await invoke("close_audio",{id});this.refresh();
  }
  docOpened():void {this.player.pause();}
  canLeave():boolean {
    if(!this.busy && !this.partial)return true;
    showBanner(tr("Stop lydjobbet og gem de færdige dele, før du afslutter.","Stop the audio job and save completed segments before quitting."));
    return false;
  }
}
