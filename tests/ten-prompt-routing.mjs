import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {projectWorkerProfile,planProjectWork,targetProjectWork} from '../src/index.js';
const cases=JSON.parse(await readFile(new URL('./fixtures/acceptance-prompts.json',import.meta.url),'utf8'));
assert.equal(cases.length,10);
const rows=cases.map(c=>{
 const profile=c.mode==='python'?{desired_workers:1,suggested_roles:['programmer']}:projectWorkerProfile(c.prompt,[]);
 const plan=c.mode==='python'?[{role_name:'programmer'}]:planProjectWork(c.prompt,[]);
 assert.ok(profile.desired_workers>=1&&profile.desired_workers<=6);
 assert.equal(plan.length,profile.desired_workers);
 return {id:c.id,mode:c.mode,desired_workers:profile.desired_workers,roles:plan.map(p=>p.role_name),live_nodes_selected:null};
});
assert.ok(new Set(rows.map(r=>r.desired_workers)).size>=3,'routing must vary with task');
console.log(JSON.stringify({test:'routing-policy-only',live:false,results:rows},null,2));


const explicitWorkerCounts=[1,2,3,10,20,50];
for(const requested of explicitWorkerCounts){
 const plan=targetProjectWork("Provide independent analyses of this prompt.",[],"ai",requested,"fixed");
 assert.equal(plan.length,requested,`fixed fanout mismatch for ${requested}`);
 assert.ok(plan.every(item=>item.task_text.includes("Provide independent analyses of this prompt.")));
}

const tailMarker="TAIL_MUST_REACH_EVERY_HOST";
const longPrompt="A".repeat(7000)+"\n"+tailMarker;
const longFanout=targetProjectWork(longPrompt,["verifier"],"ai",2,"fixed");
assert.equal(longFanout.length,2);
for(const item of longFanout){
 assert.match(item.task_text,/TAIL_MUST_REACH_EVERY_HOST/,"fixed fanout dropped the tail of a long prompt");
}

const workerSource=await readFile(new URL("../src/index.js",import.meta.url),"utf8");
assert.match(workerSource,/owned\.work_item_id != w\.work_item_id/,"distinct-host count must exclude the candidate row");
assert.match(workerSource,/own\.status != 'cancelled'/,"cancelled work must not permanently reserve a host");
assert.match(workerSource,/\$\.scheduling\.target_mode/,"atomic target-mode assignment guard missing");
assert.match(workerSource,/LIMIT 64/,"fanout scan must cover the 1–50 worker range");
