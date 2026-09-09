import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { captureFork, serializeFork, selectFork, requestEvidence } from "./native-fork.ts";
import { DEFAULT_CONFIG } from "./router.ts";
import workerContext from "./worker-context.ts";
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
const bus = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
const { SessionManager } = await import(pathToFileURL(join(piRoot, "dist/core/session-manager.js")).href);
const root=mkdtempSync(join(tmpdir(),"pi-native-fork-integration-"));
after(()=>rmSync(root,{recursive:true,force:true}));
const indexPath=fileURLToPath(new URL("./index.ts",import.meta.url));
const key=`__piFork_${process.pid}`;
const source=readFileSync(indexPath,"utf8").replace(/from "(\.[^"]+)"/g,(_m,r)=>`from ${JSON.stringify(resolve(dirname(indexPath),r))}`);
const wrapper=join(root,"index.ts");
writeFileSync(wrapper,source+`\n(globalThis as any)[${JSON.stringify(key)}]={prepareDelegation,prepareForkFiles,cleanupForkFiles,workerInstructions};\n`);
const loaded=await loader.loadExtensions([wrapper],root,bus.createEventBus(),loader.createExtensionRuntime());
assert.deepEqual(loaded.errors,[]);
const {prepareDelegation,prepareForkFiles,cleanupForkFiles,workerInstructions}=globalThis[key];delete globalThis[key];
const model={id:"fixture",name:"fixture",provider:"openai",api:"openai-responses",baseUrl:"http://127.0.0.1:1",reasoning:true,input:["text","image"],
 cost:{input:1,output:1,cacheRead:0.1,cacheWrite:1},contextWindow:200000,maxTokens:1000};
const user=(sm,text)=>sm.appendMessage({role:"user",content:text,timestamp:1});
const assistant=(sm,content)=>sm.appendMessage({role:"assistant",content,api:model.api,provider:model.provider,model:model.id,stopReason:"toolUse",
 usage:{input:100,output:10,cacheRead:0,cacheWrite:0,totalTokens:110,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:2});
function ctx(sm=SessionManager.inMemory(root)) {
 return {cwd:root,sessionManager:sm,scopedModels:[],model,thinkingLevel:"high",getSystemPrompt:()=>"BASE-SYSTEM-UNCHANGED",
 modelRegistry:{getAvailable:()=>[model],getProviderDisplayName:()=>"fixture",complete:async()=>{throw Error("must not call unavailable Spark");}}};
}
const fixed={task:"inspect code",model:"openai/fixture",effort:"high",fork_turns:"all",permission:"read-only"};
function job(source,advice){
 const dir=mkdtempSync(join(root,"job-"));return {id:"job",name:"job",cwd:root,logPath:join(dir,"result.json"),task:"inspect code",contextNotes:"Do not change API",expectedOutput:"cited findings",
 writeScope:["src"],contextFiles:["src/a.ts"],config:structuredClone(DEFAULT_CONFIG),parentSnapshot:source,advice,
 route:{provider:model.provider,modelId:model.id,modelRef:"openai/fixture",modelName:"fixture",baseUrl:model.baseUrl,contextWindow:model.contextWindow,input:model.input,effort:"high",permission:"read-only",contextMode:"full"}};
}
test("real Pi: effective compaction context is seeded once and raw old history is absent",()=>{
 const c=ctx();user(c.sessionManager,"OLD-RAW".repeat(1000));const kept=user(c.sessionManager,"KEPT");c.sessionManager.appendCompaction("CURRENT-SUMMARY",kept,50000);user(c.sessionManager,"LATEST");
 const frozen=captureFork(c,"none");const file=join(root,"compacted.jsonl");writeFileSync(file,serializeFork(frozen.entries,root),{mode:0o600});
 const child=SessionManager.open(file);const rendered=JSON.stringify(child.buildSessionContext().messages);
 assert.doesNotMatch(rendered,/OLD-RAW/);assert.match(rendered,/CURRENT-SUMMARY/);assert.equal(rendered.split("KEPT").length-1,1);assert.match(rendered,/LATEST/);
 assert.notEqual(child.getSessionId(),c.sessionManager.getSessionId());
});
test("real Pi: off-branch messages never enter a frozen snapshot",()=>{
 const c=ctx();const leaf=user(c.sessionManager,"A");user(c.sessionManager,"OFF-BRANCH");c.sessionManager.branch(leaf);
 assert.doesNotMatch(JSON.stringify(captureFork(c,"call").entries),/OFF-BRANCH/);
});
test("real Pi: complete historical tools remain structured and the delegation is not replayed",()=>{
 const c=ctx();user(c.sessionManager,"read a file");assistant(c.sessionManager,[{type:"toolCall",id:"read-old",name:"read",arguments:{path:"a"}}]);
 c.sessionManager.appendMessage({role:"toolResult",toolCallId:"read-old",toolName:"read",content:[{type:"text",text:"EVIDENCE"}],isError:false,timestamp:3});
 assistant(c.sessionManager,[{type:"toolCall",id:"spawn-now",name:"delegate_subagent",arguments:{}}]);
 const frozen=captureFork(c,"spawn-now");const text=serializeFork(frozen.entries,root);assert.match(text,/read-old/);assert.doesNotMatch(text,/spawn-now/);assert.match(text,/toolResult/);
});
test("preparation keeps explicit choices and never calls unavailable Spark",async()=>{
 const c=ctx();user(c.sessionManager,"REFERENCE");const before=JSON.stringify(c.sessionManager.getEntries());
 const r=await prepareDelegation(c,fixed,structuredClone(DEFAULT_CONFIG));assert.equal(r.advice.advisor.calls,0);assert.equal(r.advice.model,"openai/fixture");
 assert.equal(JSON.stringify(c.sessionManager.getEntries()),before);assert.equal(r.decision.contextSummary,"");
});
test("explicit none avoids reading parent history even when routing is automatic",async()=>{
 const c=ctx();c.sessionManager={getSessionId:()=>"root",buildContextEntries(){throw Error("do not read");}};
 const r=await prepareDelegation(c,{task:"self-contained",fork_turns:"none",permission:"read-only"},structuredClone(DEFAULT_CONFIG));
 assert.deepEqual(r.source.entries,[]);assert.equal(r.advice.advisor.calls,0);assert.match(r.advice.advisor.fallbackReason,/unavailable/);
});
test("a failed effective-context read stops preparation before routing",async()=>{
 const c=ctx();c.sessionManager.buildContextEntries=()=>{throw Error("context failed");};await assert.rejects(prepareDelegation(c,fixed,structuredClone(DEFAULT_CONFIG)),/context failed/);
});
test("native files preserve the original system only for a full same-cwd fork",async()=>{
 const c=ctx();user(c.sessionManager,"REFERENCE");const r=await prepareDelegation(c,fixed,structuredClone(DEFAULT_CONFIG));const j=job(r.source,r.advice);
 prepareForkFiles(j);assert.equal(j.replaceSystemPrompt,true);assert.equal(readFileSync(j.contextPath,"utf8"),"BASE-SYSTEM-UNCHANGED");
 assert.notEqual(SessionManager.open(j.sessionPath).getSessionId(),c.sessionManager.getSessionId());assert.equal(statSync(j.sessionPath).mode&0o777,0o600);
 const files=[...j.runtimePaths];cleanupForkFiles(j);for(const f of files)assert.equal(existsSync(f),false);
});
test("recent-turn forks do not claim full prefix inheritance",async()=>{
 const c=ctx();user(c.sessionManager,"old");user(c.sessionManager,"new");const r=await prepareDelegation(c,{...fixed,fork_turns:"1"},structuredClone(DEFAULT_CONFIG));const j=job(r.source,r.advice);
 prepareForkFiles(j);assert.equal(j.replaceSystemPrompt,false);assert.equal(j.fork.effective,"1");assert.doesNotMatch(readFileSync(j.sessionPath,"utf8"),/"old"/);assert.equal(JSON.parse(readFileSync(j.forkMetadataPath)).prefixIntact,false);cleanupForkFiles(j);
});
test("none retains independent in-memory execution and explicit task constraints",async()=>{
 const r=await prepareDelegation(ctx(),{...fixed,fork_turns:"none"},structuredClone(DEFAULT_CONFIG));const j=job(r.source,r.advice);prepareForkFiles(j);
 assert.equal(j.sessionPath,undefined);assert.match(workerInstructions(j),/read-only/);assert.match(workerInstructions(j),/historical reference/);cleanupForkFiles(j);
});
test("worker request hook changes only cache key and never session identity or effort",async()=>{
 const r=await prepareDelegation(ctx(),{...fixed,fork_turns:"none"},structuredClone(DEFAULT_CONFIG));const j=job(r.source,r.advice);prepareForkFiles(j);
 const old=process.env.PI_SUBAGENT_FORK_META;process.env.PI_SUBAGENT_FORK_META=j.forkMetadataPath;const handlers=new Map();
 try { workerContext({on:(name,fn)=>handlers.set(name,fn)}); } finally {if(old===undefined)delete process.env.PI_SUBAGENT_FORK_META;else process.env.PI_SUBAGENT_FORK_META=old;}
 const payload={model:"fixture",input:[{role:"user",content:"a"}],instructions:"stable",tools:[],reasoning:{effort:"high"},prompt_cache_key:"child-session",previous_response_id:"child-response"};
 const before=JSON.stringify(payload);const patched=handlers.get("before_provider_request")({payload},ctx());
 assert.match(patched.prompt_cache_key,/^pi-sa-/);assert.equal(patched.previous_response_id,"child-response");assert.deepEqual(patched.reasoning,{effort:"high"});assert.equal(JSON.stringify(payload),before);
 cleanupForkFiles(j);assert.equal(j.fork.cache.lastMode,"siblings");assert.doesNotMatch(JSON.stringify(j.fork.cache),/child-session|child-response/);
});
test("worker permission boundary blocks writing and re-delegation despite inherited instructions",async()=>{
 const r=await prepareDelegation(ctx(),fixed,structuredClone(DEFAULT_CONFIG));const j=job(r.source,r.advice);prepareForkFiles(j);
 const old=process.env.PI_SUBAGENT_FORK_META;process.env.PI_SUBAGENT_FORK_META=j.forkMetadataPath;const handlers=new Map();
 try {workerContext({on:(n,f)=>handlers.set(n,f)});}finally{if(old===undefined)delete process.env.PI_SUBAGENT_FORK_META;else process.env.PI_SUBAGENT_FORK_META=old;}
 for(const toolName of ["write","edit","bash","delegate_subagent"])assert.equal(handlers.get("tool_call")({toolName}).block,true);
 assert.equal(handlers.get("tool_call")({toolName:"read"}),undefined);cleanupForkFiles(j);
});
test("cleanup never writes parent JSONL and is idempotent",async()=>{
 const c=ctx();user(c.sessionManager,"parent");const before=JSON.stringify(c.sessionManager.getEntries());const r=await prepareDelegation(c,fixed,structuredClone(DEFAULT_CONFIG));const j=job(r.source,r.advice);prepareForkFiles(j);cleanupForkFiles(j);cleanupForkFiles(j);assert.equal(JSON.stringify(c.sessionManager.getEntries()),before);
});

test("installed Pi CLI loads native seed, appends only the new task and reports only fresh assistant output",()=>{
 const dir=mkdtempSync(join(root,"cli-"));mkdirSync(join(dir,"agent"));writeFileSync(join(dir,"agent","settings.json"),'{}');writeFileSync(join(dir,"agent","auth.json"),'{}');
 const seed=join(dir,"seed.jsonl");writeFileSync(seed,serializeFork([{type:"message",message:{role:"user",content:"NATIVE-PARENT-EVIDENCE",timestamp:1}}],dir,"11111111-1111-4111-8111-111111111111"),{mode:0o600});
 const capture=join(dir,"capture.json");const ext=join(dir,"fixture.ts");
 writeFileSync(ext,`
 import {writeFileSync} from 'node:fs';
 import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
 export default function(pi){pi.registerProvider('fork-fixture',{
 api:'openai-responses',baseUrl:'http://127.0.0.1:1',apiKey:'test-only',
 models:[{id:'test',name:'Test',reasoning:false,input:['text'],contextWindow:100000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
 streamSimple:(model,context,options)=>{
 writeFileSync(${JSON.stringify(capture)},JSON.stringify({messages:context.messages,sessionId:options.sessionId}));
 const output=createAssistantMessageEventStream();
 queueMicrotask(()=>{const message={role:'assistant',content:[{type:'text',text:'FORK-CLI-OK'}],api:model.api,provider:model.provider,model:model.id,usage:{input:10,output:3,cacheRead:0,cacheWrite:0,totalTokens:13,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};output.push({type:'done',reason:'stop',message});output.end();});
 return output;
 }});}
 `);
 const result=spawnSync(process.execPath,[join(piRoot,"dist/cli.js"),"--offline","--mode","json","-p","--no-extensions","-e",ext,"--session",seed,"--model","fork-fixture/test","--tools","read","CURRENT-DELEGATED-TASK"],{
 cwd:dir,env:{...process.env,PI_CODING_AGENT_DIR:join(dir,"agent"),PI_OFFLINE:"1",PI_SKIP_VERSION_CHECK:"1",PI_SUBAGENT_FORK_META:""},encoding:"utf8",timeout:30000});
 assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);assert.match(result.stdout,/FORK-CLI-OK/);
 const actual=JSON.parse(readFileSync(capture,"utf8"));assert.equal(actual.sessionId,"11111111-1111-4111-8111-111111111111");assert.match(JSON.stringify(actual.messages),/NATIVE-PARENT-EVIDENCE/);assert.match(JSON.stringify(actual.messages),/CURRENT-DELEGATED-TASK/);
 const ends=result.stdout.split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return{};}}).filter(e=>e.type==="message_end"&&e.message?.role==="assistant");assert.equal(ends.length,1);
});
