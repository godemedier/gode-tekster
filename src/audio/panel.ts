import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { audioSource } from "./document.ts";
import { errorText, showBanner } from "../ui/banner.ts";
import { tr } from "../i18n.ts";

type Info = { id: string; name: string; duration: number; playbackPath: string };
type Support = { ready: boolean; provider: string | null; detail: string };
const button = (label: string, run: () => void) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.onclick = run; return b; };
const note = (text: string) => { const p = document.createElement("p"); p.textContent = text; return p; };
export class AudioPanel {
  private view: EditorView;
  private path: () => string | null;
  private open: (path: string) => Promise<void>;
  private body: HTMLElement | null = null;
  private id: string | null = null;
  private info: Info | null = null;
  private support: Support | null = null;
  private player = document.createElement("audio");
  private controls = document.createElement("div");
  private busy = false;
  private status = "";
  private partial = false;
  private complete = false;
  private language = "da";
  private openedPath: string | null = null;
  private recoveries: string[] = [];
  constructor(view: EditorView, path: () => string | null, open: (path: string) => Promise<void>) {
    this.view = view; this.path = path; this.open = open;
    this.player.controls = true; this.player.preload = "metadata";
    this.player.onerror = () => showBanner(tr("Lyden kunne ikke afspilles. Prøv at åbne optagelsen igen.", "Audio could not be played. Try reopening the recording."));
    window.addEventListener("gt-ai-changed", () => { void this.refreshSupport(); });
    void invoke<string[]>("audio_recoveries").then(ids => {this.recoveries=ids;this.refresh();}).catch(e=>showBanner(errorText(e)));
  }
  render(host: HTMLElement): void {
    this.body = host;
    if(this.player.parentElement !== host)host.replaceChildren(this.player,this.controls);
    this.player.hidden=!this.info;
    const body=this.controls;
    const pick = button(tr("Vælg lydfil …", "Choose audio …"), () => void this.pick()); pick.disabled = this.busy;
    const controls = document.createElement("div"); controls.className = "structure-tools"; controls.append(pick);
    const current = audioSource(this.view.state.doc.toString());
    if (current && !this.info && !this.busy) controls.append(button(tr("Åbn optagelsen", "Open recording"), () => void this.seek(current.audio, 0)));
    body.replaceChildren(controls);
    if(this.recoveries.length) {
      const details=document.createElement("details"),summary=document.createElement("summary");
      summary.textContent=tr(`Ugemte transskriptioner (${this.recoveries.length})`,`Unsaved transcripts (${this.recoveries.length})`);details.append(summary);
      for(const id of this.recoveries)details.append(button(tr("Gendan fra ","Recover from ")+new Date(Number(id.split('-')[1])).toLocaleString(),()=>void invoke<string>("audio_recover",{id}).then(path=>this.open(path)).catch(e=>showBanner(errorText(e)))));
      body.append(details);
    }
    if (this.info) {
      const speed = document.createElement("select"); speed.setAttribute("aria-label",tr("Afspilningshastighed","Playback speed"));
      for (const rate of [0.75,1,1.25,1.5,2]) speed.add(new Option(`${rate}×`,String(rate)));
      speed.value=String(this.player.playbackRate); speed.onchange=()=>{this.player.playbackRate=Number(speed.value);};
      body.append(note(this.info.name),speed);
      const language=document.createElement("select"); language.setAttribute("aria-label",tr("Sprog i optagelsen","Recording language"));
      for (const [id,label] of [["da",tr("Dansk","Danish")],["en",tr("Engelsk","English")],["auto",tr("Find sproget","Detect language")]]) language.add(new Option(label,id));
      language.value=this.language; language.disabled=this.busy || this.partial; language.onchange=()=>{this.language=language.value;};
      body.append(language);
      if (this.support) body.append(note(this.support.detail));
      const start=button(this.partial ? tr("Fortsæt transskription","Continue transcription") : tr("Transskriber","Transcribe"),()=>void this.transcribe()); start.disabled=this.busy || this.complete || !this.support?.ready;
      body.append(start);
      if (this.partial) { const save=button(tr("Gem og ret teksten","Save and edit text"),()=>void this.save());save.disabled=this.busy;body.append(save); }
    }
    if (this.busy) body.append(button(tr("Stop","Stop"),()=> { if(this.id) void invoke("audio_cancel",{id:this.id}).catch(e=>showBanner(errorText(e))); this.status=tr("Stopper efter det aktuelle svar …","Stopping after the current response …");this.refresh(); }));
    if (this.status) { const p=note(this.status);p.setAttribute("role","status");body.append(p); }
    if (!this.info && !this.busy) body.append(button(tr("Vælg FFmpeg …","Select FFmpeg …"),()=>void invoke("pick_audio_tools").catch(e=>showBanner(errorText(e)))));
    if (this.id && !this.busy) body.append(button(tr("Luk optagelsen","Close recording"),()=>void this.close()));
    if (this.partial && !this.busy) body.append(button(tr("Kassér transskription …","Discard transcript …"),()=>{
      const id=this.id;
      showBanner(tr("Kassér den ugemte transskription? Optagelsen bliver liggende.","Discard the unsaved transcript? The recording is kept."),[{label:tr("Kassér","Discard"),run:async()=>{
        if(this.id!==id || !this.partial || this.busy)return;
        this.busy=true;
        try {await invoke("audio_discard",{id});this.partial=false;await this.close();}
        finally {this.busy=false;this.refresh();}
      }}],{closable:true});
    }));
  }
  private refresh():void { if(this.body?.dataset.tab==="lyd")this.render(this.body); }
  private async refreshSupport():Promise<void> {
    if(!this.id)return;
    try{this.support=await invoke<Support>("audio_support");this.refresh();}catch(e){showBanner(errorText(e));}
  }
  private async prepare(id:string):Promise<void> {
    this.id=id;this.busy=true;this.status=tr("Gør optagelsen klar …","Preparing recording …");this.refresh();
    try {
      this.info=await invoke<Info>("audio_prepare",{id});
      this.player.src=convertFileSrc(this.info.playbackPath);
      this.support=await invoke<Support>("audio_support");this.status="";
    } catch(e) {this.status=errorText(e);}
    finally {this.busy=false;this.refresh();}
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
  private async transcribe():Promise<void> {
    if(!this.id || this.busy)return;
    this.busy=true;this.status=tr("Transskriberer …","Transcribing …");this.refresh();
    const progress=new Channel<{done:number;total:number}>();
    progress.onmessage=p=> {this.partial=true;this.status=tr(`${p.done} af ${p.total} lyddele klar`,`${p.done} of ${p.total} audio segments ready`);this.refresh();};
    try {const text=await invoke<string>("audio_transcribe",{id:this.id,language:this.language,progress});this.partial=true;this.complete=audioSource(text)?.complete===true;this.status=this.complete ? tr("Teksten er klar til at gemme og gennemgå.","The text is ready to save and review.") : tr("Transskriptionen er stoppet. Gem de færdige dele, eller fortsæt.","Transcription stopped. Save the completed segments or continue.");}
    catch(e){this.status=errorText(e);}
    finally{this.busy=false;this.refresh();}
  }
  private async save():Promise<void> {
    if(!this.id || this.busy)return;
    this.busy=true;this.refresh();
    try{const path=await invoke<string>("save_transcript",{id:this.id});await this.open(path);this.openedPath=path;this.partial=false;}
    catch(e){showBanner(errorText(e));}
    finally{this.busy=false;this.refresh();}
  }
  async close():Promise<void> {
    if(this.partial){showBanner(tr("Gem de færdige lyddele, før du lukker optagelsen.","Save completed segments before closing the recording."));return;}
    this.player.pause();this.player.removeAttribute("src");this.player.load();
    const id=this.id;this.id=null;this.info=null;this.support=null;this.partial=false;this.complete=false;this.openedPath=null;this.status="";
    if(id)await invoke("close_audio",{id});this.refresh();
  }
  docOpened():void {this.player.pause();}
  canLeave():boolean {
    if(!this.busy && !this.partial)return true;
    showBanner(tr("Stop lydjobbet og gem de færdige dele, før du afslutter.","Stop the audio job and save completed segments before quitting."));
    return false;
  }
}
