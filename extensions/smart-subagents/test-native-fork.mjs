import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseForkTurns, requestedFork, captureFork, selectFork, completeToolPairs, serializeFork, privateFile,
 requestEvidence, cacheDecision, estimateForkTokens } from "./native-fork.ts";
import { buildWorkerArgs } from "./worker-bootstrap.ts";

const u = text => ({ type:"message", message:{role:"user",content:text,timestamp:1} });
const a = content => ({type:"message",message:{role:"assistant",content,timestamp:2}});
const t = (id,text) => ({type:"message",message:{role:"toolResult",toolCallId:id,toolName:"read",content:[{type:"text",text}],timestamp:3}});
const model = {provider:"openai-codex",id:"test",baseUrl:"https://chatgpt.com/backend-api",contextWindow:200000,input:["text","image"]};
const snap = entries => ({entries,systemPrompt:"stable",parentSessionId:"root",provider:model.provider,model:model.id,baseUrl:model.baseUrl,effort:"high",cwd:process.cwd()});
const limits = {maxTokens:128000,maxBytes:8388608,recentTurns:3};
function evidence(overrides={}) {
 const payload = {model:"test",instructions:"stable",input:[{role:"user",content:"history"}],reasoning:{effort:"high"},tools:[],prompt_cache_key:"root",...overrides};
 return requestEvidence(payload,{...model,api:"openai-codex-responses"});
}

test("fork_turns parses only bounded supported forms",()=>{
 for (const [v,w] of [["all","all"],["none","none"],["3",3],[2,2],[undefined,"auto"]]) assert.equal(parseForkTurns(v),w);
 for(const v of [0,-1,"0","-1",1.2,"1.2",true,{},"Infinity","10001"]) assert.throws(()=>parseForkTurns(v));
});
test("legacy context aliases normalize to native choices, conflicts fail",()=>{
 assert.equal(requestedFork({contextMode:"summary"}),"all");
 assert.equal(requestedFork({contextMode:"isolated"}),"none");
 assert.equal(requestedFork({contextMode:"selected"}),3);
 assert.throws(()=>requestedFork({contextMode:"full",fork_turns:"none"}),/Conflicting/);
});
test("snapshot freezes before the current spawn call and excludes state markers",()=>{
 const entries=[u("previous"),{type:"custom",customType:"permission",data:"approved"},a([{type:"toolCall",id:"spawn",name:"delegate_subagent",arguments:{}}]),t("spawn","running")];
 const before=JSON.stringify(entries);
 const ctx={sessionManager:{buildContextEntries:()=>entries,getSessionId:()=>"root"},getSystemPrompt:()=>"stable",model,cwd:"/work",thinkingLevel:"high"};
 const result=captureFork(ctx,"spawn");
 assert.equal(result.entries.length,1); assert.equal(result.entries[0].message.content,"previous");
 entries[0].message.content="later";assert.equal(result.entries[0].message.content,"previous");assert.notEqual(JSON.stringify(entries),before);
});
test("snapshot never consults raw branch or mutates parent entries",()=>{
 const entries=[{type:"compaction",summary:"summary",tokensBefore:999},u("kept")];const before=JSON.stringify(entries);
 captureFork({sessionManager:{buildContextEntries:()=>entries,getBranch(){throw Error("raw");},getSessionId:()=>"root"},getSystemPrompt:()=>"x",model,cwd:"/w"},"other");
 assert.equal(JSON.stringify(entries),before);
});
test("all preserves structured messages and completed tool pairs",()=>{
 const entries=[u("read"),a([{type:"toolCall",id:"c1",name:"read",arguments:{path:"a"}}]),t("c1","evidence")];
 const selection=selectFork(snap(entries),"all","all",model,limits);
 assert.deepEqual(selection.entries,entries);assert.equal(selection.prefixIntact,true);
});
test("recent turns start at a user boundary and retain the current compaction summary",()=>{
 const entries=[{type:"compaction",summary:"earlier"},u("old"),a([{type:"text",text:"answer"}]),u("new"),a([{type:"text",text:"current"}])];
 const selection=selectFork(snap(entries),1,1,model,limits);
 assert.deepEqual(selection.entries,[entries[0],...entries.slice(3)]);assert.equal(selection.prefixIntact,false);
});
test("none does not inherit any message",()=>assert.deepEqual(selectFork(snap([u("private")]),"none","none",model,limits).entries,[]));
test("unmatched calls and orphan results are removed, not fabricated",()=>{
 const cleaned=completeToolPairs([u("x"),a([{type:"toolCall",id:"missing",name:"read",arguments:{}},{type:"text",text:"analysis"}]),t("orphan","do not seed")]);
 assert.equal(cleaned.changed,true);assert.equal(cleaned.entries.length,2);assert.deepEqual(cleaned.entries[1].message.content,[{type:"text",text:"analysis"}]);
});
test("explicit over-budget all fails instead of silently becoming a truncated fork",()=>{
 assert.throws(()=>selectFork(snap([u("x".repeat(30000))]),"all","all",model,{...limits,maxTokens:1000}),/Explicit fork exceeds/);
});
test("auto budget fallbacks are explicit in the effective fork",()=>{
 const r=selectFork(snap([u("x".repeat(20000)),u("recent")]),"auto","all",model,{...limits,maxTokens:1000});
 assert.equal(r.effective,1);assert.equal(r.entries[0].message.content,"recent");
});
test("different model defaults to recent history, never claims intact parent prefix",()=>{
 const r=selectFork(snap([u("a"),u("b"),u("c"),u("d")]),"auto","all",{...model,id:"other"},limits);
 assert.equal(r.effective,3);assert.equal(r.prefixIntact,false);
});
test("unsupported images do not silently turn an explicit fork into text",()=>{
 const s=snap([{type:"message",message:{role:"user",content:[{type:"image",data:"AA==",mimeType:"image/png"}]}}]);
 assert.throws(()=>selectFork(s,"all","all",{...model,input:["text"]},limits),/images/);
 assert.throws(()=>selectFork(s,"auto","all",{...model,input:["text"]},limits),/images/);
});
test("cross-model forks strip opaque reasoning and text signatures, preserving visible evidence",()=>{
 const s=snap([u("task"),a([{type:"thinking",thinking:"secret",thinkingSignature:"opaque"},{type:"text",text:"evidence",textSignature:"other-model"}])]);
 const r=selectFork(s,"all","all",{...model,id:"other"},limits);
 assert.deepEqual(r.entries[1].message.content,[{type:"text",text:"evidence"}]);assert.equal(s.entries[1].message.content.length,2);
});
test("native JSONL uses new identities and never includes mutable approval state",()=>{
 const s=serializeFork([u("first"),{type:"custom",data:{approved:true}},t("c","value")],"/work","child").trim().split("\n").map(JSON.parse);
 assert.equal(s[0].version,3);assert.equal(s[0].id,"child");assert.equal(s.length,3);assert.equal(s[1].parentId,null);assert.equal(s[2].parentId,s[1].id);
});
test("two independent fork files never share their session ID",()=>{
 const x=JSON.parse(serializeFork([u("x")],"/work").split("\n")[0]);
 const y=JSON.parse(serializeFork([u("x")],"/work").split("\n")[0]);assert.notEqual(x.id,y.id);
});
test("private seed creation refuses overwrite and symlink targets",tst=>{
 const dir=mkdtempSync(join(tmpdir(),"fork-private-"));tst.after(()=>rmSync(dir,{recursive:true,force:true}));
 const f=privateFile(dir,"a","private");assert.equal(statSync(f).mode&0o777,0o600);assert.throws(()=>privateFile(dir,"a","replace"));
 symlinkSync(f,join(dir,"b"));assert.throws(()=>privateFile(dir,"b","replace"));assert.equal(readFileSync(f,"utf8"),"private");assert.throws(()=>privateFile(dir,"../x","bad"));
});
test("native CLI seed replaces --no-session rather than being ignored by it",()=>{
 const args=buildWorkerArgs({modelRef:"p/m",effort:"high",tools:"read",contextPath:"/system.txt",sessionPath:"/child.jsonl",replaceSystemPrompt:true,prompt:"task",extensions:[]});
 assert.ok(args.includes("--session"));assert.ok(!args.includes("--no-session"));assert.ok(args.includes("--system-prompt"));assert.equal(args.at(-1),"task");
});
test("unseeded CLI continues to use an independent in-memory session",()=>{
 const args=buildWorkerArgs({modelRef:"p/m",effort:"high",tools:"read",contextPath:"/s",prompt:"task",extensions:[]});assert.ok(args.includes("--no-session"));assert.ok(!args.includes("--session"));
});
test("exact same model/configuration/prefix may use the parent cache group",()=>{
 const p=evidence();const c=evidence({prompt_cache_key:"independent-child",input:[{role:"user",content:"history"},{role:"user",content:"new task"}]});
 const d=cacheDecision(c,p,"root",true,true);assert.equal(d.mode,"parent");assert.equal(d.key,"root");assert.equal(c.key,"independent-child");
});
for (const [name,change] of [["model",{model:"other"}],["effort",{reasoning:{effort:"low"}}],["tools",{tools:[{type:"function",name:"read"}]}],["instructions",{instructions:"changed"}],["history",{input:[{role:"user",content:"different"}]}],["tier",{service_tier:"priority"}]]) {
 test(`a changed ${name} cannot claim parent cache compatibility`,()=>assert.equal(cacheDecision(evidence(change),evidence(),"root",true,true).mode,"siblings"));
}
test("sibling grouping is stable but isolated by root/account/provider/config",()=>{
 const p=evidence();const x=cacheDecision(p,undefined,"root",false,true);const y=cacheDecision(evidence({prompt_cache_key:"child-other"}),undefined,"root",false,true);assert.equal(x.key,y.key);
 assert.notEqual(x.key,cacheDecision(p,undefined,"other-root",false,true).key);
 assert.notEqual(x.key,cacheDecision({...p,provider:"openai-codex-second"},undefined,"root",false,true).key);
});
test("disabled caching is respected and unknown request protocols are not rewritten",()=>{
 assert.equal(cacheDecision(evidence(),evidence(),"root",true,false).mode,"independent");
 assert.equal(cacheDecision(evidence({prompt_cache_key:undefined}),evidence(),"root",true,true).mode,"independent");
 assert.equal(requestEvidence({input:[]},{api:"anthropic-messages"}),undefined);
});
test("token estimate does not count the raw base64 image bytes as text",()=>{
 assert.equal(estimateForkTokens([{type:"message",message:{role:"user",content:[{type:"image",data:"A"}]}}]),estimateForkTokens([{type:"message",message:{role:"user",content:[{type:"image",data:"A".repeat(100000)}]}}]));
});
