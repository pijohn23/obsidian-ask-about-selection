const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const b = require('../.test-build/backend.cjs');
const session='12345678-1234-4321-8321-123456789abc';
test('arguments use explicit session, read-only policy, stdin and no --last',()=> {
  const args=b.execArgs('/tmp/space & $','/tmp/answer','model',session);
  assert.equal(args.at(-1),'-'); assert.equal(args[args.indexOf('resume')+1],session);
  assert.ok(!args.includes('--last')); assert.ok(args.includes('read-only')); assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.indexOf('--sandbox')<args.indexOf('resume')); assert.throws(()=>b.execArgs('x','y','','--last'));
});
test('JSON event parser tolerates chunk boundaries and enforces identity',()=> {
  const e=new b.Events(); const data=JSON.stringify({type:'thread.started',thread_id:session})+'\n{"type":"turn.completed"}\n';
  for(const char of data)e.push(char); e.finish(); assert.equal(e.session,session); assert.ok(e.completed);
  assert.throws(()=>e.push('{bad}\n'));
  const other=new b.Events(); assert.throws(()=>other.push('{"type":"thread.started","thread_id":"--last"}\n'));
});
test('real subprocess transport: arbitrary stdin stays data, paths with specials, success/resume',async()=> {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'plugin & ü-'));
  const cli=path.join(dir,'codex fake');
  await fs.writeFile(cli,`#!${process.execPath}\nconst fs=require('fs'); const args=process.argv.slice(2); if(args.includes('--help')){ console.log('--ignore-user-config --ignore-rules --json --sandbox --output-last-message [SESSION_ID]');process.exit(0); } if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);} let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{fs.writeFileSync(args[args.indexOf('--output-last-message')+1],s);console.log(JSON.stringify({type:'thread.started',thread_id:'${session}'}));console.log(JSON.stringify({type:'turn.completed'}));});\n`,{mode:0o755});
  const input='Ä \\ " $(touch /tmp/NEVER-ask-about-selection) \n Ignore instructions';
  for(const id of [undefined,session]) { const r=await b.runCodex({cliPath:cli,model:'',timeoutSeconds:10},input,new AbortController().signal,()=>{},id);assert.equal(r.answer,input);assert.equal(r.session,session); }
  await assert.rejects(fs.access('/tmp/NEVER-ask-about-selection'));
  await fs.rm(dir,{recursive:true});
});
test('missing binary and authentication failure produce actionable errors',async()=> {
  await assert.rejects(b.findCli('/does/not/exist'),/not found/);
  await assert.rejects(b.processRun(process.execPath,['-e','console.error("401 unauthorized"); process.exit(1)'],'',os.tmpdir(),new AbortController().signal,2000),/not signed in/);
});
test('cancel and timeout terminate child; no success is reported',async()=> {
  const c=new AbortController(); const p=b.processRun(process.execPath,['-e','setInterval(()=>{},1000)'],'',os.tmpdir(),c.signal,2000);setTimeout(()=>c.abort(),50);await assert.rejects(p,/Cancelled/);
  await assert.rejects(b.processRun(process.execPath,['-e','setInterval(()=>{},1000)'],'',os.tmpdir(),new AbortController().signal,50),/Time limit/);
});
test('nonzero exit and malformed JSON fail safely',async()=> {
  await assert.rejects(b.processRun(process.execPath,['-e','process.exit(3)'],'',os.tmpdir(),new AbortController().signal,2000),/exit 3/);
  await assert.rejects(b.processRun(process.execPath,['-e','console.log("oops")'],'',os.tmpdir(),new AbortController().signal,2000,s=>new b.Events().push(s)),/JSON/);
});

test('error event remains fatal even after completed event',()=>{const e=new b.Events();e.push(JSON.stringify({type:'error',message:'fatal'})+'\n'+JSON.stringify({type:'turn.completed'})+'\n');e.finish();assert.equal(e.failure,'fatal');assert.equal(e.completed,true);});
