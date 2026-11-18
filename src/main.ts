import type { EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, editorInfoField } from 'obsidian';
import { runCodex, type BackendOptions, type Result } from './backend';
import { CONTEXTS, applyEdit, appendTurn, answerName, compactSourceEdit, contextNote, contextPrompt, effectiveContext, fallbackTitle, folderPath, initialAnswer, localDate, metadata, newId, originSection, readBacklink, readCapture, replaceOwned, safeTitle, turn, type ContextKind, type Conversation, type Edit, type EffectiveContext, type Mode, type ReadOrigin } from './core';
import { ComposerUI, type ComposerModel } from './composer';
import { SelectionPopup, popupAllowed, sameSelection, emptyDraft, type PopupSelection } from './selection-ui';

interface Settings extends BackendOptions { folder: string; selectionPopup: boolean; linkBack: boolean }
const POPUP_SETTLE_MS=400;
const DEFAULTS: Settings = {selectionPopup:true,linkBack:false,cliPath:'',model:'',timeoutSeconds:180,folder:'AI Answers'};
interface Draft {
  request: string; conversation: string; question: string; mode: Mode;
  contextKind: ContextKind; readOrigin?: ReadOrigin; effective?: EffectiveContext; writeback?: boolean;
  titleDate?: string; title?: string; answerMarkdown?: string; rawResult?: string;
  followupPath?: string; expected?: Conversation; lost?: boolean;
  result?: Result; createdPath?: string; blockId?: string; originSection?: string; confirmDiscard?: boolean;
}
interface Stored { settings: Settings; draft?: Draft }
export default class AskAboutSelection extends Plugin {
  settings = {...DEFAULTS};
  draft?: Draft;
  busy = false;
  private unloaded=false;
  popup?:SelectionPopup;
  private popupInitialized=false;
  private popupGeneration=0;
  private popupAction?:object;
  private popupOwner?:EditorView;
  private popupPointer?:{view:EditorView;doc:EditorView['state']['doc'];file:TFile};
  private popupResume?:()=>void;
  private popupUpAt=0;
  modal?: AskModal;
  controller?: AbortController;
  status = '';
  private statusEl!: HTMLElement;
  private saving: Promise<void> = Promise.resolve();

  async onload() {
    const plugin=this;
    this.registerEditorExtension([
      EditorView.updateListener.of(update=>this.popupEditorUpdate(update)),
      ViewPlugin.define(view=>{const down=(event:PointerEvent)=>plugin.popupDown(event,view),up=(event:PointerEvent)=>plugin.popupUp(event,view);view.dom.addEventListener('pointerdown',down,true);view.dom.addEventListener('pointerup',up,true);return{destroy(){view.dom.removeEventListener('pointerdown',down,true);view.dom.removeEventListener('pointerup',up,true);if(plugin.popupOwner===view)plugin.clearPopup();}};})
    ]);
    this.register(()=>{this.clearPopup();this.popup?.dispose();});
    const saved = await this.loadData() as Stored | null;
    this.settings = {...DEFAULTS,...saved?.settings};
    this.draft = saved?.draft && saved.draft.contextKind!==undefined ? saved.draft : undefined;
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('ask-selection-status');
    this.registerDomEvent(this.statusEl,'click',() => this.showDraft());
    this.addCommand({id:'ask-selection',name:'Ask about selection',editorCallback:(editor,view) => { if(view instanceof MarkdownView) void this.captureDraft(editor,view);else new Notice('Please open the note in a normal Markdown view.'); }});
    this.addCommand({id:'free-question',name:'Ask a free question',callback:()=>{void this.freeQuestion();}});
    if(this.app.workspace.on)this.registerEvent(this.app.workspace.on('active-leaf-change',()=>{if(!this.popupOwnerCurrent())this.clearPopup();}));
    this.addCommand({id:'follow-up',name:'Ask a follow-up question',callback:() => { void this.followup().catch(e => new Notice(message(e),9000)); }});
    this.addCommand({id:'resume-draft',name:'Open request / draft',callback:() => this.showDraft()});
    this.addCommand({id:'cancel',name:'Cancel the running request',callback:() => this.controller?.abort()});
    this.addSettingTab(new SettingsTab(this.app,this));
    this.registerEvent(this.app.vault.on('rename',(file,oldPath) => {
      const d=this.draft;if (!d) return;
      const moved=(p:string)=>p===oldPath||p.startsWith(oldPath+'/')?file.path+p.slice(oldPath.length):p;
      if(d.readOrigin){d.readOrigin.sourcePath=moved(d.readOrigin.sourcePath);if(d.readOrigin.own)d.readOrigin.own.sourcePath=moved(d.readOrigin.own.sourcePath);}
      if(d.followupPath)d.followupPath=moved(d.followupPath);
      if(d.createdPath)d.createdPath=moved(d.createdPath);
      void this.persist().catch(e => this.setStatus(message(e)));
    }));
    this.registerEvent(this.app.vault.on('delete',file => {
      if (this.draft?.followupPath===file.path) {
        this.draft.lost = true;
        void this.persist().catch(e => this.setStatus(message(e)));
      }
    }));
    this.popupInitialized=true;
    if(this.draft&&emptyDraft(this.draft)){this.draft=undefined;void this.persist().catch(e=>this.setStatus(message(e)));}
    this.setStatus(this.draft ? 'draft waiting – click to open' : '');
  }
  onunload() { this.popupInitialized=false;this.clearPopup();this.unloaded=true;this.controller?.abort();this.popup?.dispose();this.modal?.close(); }
  persist(): Promise<void> {
    // Snapshot at enqueue time; ordered writes cannot replace a newer draft with an older one.
    const value = JSON.parse(JSON.stringify({settings:this.settings,draft:this.draft}));
    this.saving = this.saving.catch(() => {}).then(() => this.saveData(value));
    return this.saving;
  }
  setStatus(s: string) { this.status = s; this.statusEl?.setText(s ? `Ask: ${s}` : ''); this.modal?.refresh(); }
  showDraft() {
    this.clearPopup();
    if (!this.draft) { new Notice('No open draft. Select some text and run “Ask about selection”.'); return; }
    if (this.modal) return;
    this.modal = new AskModal(this.app,this); this.modal.open();
  }
  private getFile(path?: string): TFile | undefined {
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    return file instanceof TFile ? file : undefined;
  }
  private views(file:TFile):MarkdownView[] {
    return (this.app.workspace?.getLeavesOfType('markdown')??[]).map(l=>l.view).filter((v):v is MarkdownView=>v instanceof MarkdownView && v.file===file);
  }
  private editors(file:TFile):Editor[] {return this.views(file).filter(v=>v.getMode()==='source').map(v=>v.editor);}
  /** The note as the user sees it: the open editor if there is one (it may hold unsaved typing), else the file. */
  private async current(file: TFile): Promise<string> {
    return this.editors(file)[0]?.getValue() ?? await this.app.vault.read(file);
  }
  /** Insert text into a note. An open editor is changed through the editor (keeps unsaved typing and undo); otherwise the file is changed in one step. */
  private async edit(file: TFile, change: (current: string) => Edit): Promise<void> {
    const editor=this.editors(file)[0];
    if(editor){const e=change(editor.getValue());if(e.text)editor.replaceRange(e.text,editor.offsetToPos(e.offset));return;}
    await this.app.vault.process(file,current=>applyEdit(current,change(current)));
  }

  // ---------------------------------------------------------------- the small "Ask" button after a mouse selection
  private popupOwnerCurrent():boolean{
    const cm=this.popupOwner,view=this.app.workspace.getActiveViewOfType(MarkdownView);
    if(!cm||!view?.file||view.getMode()!=='source'||!view.containerEl?.contains(cm.dom)||cm.dom.isConnected===false)return false;
    const info=cm.state.field(editorInfoField,false);return info?.file===view.file&&(!info.editor||info.editor===view.editor);
  }
  clearPopup(){this.popupGeneration++;this.popupAction=undefined;this.popup?.hide();this.popupPointer=undefined;this.popupOwner=undefined;this.popupResume=undefined;}
  private popupEditorUpdate(update:{view:EditorView;docChanged:boolean;selectionSet:boolean;transactions:readonly {selection?:unknown;isUserEvent(event:string):boolean}[];startState?:EditorState;state?:EditorState}){
    if(this.popupOwner!==update.view)return;
    if(update.docChanged||(update.selectionSet&&this.popupAction)){this.clearPopup();return;}
    if(!update.selectionSet)return;
    const events=update.transactions.filter(tr=>tr.selection);
    if(events.every(tr=>tr.isUserEvent('select.pointer'))){this.popup?.selectionChanged();return;}
    // CodeMirror reports its re-read of the browser selection as plain 'select', also while the mouse is down.
    // That alone must not remove the button: only an actual, lasting change of the selected text may.
    if(this.popupPointer)return;
    if(update.startState&&update.state&&update.startState.selection.eq(update.state.selection)){this.popup?.selectionChanged();return;}
    if(this.popupResume&&Date.now()-this.popupUpAt<POPUP_SETTLE_MS&&events.every(tr=>tr.isUserEvent('select'))){this.popupResume();return;}
    this.clearPopup();
  }
  private popupDown(event:PointerEvent,view:EditorView){
    this.clearPopup();if(event.button!==0||(event.pointerType&&event.pointerType!=='mouse'))return;
    const info=view.state.field(editorInfoField,false);if(!info?.file||!view.dom.contains(event.target as Node))return;
    this.popupOwner=view;this.popupPointer={view,doc:view.state.doc,file:info.file};
  }
  private popupUp(event:PointerEvent,cm:EditorView){
    const pointer=this.popupPointer;this.popupPointer=undefined;
    if(!pointer||pointer.view!==cm||pointer.doc!==cm.state.doc||event.button!==0||!cm.dom.contains(event.target as Node))return;
    const view=this.app.workspace.getActiveViewOfType(MarkdownView);if(!view?.file||view.file!==pointer.file)return;
    const file=view.file,editor=view.editor,path=file.path;
    if(this.popup?.document!==cm.dom.ownerDocument){this.popup?.dispose();this.popup=new SelectionPopup(cm.dom.ownerDocument,undefined,reason=>{
      // Notifications can lag the native mouse selection; actual accepted actions still cancel.
      if(reason==='selection'&&!this.popupAction&&(!!this.popupPointer||this.popup?.hasCurrentSelection()))return false;
      this.clearPopup();
    });}
    this.popupOwner=cm;const generation=this.popupGeneration;
    let measuredRect:PopupSelection['rect']|undefined;
    const read=(measure=true)=>{
      if(generation!==this.popupGeneration||this.popupOwner!==cm||(!measure&&!measuredRect))return;
      const current=this.readPopupSelection(cm,view,file,editor,pointer.doc,path,measure?undefined:measuredRect);
      if(measure&&current)measuredRect=current.rect;return current;
    };
    let accepted=false;const open=(selection:PopupSelection)=>{
      if(accepted||generation!==this.popupGeneration)return;accepted=true;
      const action={};this.popupAction=action;
      // Removing the button on a valid click is intended; a cancelled action stays cancelled.
      void this.captureDraft(editor,view,()=>this.popupAction===action&&sameSelection(selection,read())).finally(()=>{if(this.popupAction===action)this.popupAction=undefined;});
    };
    this.popupUpAt=Date.now();this.popupResume=()=>{measuredRect=undefined;this.popup?.schedule(read,open);};
    this.popup?.schedule(read,open);
  }
  private readPopupSelection(cm:EditorView,view:MarkdownView,file:TFile,editor:Editor,doc:EditorView['state']['doc'],path:string,knownRect?:PopupSelection['rect']):PopupSelection|undefined{
    if(!this.popupInitialized||this.unloaded||!popupAllowed(this.settings.selectionPopup,this.busy,!!this.draft,view.getMode())||this.app.workspace.getActiveViewOfType(MarkdownView)!==view||view.file!==file||file.path!==path||view.editor!==editor||cm.state.doc!==doc||!view.containerEl.contains(cm.dom)||cm.dom.isConnected===false)return;
    const info=cm.state.field(editorInfoField,false);if(info?.file!==file||(info.editor&&info.editor!==editor)||cm.state.selection.ranges.length!==1||editor.listSelections().length!==1)return;
    const range=cm.state.selection.main;if(range.empty)return;const raw=doc.sliceString(range.from,range.to);
    if(editor.getValue()!==doc.toString()||editor.getSelection()!==raw||editor.posToOffset(editor.getCursor('from'))!==range.from||editor.posToOffset(editor.getCursor('to'))!==range.to)return;
    const rect=knownRect??cm.coordsAtPos(range.head,range.head>=range.anchor?1:-1);if(!rect)return;
    return{owner:cm,container:cm.dom,revision:doc,anchor:range.anchor,head:range.head,raw,rect};
  }

  // ---------------------------------------------------------------- drafts
  /** Whether a link to the answer may be added below the selected paragraph. Only if the user switched it on, and only for a normal paragraph. */
  private mayLinkBack(origin?:ReadOrigin):boolean{return this.settings.linkBack&&!!origin?.own;}
  async captureDraft(editor:Editor,view:MarkdownView,verify?:()=>boolean) {
    if(this.busy||this.draft){this.showDraft();return;}
    try{
      if(verify&&!verify())throw new Error('The selection changed in the meantime. Please select the text again.');
      if(view.getMode()!=='source')throw new Error('Please open the note in editing mode (Source mode or Live Preview); reading view is not supported.');
      if(!view.file||editor.listSelections().length!==1||!editor.getSelection().trim())throw new Error('Please select exactly one non-empty piece of text.');
      const origin=readCapture(editor.getValue(),editor.posToOffset(editor.getCursor('from')),editor.posToOffset(editor.getCursor('to')),view.file.path);
      this.draft={request:newId(),conversation:newId(),question:'',mode:'explain',contextKind:'selection',readOrigin:origin,writeback:this.mayLinkBack(origin),titleDate:localDate()};this.showDraft();
    }catch(e){new Notice(message(e),9000);}
  }
  async freeQuestion(){
    if(this.busy||this.draft){this.showDraft();return;}
    this.draft={request:newId(),conversation:newId(),question:'',mode:'explain',contextKind:'none',writeback:false,titleDate:localDate()};this.showDraft();
  }
  async selectContext(kind:ContextKind,refresh=false){
    const d=this.draft;if(!d||this.busy||d.result)return;
    if(!Object.hasOwn(CONTEXTS,kind))throw new Error('Unknown context mode.');
    if(kind==='none'){d.contextKind=kind;d.readOrigin=undefined;d.effective=undefined;d.writeback=false;await this.persist();this.modal?.refresh();return;}
    if(!d.readOrigin||refresh){
      const view=this.app.workspace.getActiveViewOfType(MarkdownView);if(!view?.file||view.getMode()!=='source')throw new Error('This context needs a Markdown note that is open in editing mode.');
      d.readOrigin=readCapture(view.editor.getValue(),view.editor.posToOffset(view.editor.getCursor('from')),view.editor.posToOffset(view.editor.getCursor('to')),view.file.path);
    }
    effectiveContext(kind,d.readOrigin); // refuses an empty or too large context before it is chosen
    d.writeback=!d.expected&&this.mayLinkBack(d.readOrigin);d.contextKind=kind;d.effective=undefined;await this.persist();this.modal?.refresh();
  }
  composerModel():ComposerModel{
    const d=this.draft!;let excerpt='',description='Only your question is shared; no note and no link back.';
    try{const context=effectiveContext(d.contextKind,d.readOrigin);excerpt=context.content??'';if(context.kind!=='none')description=CONTEXTS[context.kind]+': '+excerpt.length+' characters from '+context.sourcePath+(d.writeback?' · a small link to the answer will be added below this paragraph.':' · read only, this note is not changed.');}catch(e){description=message(e);}
    const available:ContextKind[]=['none'];if(d.readOrigin||this.app.workspace.getActiveViewOfType?.(MarkdownView)?.getMode()==='source')available.push('section','note');if(d.readOrigin?.selection.trim())available.push('selection');
    return{question:d.question,mode:d.mode,context:d.contextKind,excerpt,description,available,followup:!!d.expected,busy:this.busy,result:!!d.result,status:this.status};
  }
  private async resolvedContext(d:Draft):Promise<EffectiveContext>{
    if(d.contextKind==='none'){d.readOrigin=undefined;d.writeback=false;return{kind:'none'};}
    const origin=d.readOrigin;if(!origin)throw new Error('The context is missing; please capture it again.');
    const file=this.getFile(origin.sourcePath);if(!file||await this.current(file)!==origin.snapshot)throw new Error('The note has changed since the context was captured. Please click “Capture context again”.');
    return effectiveContext(d.contextKind,origin);
  }
  async followup() {
    if (this.busy || this.draft) return this.showDraft();
    const file = this.app.workspace.getActiveFile();
    if (!file) throw new Error('Please open an answer note first.');
    const expected = metadata(await this.current(file));
    if (!expected) throw new Error('This note is not a conversation created by this plugin.');
    if(this.busy || this.draft){this.showDraft();return;}
    if(this.app.workspace.getActiveFile()!==file || this.app.vault.getAbstractFileByPath(file.path)!==file)throw new Error('Another note became active in the meantime. Please start again.');
    this.draft = {request:newId(),conversation:expected.conversation,question:'',mode:'explain',contextKind:'none',writeback:false,followupPath:file.path,expected};
    this.showDraft();
  }
  composerClosed(){
    this.modal=undefined;
    const d=this.draft;if(this.unloaded||this.busy||!d)return;
    if(emptyDraft(d)){void this.discard().catch(e=>new Notice(message(e)));return;}
    if(!d.result){this.setStatus('draft saved – click to open');new Notice('Your question is saved as a draft. To continue, click “Ask: draft saved” in the status bar. While a draft is open, the Ask button does not appear.',8000);}
  }
  async discard() {
    const d=this.draft;if (this.busy || !d) return;
    if(d.result&&!d.confirmDiscard){d.confirmDiscard=true;this.setStatus('This answer has not been saved yet. Click “Discard answer” once more to delete it.');return;}
    this.draft = undefined;
    await this.persist(); this.modal?.close(); this.setStatus('');
  }

  // ---------------------------------------------------------------- asking and saving
  async submit() {
    const d = this.draft;
    if (!d || this.busy) return;
    this.clearPopup();this.busy = true; this.controller = new AbortController(); d.confirmDiscard=undefined; this.modal?.refresh();
    try {
      folderPath(this.settings.folder);
      if (!Number.isFinite(this.settings.timeoutSeconds) || this.settings.timeoutSeconds < 10 || this.settings.timeoutSeconds > 1800) throw new Error('The time limit must be between 10 and 1800 seconds.');
      if (!d.result) {
        d.effective=await this.resolvedContext(d);
        const input=contextPrompt(d.question,d.mode,d.effective,!d.expected);
        await this.persist(); // The draft is safely stored before the AI is asked.
        d.result = await runCodex({...this.settings},input,this.controller.signal,s => this.setStatus(s),d.expected?.session);
        if(!d.expected){d.rawResult=d.result.answer;const parsed=initialAnswer(d.rawResult);d.answerMarkdown=parsed.answer;d.title=safeTitle(parsed.title??fallbackTitle(d.question,d.effective));}
        await this.persist(); // Keep the finished answer before any note is touched.
      }
      this.setStatus('Saving the answer …');
      const file=await this.commit(d);
      this.draft = undefined;
      try { await this.persist(); } catch(e) { this.draft = d; throw e; }
      this.modal?.close(); this.setStatus('answer saved');
      try { await this.app.workspace.getLeaf('split','vertical').openFile(file); }
      catch { new Notice(`The answer was saved as ${file.path}, but it could not be opened next to your note.`,10000); }
    } catch(e) { this.setStatus(message(e)); this.showDraft(); new Notice(message(e),10000); }
    finally { this.busy = false; this.controller = undefined; this.modal?.refresh(); }
  }
  private async ensureFolder(folder:string):Promise<void>{
    let path='';
    for(const part of folder.split('/')){
      path=path?path+'/'+part:part;const existing=this.app.vault.getAbstractFileByPath(path);
      if(existing instanceof TFolder)continue;
      if(existing)throw new Error(`“${path}” is a file, not a folder. Please choose another answer folder in the settings.`);
      try{await this.app.vault.createFolder(path);}catch(e){if(!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder))throw e;}
    }
  }
  private names(folder:string):string[]{const f=this.app.vault.getAbstractFileByPath(folder);return f instanceof TFolder?f.children.map(c=>c.name):[];}
  private commit(d:Draft):Promise<TFile>{
    const body=turn(d.question,d.mode,d.answerMarkdown??d.result!.answer,d.request,!!d.expected);
    return d.expected?this.commitFollowup(d,body):this.commitNew(d,body);
  }
  private async commitFollowup(d:Draft,body:string):Promise<TFile>{
    const target=d.lost?undefined:this.getFile(d.followupPath);
    if(target){await this.edit(target,current=>appendTurn(current,d.expected!,body,d.request));return target;}
    new Notice('The conversation note could not be found any more; the follow-up was saved in a new note.',10000);
    d.title??=safeTitle(fallbackTitle(d.question,{kind:'none'}));d.effective={kind:'none'};d.readOrigin=undefined;d.writeback=false;
    return this.commitNew(d,body);
  }
  private async commitNew(d:Draft,body:string):Promise<TFile>{
    const result=d.result!,context=d.effective??{kind:'none' as const},conv={conversation:d.conversation,session:result.session};
    const folder=folderPath(this.settings.folder),title=d.title??safeTitle(fallbackTitle(d.question,context)),date=d.titleDate??=localDate();
    const source=d.readOrigin&&context.kind!=='none'?this.getFile(d.readOrigin.sourcePath):undefined;
    // An earlier try may already have created the note; it is recognised by its conversation ID and not created twice.
    let answer=this.getFile(d.createdPath);
    if(answer&&metadata(await this.app.vault.read(answer))?.conversation!==d.conversation)answer=undefined;
    if(!answer){
      await this.ensureFolder(folder);
      const taken=this.names(folder);
      for(let attempt=0;attempt<50&&!answer;attempt++){
        const name=answerName(title,date,taken),path=folder+'/'+name;
        let origin:string|undefined;
        if(source&&d.readOrigin){try{const unchanged=await this.current(source)===d.readOrigin.snapshot,ref=unchanged?readBacklink(d.readOrigin):{subpath:'',granularity:'file' as const};origin=this.app.fileManager.generateMarkdownLink(source,path,ref.subpath,ref.granularity==='block'?'To the selected block':ref.granularity==='heading'?'To the section (excerpt below)':'To the note (excerpt below)');}catch{/* No safe link: the note then says so and keeps the excerpt. */}}
        const content=contextNote(conv,`${title} – ${date}`,context,d.readOrigin?.selection??'',origin,body);
        try{answer=await this.app.vault.create(path,content);d.createdPath=path;d.originSection=origin?originSection(conv,origin):undefined;await this.persist();}
        catch(e){if(this.getFile(path)||/already exists/i.test(message(e))){taken.push(name);continue;}throw e;}
      }
      if(!answer)throw new Error('No free name for the answer note was found.');
    }
    if(d.writeback&&d.readOrigin?.own&&source){
      try{await this.linkBack(d,source,answer,conv);}
      catch(e){new Notice('The answer was saved, but the link below your paragraph could not be added: '+message(e),12000);}
    }
    return answer;
  }
  /** Adds "💬1" (a link to the answer) below the paragraph the question was about, and points the answer note back at that paragraph. */
  private async linkBack(d:Draft,source:TFile,answer:TFile,conv:Conversation):Promise<void>{
    const own=d.readOrigin!.own!;
    d.blockId??=own.paragraph.id??`ask-${newId()}`;await this.persist();
    await this.edit(source,current=>compactSourceEdit(current,own,d.blockId!,d.request,n=>this.app.fileManager.generateMarkdownLink(answer,source.path,'',`💬${n}`)));
    if(!d.originSection)return;
    try{
      const next=originSection(conv,this.app.fileManager.generateMarkdownLink(source,answer.path,`#^${d.blockId}`,'To the original paragraph'));
      await this.app.vault.process(answer,current=>replaceOwned(current,d.originSection!,next));d.originSection=next;
    }catch{/* The answer note keeps its first, coarser link to the source. */}
  }
}
function message(e: unknown): string { return e instanceof Error ? e.message : String(e); }

class AskModal extends Modal {
 private ui?:ComposerUI;
 constructor(app:App,private plugin:AskAboutSelection){super(app);}
 onOpen(){
  this.titleEl.setText(this.plugin.draft?.expected?'Ask a follow-up question':'Ask a question');
  this.ui=new ComposerUI(this.contentEl,this.plugin.composerModel(),{
   question:value=>{this.plugin.draft!.question=value;this.changed();},mode:value=>{this.plugin.draft!.mode=value;this.changed();},
   context:value=>{void this.plugin.selectContext(value).catch(e=>this.plugin.setStatus(message(e)));},
   refresh:()=>{const d=this.plugin.draft;if(d)void this.plugin.selectContext(d.contextKind,true).catch(e=>this.plugin.setStatus(message(e)));},
   submit:()=>{void this.plugin.submit();},cancel:()=>this.plugin.controller?.abort(),discard:()=>{void this.plugin.discard().catch(e=>new Notice(message(e)));}});
 }
 private changed(){void this.plugin.persist().catch(e=>this.plugin.setStatus(message(e)));this.refresh();}
 refresh(){if(this.plugin.draft)this.ui?.refresh(this.plugin.composerModel());}
 onClose(){this.contentEl.empty();this.plugin.composerClosed();}
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App,private plugin: AskAboutSelection) { super(app,plugin); }
  display() {
    const {containerEl} = this; containerEl.empty();
    new Setting(containerEl).setName('Ask button after selecting').setDesc('Shows a small “Ask” button after you select text with the mouse. Nothing is sent until you click it and send a question.').addToggle(t=>t.setValue(this.plugin.settings.selectionPopup).onChange(v=>{this.plugin.settings.selectionPopup=v;if(!v)this.plugin.clearPopup();void this.plugin.persist();}));
    new Setting(containerEl).setName('Answer folder').setDesc('Folder inside the vault where answer notes are created. It is created if it does not exist.').addText(t => t.setValue(this.plugin.settings.folder).onChange(v => { try { this.plugin.settings.folder = folderPath(v); void this.plugin.persist(); } catch {} }));
    new Setting(containerEl).setName('Add a link below the paragraph').setDesc('Off: your notes are never changed; the answer note links back to your note. On: after a question about a normal paragraph, a block ID and a small link (💬1) to the answer are added below that paragraph.').addToggle(t=>t.setValue(this.plugin.settings.linkBack).onChange(v=>{this.plugin.settings.linkBack=v;void this.plugin.persist();}));
    new Setting(containerEl).setName('Codex CLI').setDesc('Empty: search for it automatically. Otherwise the complete path to the program, without quotes or extra arguments.').addText(t => t.setValue(this.plugin.settings.cliPath).onChange(v => { this.plugin.settings.cliPath=v; void this.plugin.persist(); }));
    new Setting(containerEl).setName('Model').setDesc('Empty: the default of the CLI. Your personal Codex configuration file is not loaded for these requests; your sign-in is used as it is.').addText(t => t.setValue(this.plugin.settings.model).onChange(v => { this.plugin.settings.model=v; void this.plugin.persist(); }));
    new Setting(containerEl).setName('Time limit in seconds').setDesc('10 to 1800, default 180.').addText(t => t.setValue(String(this.plugin.settings.timeoutSeconds)).onChange(v => { const n=Number(v); if (Number.isFinite(n) && n>=10 && n<=1800) { this.plugin.settings.timeoutSeconds=n; void this.plugin.persist(); } }));
    containerEl.createEl('p',{text:'Shortcuts: Obsidian → Settings → Hotkeys → search for “Ask about selection”. The session IDs are stored in the answer note; the sessions themselves stay in the local Codex folder of your user account.'});
  }
}
