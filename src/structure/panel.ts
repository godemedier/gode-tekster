import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { invoke } from "@tauri-apps/api/core";
import { addStructurePart, editStructurePart, removeStructurePart, setStructureModel, structureParts, structurePlan, structureContext } from "../editor/structure.ts";
import { bodyHeadings } from "../editor/outline.ts";
import { withoutParked } from "../editor/parked.ts";
import { MODEL_GROUPS, NARRATIVE_MODELS, narrativeModel } from "./models.ts";
import { applyStructure, groupSelection, movePart } from "./edit.ts";
import { errorText, showBanner } from "../ui/banner.ts";
import { tr } from "../i18n.ts";

const button = (text: string, run: () => void) => {
  const el = document.createElement("button"); el.type = "button"; el.textContent = text; el.onclick = run; return el;
};
const paragraph = (text: string) => { const el = document.createElement("p"); el.textContent = text; return el; };
type Suggestion = { model: string; reason: string; parts: { id: string; role: string; note: string }[] };

export class StructurePanel {
  private view: EditorView;
  private wide = false;
  private busy = false;
  private documentGeneration = 0;
  private proposal: { doc: string; value: Suggestion; candidates: {id:string;title:string;from:number;to:number}[] } | null = null;
  private body: HTMLElement | null = null;
  private allowed: () => Promise<boolean>;
  constructor(view: EditorView, allowed: () => Promise<boolean> = async () => true) { this.view = view; this.allowed = allowed; }
  docOpened(): void { this.documentGeneration++; this.proposal=null; }
  group(): void {
    if (!groupSelection(this.view)) showBanner(tr("Markér hele afsnit uden eksisterende dele eller skjulte noter.", "Select paragraphs without existing parts or hidden notes."));
  }
  render(body: HTMLElement): void {
    this.body = body;
    body.classList.add("structure-panel");
    document.body.classList.toggle("rp-wide", this.wide);
    const doc = this.view.state.doc.toString(), parts = structureParts(doc), plan = structurePlan(doc);
    const model = narrativeModel(plan?.model ?? "");
    const select = document.createElement("select");
    select.setAttribute("aria-label", tr("Fortællemetode", "Narrative method"));
    select.add(new Option(tr("Fri opbygning", "Free structure"), ""));
    for (const group of MODEL_GROUPS) {
      const opt = document.createElement("optgroup"); opt.label = group;
      for (const item of NARRATIVE_MODELS.filter(m => m.groups.includes(group))) opt.append(new Option(item.name, item.id));
      select.append(opt);
    }
    select.value = model?.id ?? "";
    select.onchange = () => applyStructure(this.view, setStructureModel(this.view.state.doc.toString(), select.value));
    const tools = document.createElement("div"); tools.className = "structure-tools";
    tools.append(button(tr("Ny del", "New part"), () => {
      const text = this.view.state.doc.toString();
      const changes = addStructurePart(text, text.length, text.length, tr("Ny del", "New part"));
      if (changes) applyStructure(this.view, changes);
    }), button(tr("Gruppér markering", "Group selection"), () => this.group()), button(tr("Fra overskrifter …", "From headings …"), () => this.headings()),
    button(this.wide ? tr("Lille overblik", "Narrow view") : tr("Stort overblik", "Wide view"), () => { this.wide = !this.wide; this.refresh(); }));
    const ai = document.createElement("div"); ai.className = "structure-tools";
    const recommend = button(tr("Anbefal metode", "Recommend method"), () => void this.analyse(""));
    const analyse = button(tr("Foreslå opbygning", "Suggest structure"), () => void this.analyse(model?.id ?? ""));
    recommend.disabled = this.busy; analyse.disabled = this.busy || !model;
    ai.append(recommend, analyse);
    body.replaceChildren(select, ...(model ? [paragraph(model.description)] : []), tools, ai);
    if (this.busy) body.append(paragraph(tr("Ser på opbygningen …", "Reviewing structure …")));
    if (this.proposal) {
      const proposal = this.proposal;
      const preview = document.createElement("section"); preview.className = "structure-proposal";
      preview.append(paragraph(`${narrativeModel(proposal.value.model)?.name}: ${proposal.value.reason}`));
      for (const p of proposal.value.parts) preview.append(paragraph(`${parts.find(x => x.id === p.id)?.title ?? proposal.candidates.find(x=>x.id===p.id)?.title ?? p.id}: ${narrativeModel(proposal.value.model)?.roles.find(r=>r.id===p.role)?.name ?? p.role}. ${p.note}`));
      const accept = button(tr("Brug forslaget", "Use suggestion"), () => {
        if (this.view.state.doc.toString() !== proposal.doc) { showBanner(tr("Teksten er ændret. Bed om et nyt forslag.", "The text has changed. Request a new suggestion.")); return; }
        const changes: import("../editor/structure.ts").StructureChange[] = [];
        const context=structureContext(proposal.doc);
        for (const p of proposal.value.parts) {
          const candidate=proposal.candidates.find(c=>c.id===p.id);
          if(candidate) { const c=addStructurePart(proposal.doc,candidate.from,candidate.to,candidate.title,p.role,p.note,context); if(c)changes.push(...c); }
          else {const c = editStructurePart(proposal.doc, p.id, { role: p.role, note: p.note }, parts); if (c) changes.push(c);}
        }
        changes.push(setStructureModel(proposal.doc, proposal.value.model));
        this.proposal = null; applyStructure(this.view, changes); this.refresh();
      });
      accept.disabled = proposal.doc !== doc;
      preview.append(accept, button(tr("Læg væk", "Dismiss"), () => { this.proposal = null; this.refresh(); })); body.append(preview);
    }
    if (!parts.length) body.append(paragraph(tr("Markér et afsnit og gruppér det, eller begynd med en tom del.", "Group a selected paragraph, or start with an empty part.")));
    const cards = document.createElement("div"); cards.className = "structure-cards";
    for (const part of parts) {
      const card = document.createElement("section"); card.className = "structure-card"; card.dataset.part = part.id;
      const field = (key: "title" | "role" | "note", label: string) => {
        const wrap = document.createElement("label"); wrap.textContent = label;
        const input = key === "note" ? document.createElement("textarea") : document.createElement("input");
        input.value = part[key]; input.maxLength = key === "note" ? 10000 : key === "title" ? 240 : 80;
        input.setAttribute("aria-label", label); input.dataset.field = key;
        input.oninput = () => { const change = editStructurePart(this.view.state.doc.toString(), part.id, { [key]: input.value }); if (change) applyStructure(this.view, change); };
        wrap.append(input); return wrap;
      };
      card.append(field("title", tr("Titel", "Title")));
      if(model) {
        const label=document.createElement("label");label.textContent=tr("Rolle","Role");
        const roles=document.createElement("select");roles.setAttribute("aria-label",tr("Rolle","Role"));
        roles.add(new Option(tr("Ingen rolle","No role"),""));
        for(const r of model.roles)roles.add(new Option(r.name,r.id));
        if(part.role && !model.roles.some(r=>r.id===part.role))roles.add(new Option(part.role,part.role));
        roles.value=part.role;roles.onchange=()=>{const c=editStructurePart(this.view.state.doc.toString(),part.id,{role:roles.value});if(c)applyStructure(this.view,c);};label.append(roles);card.append(label);
      } else card.append(field("role",tr("Rolle","Role")));
      card.append(field("note", tr("Arbejdsnote", "Working note")));
      const role = model?.roles.find(r => r.id === part.role || r.name === part.role);
      if (role) card.append(paragraph(role.question));
      const text = withoutParked(doc.slice(part.contentFrom, part.contentTo)).trim();
      card.append(paragraph(text ? text.slice(0, 160) + (text.length > 160 ? "…" : "") : tr("Planlagt del", "Planned part")));
      const actions = document.createElement("div"); actions.className = "structure-tools";
      actions.append(button(tr("Skriv her", "Write here"), () => {
        const current = structureParts(this.view.state.doc.toString()).find(p => p.id === part.id); if (!current) return;
        if (current.contentFrom === current.contentTo) applyStructure(this.view, { from: current.contentFrom, insert: "\n" });
        this.view.dispatch({ selection: { anchor: current.contentFrom }, scrollIntoView: true }); this.view.focus();
      }));
      for (const [dir, label] of [[-1, tr("Op", "Up")], [1, tr("Ned", "Down")]] as const) {
        const b = button(label, () => { if (!movePart(this.view, part.id, dir)) showBanner(tr("Gruppér teksten mellem delene, før du flytter dem.", "Group the text between these parts before moving them.")); });
        b.disabled = parts.indexOf(part) + dir < 0 || parts.indexOf(part) + dir >= parts.length; actions.append(b);
      }
      actions.append(button(tr("Opløs del", "Ungroup"), () => applyStructure(this.view, removeStructurePart(this.view.state.doc.toString(), part.id))));
      card.append(actions); cards.append(card);
    }
    body.append(cards);
    if(this.view.state.readOnly) {
      body.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>("button,input,textarea,select").forEach(el=>{el.disabled=true;});
      body.append(paragraph(tr("Gå tilbage til nu for at ændre strukturen.","Return to the current version to change the structure.")));
    }
  }
  private refresh(): void { if (this.body?.dataset.tab === "struktur") this.render(this.body); }
  private headings(): void {
    const doc = this.view.state.doc.toString();
    const hs = bodyHeadings(doc);
    const level = Math.min(...hs.map(h => h.level));
    const selected = hs.filter(h => h.level === level);
    const context = structureContext(doc);
    const end = structurePlan(doc)?.from ?? doc.length;
    const candidates = selected.map((h,i) => ({ h, changes: addStructurePart(doc, h.from, selected[i+1]?.from ?? end, h.text, "", "", context) }));
    if (!candidates.length || candidates.some(c => !c.changes)) { showBanner(tr("Ingen hele, ugrupperede overskriftsafsnit at opdele.", "No complete ungrouped sections to split.")); return; }
    showBanner(tr(`Opret ${candidates.length} dele: ${selected.map(h => h.text).join(" · ")}`, `Create ${candidates.length} parts: ${selected.map(h => h.text).join(" · ")}`), [{ label: tr("Opret dele", "Create parts"), run: () => {
      if (doc !== this.view.state.doc.toString()) { showBanner(tr("Teksten er ændret. Vælg opdeling igen.", "The text has changed. Preview the split again.")); return; }
      applyStructure(this.view, candidates.flatMap(c => c.changes!));
    } }], { closable: true, perText: true });
  }
  private async analyse(model: string): Promise<void> {
    if (this.busy || this.view.state.readOnly) return;
    this.busy = true;
    try {
      if(!await this.allowed())return;
      const generation=this.documentGeneration;
      const doc = this.view.state.doc.toString(); this.proposal = null; this.refresh();
      const parts = structureParts(doc).map(p => ({ id: p.id, title: p.title, text: withoutParked(doc.slice(p.contentFrom,p.contentTo)) }));
      const candidates:{id:string;title:string;from:number;to:number}[]=[];
      if(model && !parts.length) {
        const context=structureContext(doc);
        for(let node=syntaxTree(this.view.state).topNode.firstChild;node;node=node.nextSibling) {
          const from=this.view.state.doc.lineAt(node.from).from,to=Math.min(doc.length,this.view.state.doc.lineAt(node.to).to+1);
          const title=doc.slice(from,to).trim().replace(/^#+\s*/,"").split("\n")[0].slice(0,80);
          if(!addStructurePart(doc,from,to,title,"","",context))continue;
          const id=`candidate-${candidates.length}`;candidates.push({id,title,from,to});parts.push({id,title,text:withoutParked(doc.slice(from,to))});
        }
      }
      const value = await invoke<Suggestion>("structure_suggest", { text: withoutParked(doc), parts, model });
      if(generation===this.documentGeneration)this.proposal = { doc, value, candidates };
    } catch (e) { showBanner(errorText(e)); }
    finally { this.busy = false; this.refresh(); }
  }
}
