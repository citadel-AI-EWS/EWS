import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {projectWorkerProfile,planProjectWork} from '../src/index.js';
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
 const profile=projectWorkerProfile("Provide independent analyses of this prompt.",[],requested);
 const plan=planProjectWork("Provide independent analyses of this prompt.",[],requested);
 assert.equal(profile.desired_workers,requested,`requested worker profile mismatch for ${requested}`);
 assert.equal(plan.length,requested,`requested worker plan mismatch for ${requested}`);
}

const cappedRoles=planProjectWork(
 "first block\nsecond block\nthird block",
 ["security_analyst","verifier","researcher"],
 2
);
assert.equal(cappedRoles.length,2,"explicit fanout must cap the work plan");
assert.deepEqual(new Set(cappedRoles.map(item=>item.role_name)),new Set(["security_analyst","verifier"]));

const workerSource=await readFile(new URL("../src/index.js",import.meta.url),"utf8");
assert.match(workerSource,/node_project_work_count/,"distinct-host scheduler guard missing");
assert.match(workerSource,/own\.work_item_id != project_work_items\.work_item_id/,"atomic distinct-host assignment guard missing");
