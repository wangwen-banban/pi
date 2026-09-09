import assert from "node:assert/strict";
import test from "node:test";
import { routeTask } from "./fork-advisor.ts";
import { DEFAULT_CONFIG, mergeConfig } from "./router.ts";
const models=[{ref:"provider/parent",name:"Parent",tier:"S",thinkingLevels:["low","medium","high"],contextWindow:200000,input:["text","image"]},
 {ref:"provider/small",name:"Small",tier:"C",thinkingLevels:["low","medium"],contextWindow:128000,input:["text"]}];
const parent={sessionId:"private-session-id",model:"provider/parent",effort:"high",turns:9,estimatedTokens:25000,hasImages:false};
const base={task:"Inspect the implementation",permission:"read-only"};
function harness() {
 const config=structuredClone(DEFAULT_CONFIG);
 for(const key of Object.keys(config.routes)) config.routes[key].models=["provider/small","$current"];
 const calls=[];let reply={model:"provider/parent",effort:"high",fork_turns:"all",reason:"needs context"};let error;
 return {config,calls,reply:value=>reply=value,fail:()=>error=Error("synthetic failure"),complete:async(ref,prompt,options)=>{
  calls.push({ref,prompt,options});if(error)throw error;
  return {content:[{type:"text",text:JSON.stringify(reply)}],usage:{input:200,output:40},stopReason:"stop"};
 }};
}
test("default router is Spark with explicit bounded selector settings",()=>{
 assert.equal(DEFAULT_CONFIG.router.model,"openai-codex/gpt-5.3-codex-spark");assert.equal(DEFAULT_CONFIG.router.maxTaskChars,6000);
 assert.equal(mergeConfig({router:{timeoutMs:Infinity,maxTaskChars:999999,maxOutputTokens:1}}).router.timeoutMs,15000);
});
test("router receives only metadata and task text, never parent conversation",async()=>{
 const h=harness();const r=await routeTask({...base,contextNotes:"explicit constraint"},h.config,models,parent,h.complete);
 assert.equal(h.calls.length,1);assert.equal(r.model,"provider/parent");assert.equal(r.suggestedFork,"all");
 assert.match(h.calls[0].prompt,/PARENT METADATA ONLY/);assert.doesNotMatch(h.calls[0].prompt,/private-session-id|context_summary/);
 assert.match(h.calls[0].prompt,/explicit constraint/);assert.equal(h.calls[0].options.maxTokens,512);assert.equal(h.calls[0].options.reasoningEffort,"low");
});
test("fully fixed choices skip the selector including the former summary alias",async()=>{
 const h=harness();const r=await routeTask({...base,model:"provider/parent",effort:"high",contextMode:"summary"},h.config,models,parent,h.complete);
 assert.equal(h.calls.length,0);assert.equal(r.suggestedFork,"all");assert.match(r.reason,/skipped/);
});
test("routing never changes explicit model, effort, permission or fork",async()=>{
 const h=harness();h.reply({model:"provider/small",effort:"low",fork_turns:"none",permission:"workspace-write"});
 const r=await routeTask({...base,model:"provider/parent",effort:"high"},h.config,models,parent,h.complete);
 assert.equal(r.model,"provider/parent");assert.equal(r.effort,"high");assert.equal(r.permission,"read-only");
});
test("isolated mode is preserved when other choices need the advisor",async()=>{
 const h=harness();const r=await routeTask({...base,fork_turns:"none"},h.config,models,{...parent,turns:0,estimatedTokens:0},h.complete);
 assert.equal(r.suggestedFork,"none");assert.equal(h.calls.length,1);
});
test("unknown router models/efforts yield deterministic fallback, never arbitrary execution",async()=>{
 const h=harness();h.reply({model:"attacker/new-provider",effort:"max",fork_turns:"all"});
 const r=await routeTask(base,h.config,models,parent,h.complete);
 assert.equal(r.model,"provider/small");assert.match(r.advisor.fallbackReason,/Invalid/);assert.equal(r.advisor.calls,1);
});
test("unavailable Spark does not call the current main model",async()=>{
 const h=harness();const r=await routeTask(base,h.config,models,parent,undefined);
 assert.equal(r.advisor.calls,0);assert.match(r.advisor.fallbackReason,/no silent main-model fallback/);
});
test("disabled router remains a deterministic zero-call route",async()=>{
 const h=harness();h.config.router.enabled=false;const r=await routeTask(base,h.config,models,parent,h.complete);assert.equal(h.calls.length,0);assert.match(r.advisor.fallbackReason,/disabled/i);
});
test("failed router makes one attempt and reports fallback",async()=>{
 const h=harness();h.fail();const r=await routeTask(base,h.config,models,parent,h.complete);assert.equal(h.calls.length,1);assert.match(r.advisor.fallbackReason,/failed/);
});
test("invalid fork choice is not executed",async()=>{
 const h=harness();h.reply({model:"provider/parent",effort:"high",fork_turns:"-1"});const r=await routeTask(base,h.config,models,parent,h.complete);assert.notEqual(r.suggestedFork,-1);assert.ok(r.advisor.fallbackReason);
});
test("explicit cancellation propagates rather than spawning a fallback worker",async()=>{
 const h=harness();const c=new AbortController();c.abort(Error("user aborted"));await assert.rejects(routeTask(base,h.config,models,parent,h.complete,c.signal),/user aborted/);assert.equal(h.calls.length,0);
});
test("task payload is bounded without truncating the worker's original task",async()=>{
 const h=harness();h.config.router.maxTaskChars=1000;const params={...base,task:"Q".repeat(20000)};await routeTask(params,h.config,models,parent,h.complete);
 assert.ok(h.calls[0].prompt.split("TASK DATA: ")[1].length<=1000);assert.equal(params.task.length,20000);
});
test("router usage remains separate and does not claim a measured saving",async()=>{
 const h=harness();const r=await routeTask(base,h.config,models,parent,h.complete);assert.deepEqual(r.usage,{input:200,output:40});assert.equal(r.advisor.calls,1);
});
test("router cache grouping does not reuse the main session or modify unrelated payload fields",async()=>{
 const h=harness();await routeTask(base,h.config,models,parent,h.complete);const options=h.calls[0].options;
 assert.notEqual(options.sessionId,parent.sessionId);
 const p={model:"spark",input:[],reasoning:{effort:"low"},prompt_cache_key:"worker",previous_response_id:"own"};const q=options.onPayload(p);
 assert.match(q.prompt_cache_key,/^pi-router-/);assert.equal(q.previous_response_id,"own");assert.equal(p.prompt_cache_key,"worker");
});
test("fixed unknown model fails before any provider request",async()=>{
 const h=harness();await assert.rejects(routeTask({...base,model:"missing"},h.config,models,parent,h.complete),/No eligible/);assert.equal(h.calls.length,0);
});

test("router wait is bounded even if a custom provider ignores AbortSignal", async () => {
 const h=harness();h.config.router.timeoutMs=20;let calls=0;
 const r=await routeTask(base,h.config,models,parent,async()=>{calls++;return new Promise(()=>{});});
 assert.equal(calls,1);assert.match(r.advisor.fallbackReason,/timeout/);assert.equal(r.model,"provider/small");
});
