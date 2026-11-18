// Runs the built plugin (dist/main.js) against a small stand-in for Obsidian that lives in memory, with a
// stand-in program instead of the Codex CLI. This checks the whole path from a selection to a saved note.
// It is a model of Obsidian, not Obsidian itself: the real app still has to be tried by hand.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const c=require('../.test-build/core.cjs');
const SESSION='12345678-1234-4321-8321-123456789abc',TITLE='Why compact sets are closed';
const built=fs.readFileSync(path.join(__dirname,'../dist/main.js'),'utf8');

const notices=[];
class TFile{constructor(p){this.path=p;this.name=p.split('/').at(-1);}}
class TFolder{constructor(p){this.path=p;this.name=p.split('/').at(-1);this.children=[];}}
class MarkdownView{getMode(){return this.mode??'source';}}
class Plugin{constructor(){this.app={};}register(){}registerEditorExtension(x){this.extension=x;}addStatusBarItem(){return{addClass(){},setText:t=>{this.statusText=t;}};}registerDomEvent(){}addCommand(cmd){(this.commands??=[]).push(cmd);}addSettingTab(){}registerEvent(){}async loadData(){return this.stored??null;}async saveData(d){this.stored=JSON.parse(JSON.stringify(d));}}
class Modal{constructor(app){this.app=app;this.titleEl={setText(){}};this.contentEl={empty(){}};}open(){}close(){this.onClose();}}
const obsidian={Plugin,TFile,TFolder,MarkdownView,Modal,Notice:class{constructor(t){notices.push(String(t));}},PluginSettingTab:class{},Setting:class{},editorInfoField:{}};
function load(){const module={exports:{}};vm.runInNewContext(built,{require:n=>n==='obsidian'?obsidian:require(n),module,exports:module.exports,process,Buffer,console,setTimeout,clearTimeout,AbortController});return module.exports.default;}

// Stand-in for the Codex CLI: answers the help and sign-in checks, notes every real request in a file, and
// returns title + answer for a first question or plain Markdown for a follow-up.
function fakeCli(dir){
 const cli=path.join(dir,'codex fake'),calls=path.join(dir,'calls.jsonl');
 fs.writeFileSync(cli,`#!${process.execPath}
const fs=require('fs');const args=process.argv.slice(2);
if(args.includes('--help')){console.log('--ignore-user-config --ignore-rules --json --sandbox --output-last-message [SESSION_ID]');process.exit(0);}
if(args[0]==='login'){console.log('Logged in');process.exit(0);}
let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{
 fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({resume:args.includes('resume')?args[args.indexOf('resume')+1]:null,input:s})+'\\n');
 const data=JSON.parse(s.split('Request (JSON):\\n')[1]),answer='Answer to: '+data.question+' with \\\\(x^2\\\\)';
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],s.includes('exactly the string fields title and answer')?JSON.stringify({title:${JSON.stringify(TITLE)},answer}):answer);
 console.log(JSON.stringify({type:'thread.started',thread_id:'${SESSION}'}));console.log(JSON.stringify({type:'turn.completed'}));
});
`,{mode:0o755});
 return{cli,calls:()=>fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').map(l=>{const x=JSON.parse(l);return{...x,data:JSON.parse(x.input.split('Request (JSON):\n')[1])};}):[]};
}

async function host(settings={},stored){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ask-about-selection-test-')),fake=fakeCli(dir);
 const files=new Map(),folders=new Map([['',new TFolder('')]]),text=new Map(),views=[],opened=[],log=[];let active,failCreate;
 const parent=p=>p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
 const vault={on(){return{};},
  getAbstractFileByPath:p=>files.get(p)??(p?folders.get(p):null)??null,
  read:async f=>{if(!text.has(f.path))throw Error('missing '+f.path);return text.get(f.path);},
  create:async(p,content)=>{if(failCreate){const e=failCreate;failCreate=undefined;throw e;}if([...files.keys(),...folders.keys()].some(k=>k.toLowerCase()===p.toLowerCase()))throw Error('File already exists.');if(!folders.has(parent(p)))throw Error('No such folder: '+parent(p));const f=new TFile(p);files.set(p,f);text.set(p,content);folders.get(parent(p)).children.push(f);log.push('create '+p);return f;},
  createFolder:async p=>{if(folders.has(p)||files.has(p))throw Error('Folder already exists.');const f=new TFolder(p);folders.set(p,f);folders.get(parent(p)).children.push(f);log.push('folder '+p);return f;},
  process:async(f,fn)=>{const next=fn(text.get(f.path));text.set(f.path,next);log.push('process '+f.path);return next;}};
 const workspace={on(){return{};},getLeavesOfType:()=>views.map(view=>({view})),getActiveViewOfType:()=>active,getActiveFile:()=>active?.file??null,getLeaf:()=>({openFile:async f=>{opened.push(f.path);}})};
 const fileManager={generateMarkdownLink:(f,_from,sub='',alias='')=>`[[${f.path.replace(/\.md$/,'')}${sub}${alias?'|'+alias:''}]]`};
 const p=new (load())();p.stored=stored??{settings:{cliPath:fake.cli,timeoutSeconds:20,...settings}};if(stored)p.stored.settings={cliPath:fake.cli,timeoutSeconds:20,...stored.settings};
 p.app={vault,workspace,fileManager};await p.onload();
 // Puts a file straight into the vault (as if it had always been there).
 function write(name,content){let dirs='';for(const part of parent(name).split('/').filter(Boolean)){dirs=dirs?dirs+'/'+part:part;if(!folders.has(dirs)){const f=new TFolder(dirs);folders.set(dirs,f);folders.get(parent(dirs)).children.push(f);}}if(!files.has(name)){const f=new TFile(name);files.set(name,f);folders.get(parent(name)).children.push(f);}text.set(name,content);return files.get(name);}
 // Opens a note in an editor. The editor has its own text (it can differ from the saved file) and a selection.
 function open(name,selection,mode='source'){const v=new MarkdownView();v.file=files.get(name);v.mode=mode;v.buffer=text.get(name);let from=0,to=0;if(selection){from=v.buffer.indexOf(selection);assert.ok(from>=0);to=from+selection.length;}
  v.editor={getValue:()=>v.buffer,replaceRange:(t,pos)=>{v.buffer=v.buffer.slice(0,pos)+t+v.buffer.slice(pos);},offsetToPos:o=>o,posToOffset:o=>o,getCursor:w=>w==='from'?from:to,listSelections:()=>[{}],getSelection:()=>v.buffer.slice(from,to)};views.push(v);active=v;return v;}
 const close=v=>{views.splice(views.indexOf(v),1);if(active===v)active=undefined;};
 return{p,fake,write,open,close,opened,log,text:n=>text.get(n),names:()=>[...files.keys()].sort(),failNextCreate:e=>{failCreate=e;},done:()=>{p.onunload();fs.rmSync(dir,{recursive:true,force:true});}};
}
const SOURCE='Notes/Topology.md',ORIGINAL='# Compact sets\n\nA compact set is closed and bounded.\n\nNext paragraph.\n';
const answerPath=(n='')=>`AI Answers/${TITLE} – ${c.localDate()}${n}.md`;
async function ask(h,question='Why closed?',selection='closed and bounded'){if(!h.text(SOURCE))h.write(SOURCE,ORIGINAL);const v=h.open(SOURCE,selection);await h.p.captureDraft(v.editor,v);assert.ok(h.p.draft,notices.at(-1));h.p.draft.question=question;return v;}

test('a question about a selection creates a linked answer note and leaves the source note untouched',async()=>{
 const h=await host();try{
  const v=await ask(h);assert.equal(h.p.draft.contextKind,'selection');assert.equal(h.p.draft.writeback,false);const conversation=h.p.draft.conversation;
  await h.p.submit();assert.equal(h.p.draft,undefined,h.p.status);assert.equal(h.p.stored.draft,undefined);
  const note=h.text(answerPath());assert.ok(note,h.names().join());
  assert.deepEqual(c.metadata(note),{conversation,session:SESSION});
  assert.ok(note.includes(`# ${TITLE} – ${c.localDate()}`));
  assert.match(note,/Source: \[\[Notes\/Topology#Compact sets\|To the section \(excerpt below\)\]\]/);
  assert.ok(note.includes('Context: Selected text only\n\n## Shared excerpt\n\n> closed and bounded'));
  assert.match(note,/## Question · \d{4}-\d\d-\d\d \d\d:\d\d\n\n> Why closed\?\n\nMode: \*\*Explain\*\*\n\n### Answer\n\nAnswer to: Why closed\? with \$x\^2\$/);
  assert.equal(h.text(SOURCE),ORIGINAL);assert.equal(v.buffer,ORIGINAL);          // neither the file nor the open editor was changed
  assert.deepEqual(h.opened,[answerPath()]);                                     // the answer opens next to the note
  const calls=h.fake.calls();assert.equal(calls.length,1);assert.equal(calls[0].resume,null);
  assert.deepEqual(calls[0].data,{mode:'Explain',question:'Why closed?',context:{kind:'selection',content:'closed and bounded',sourcePath:SOURCE}});
 }finally{h.done();}
});

test('with "add a link" on, the open editor gets a block ID and a 💬 link, and the answer points at that paragraph',async()=>{
 const h=await host({linkBack:true});try{
  const v=await ask(h);assert.equal(h.p.draft.writeback,true);const request=h.p.draft.request;await h.p.submit();assert.equal(h.p.draft,undefined,h.p.status);
  const m=/^# Compact sets\n\nA compact set is closed and bounded\.\n\n\^(ask-[0-9a-f-]{36})\n\n\[\[AI Answers\/Why compact sets are closed – \d{4}-\d\d-\d\d\|💬1\]\] <!-- ask-selection-link:([0-9a-f-]{36}) -->\n\nNext paragraph\.\n$/.exec(v.buffer);
  assert.ok(m,v.buffer);assert.equal(m[2],request);
  assert.equal(h.text(SOURCE),ORIGINAL);                                         // the change went through the editor, so Obsidian saves it itself
  assert.ok(h.text(answerPath()).includes(`Source: [[Notes/Topology#^${m[1]}|To the original paragraph]]`));
  // A second question about the same paragraph reuses the block ID and gets the next number.
  h.close(v);h.write(SOURCE,v.buffer);await ask(h,'And bounded?','closed and bounded');await h.p.submit();assert.equal(h.p.draft,undefined,h.p.status);
  const second=h.p.app.workspace.getActiveViewOfType().buffer;assert.match(second,/\|💬1\]\] <!--[^\n]+-->\n\n\[\[AI Answers\/[^\]]+ \(2\)\|💬2\]\] <!--[^\n]+-->\n\nNext paragraph\.\n$/);assert.equal(c.blockIdCount(second,m[1]),1);
 }finally{h.done();}
});

test('a note that is not open in an editor is changed directly in the file; a list item is never changed',async()=>{
 const h=await host({linkBack:true});try{
  const v=await ask(h);h.close(v);await h.p.submit();assert.equal(h.p.draft,undefined,h.p.status);
  assert.match(h.text(SOURCE),/bounded\.\n\n\^ask-[0-9a-f-]{36}\n\n\[\[[^\]]+\|💬1\]\] <!-- ask-selection-link:[0-9a-f-]{36} -->\n\nNext paragraph\.\n$/);
  const list='- item one\n- item two\n';h.write('Notes/List.md',list);const lv=h.open('Notes/List.md','item two');await h.p.captureDraft(lv.editor,lv);assert.equal(h.p.draft.writeback,false);
  h.p.draft.question='What is this?';await h.p.submit();assert.equal(h.p.draft,undefined,h.p.status);assert.equal(lv.buffer,list);assert.equal(h.text('Notes/List.md'),list);
 }finally{h.done();}
});

test('a follow-up continues the saved session and is added to the same note',async()=>{
 for(const mode of ['source','preview']){const h=await host();try{
  await ask(h);await h.p.submit();const before=h.names();
  const v=h.open(answerPath(),undefined,mode);await h.p.followup();assert.deepEqual({...h.p.draft.expected},c.metadata(h.text(answerPath())));
  h.p.draft.question='And why bounded?';h.p.draft.mode='hint';await h.p.submit();assert.equal(h.p.draft,undefined,h.p.status);
  const calls=h.fake.calls();assert.equal(calls.length,2);assert.equal(calls[1].resume,SESSION);assert.deepEqual(calls[1].data,{mode:'Give only a hint',question:'And why bounded?'});
  const note=mode==='source'?v.buffer:h.text(answerPath());                      // editing view: through the editor; reading view: the file
  assert.match(note,/## Question · [^\n]+\n\n> Why closed\?[\s\S]+## Follow-up · [^\n]+\n\n> And why bounded\?\n\nMode: \*\*Give only a hint\*\*\n\n### Answer\n\nAnswer to: And why bounded\? with \$x\^2\$\n$/);
  assert.deepEqual(h.names(),before);                                            // no second note
 }finally{h.done();}}
});

test('a free question shares no note; an existing name gets (2); nested answer folders are created',async()=>{
 const h=await host({folder:'Study/AI/Answers'});try{
  h.write(SOURCE,ORIGINAL);h.open(SOURCE,'closed and bounded');
  const taken=`Study/AI/Answers/${TITLE} – ${c.localDate()}.md`.toUpperCase().replace('.MD','.md');
  await h.p.freeQuestion();h.p.draft.question='What is compactness?';await h.p.submit();assert.equal(h.p.draft,undefined,h.p.status);
  assert.deepEqual(h.log.slice(0,3),['folder Study','folder Study/AI','folder Study/AI/Answers']);
  const first=`Study/AI/Answers/${TITLE} – ${c.localDate()}.md`,note=h.text(first);
  assert.ok(note.includes('No note context.'));assert.ok(!note.includes('Shared excerpt'));assert.ok(!note.includes('closed and bounded'));
  assert.deepEqual(h.fake.calls()[0].data,{mode:'Explain',question:'What is compactness?'});
  await h.p.freeQuestion();h.p.draft.question='Again?';await h.p.submit();assert.ok(h.text(first.replace('.md',' (2).md')),h.names().join());assert.equal(h.text(first),note);assert.ok(taken);
 }finally{h.done();}
});

test('if saving fails, the finished answer is kept and the AI is not asked a second time',async()=>{
 const h=await host();try{
  await ask(h);h.failNextCreate(Error('disk full'));await h.p.submit();
  assert.ok(h.p.draft?.result,'the answer stays in the draft');assert.match(h.p.status,/disk full/);assert.equal(h.p.stored.draft.result.answer,h.p.draft.result.answer);
  assert.equal(h.fake.calls().length,1);assert.equal(h.text(answerPath()),undefined);
  await h.p.submit();assert.equal(h.p.draft,undefined,h.p.status);assert.equal(h.fake.calls().length,1);assert.ok(h.text(answerPath()).includes('Answer to: Why closed?'));
  // An unsaved answer is only thrown away after a second click.
  await ask(h,'Third?');h.failNextCreate(Error('disk full'));await h.p.submit();assert.ok(h.p.draft.result);
  await h.p.discard();assert.ok(h.p.draft,'first click only warns');assert.match(h.p.status,/once more/);await h.p.discard();assert.equal(h.p.draft,undefined);
 }finally{h.done();}
});

test('if the note changed after the context was captured, nothing is sent',async()=>{
 const h=await host();try{
  const v=await ask(h);v.buffer=v.buffer.replace('bounded','BOUNDED');await h.p.submit();
  assert.ok(h.p.draft);assert.equal(h.p.draft.result,undefined);assert.match(h.p.status,/Capture context again/);assert.equal(h.fake.calls().length,0);assert.deepEqual(h.names(),[SOURCE]);
  await h.p.selectContext('selection',true);await h.p.submit();assert.equal(h.p.draft,undefined,h.p.status);assert.equal(h.fake.calls()[0].data.context.content,'closed and BOUNDED');
 }finally{h.done();}
});

test('a file in the way of the answer folder is reported and the answer is kept',async()=>{
 const h=await host({folder:'Notes/Topology.md/Answers'});try{
  await ask(h);await h.p.submit();assert.ok(h.p.draft?.result);assert.match(h.p.status,/is a file, not a folder/);assert.deepEqual(h.names(),[SOURCE]);
  h.p.settings.folder='Answers';await h.p.submit();assert.equal(h.p.draft,undefined,h.p.status);assert.ok(h.text(`Answers/${TITLE} – ${c.localDate()}.md`));
 }finally{h.done();}
});

test('a follow-up whose conversation note has disappeared is saved in a new note',async()=>{
 const h=await host();try{
  await ask(h);await h.p.submit();h.open(answerPath());await h.p.followup();h.p.draft.question='Still there?';h.p.draft.lost=true;
  await h.p.submit();assert.equal(h.p.draft,undefined,h.p.status);
  const created=h.names().filter(n=>n.startsWith('AI Answers/')&&n!==answerPath());assert.equal(created.length,1);
  assert.ok(h.text(created[0]).includes('> Still there?'));assert.ok(notices.some(n=>/could not be found any more/.test(n)));
 }finally{h.done();}
});

test('a written draft survives a restart with the settings; an empty or outdated draft is dropped',async()=>{
 const draft={request:c.newId(),conversation:c.newId(),question:'kept',mode:'hint',contextKind:'none'};
 let h=await host({},{settings:{folder:'Mine',linkBack:true},draft});try{assert.equal(h.p.draft.question,'kept');assert.equal(h.p.settings.folder,'Mine');assert.equal(h.p.settings.linkBack,true);assert.equal(h.p.settings.selectionPopup,true);assert.match(h.p.statusText,/draft waiting/);}finally{h.done();}
 h=await host({},{settings:{},draft:{...draft,question:'  '}});try{assert.equal(h.p.draft,undefined);}finally{h.done();}
 h=await host({},{settings:{},draft:{...draft,contextKind:undefined}});try{assert.equal(h.p.draft,undefined);}finally{h.done();}
});

test('the built plugin contains no personal paths, names or keys',()=>{
 for(const pattern of [/\/Users\/[A-Za-z]/,/\/home\/[a-z]/i,/C:\\\\Users/i,/sk-[A-Za-z0-9]{20,}/,/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(?:com|me|org|net|at|de)\b/])assert.ok(!pattern.test(built),String(pattern));
});
