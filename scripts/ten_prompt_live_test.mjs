// Runs real controller assignments. No fabricated replies or simulated nodes.
import {readFile,writeFile} from 'node:fs/promises';
const scenarios=JSON.parse(await readFile(new URL('../tests/fixtures/acceptance-prompts.json',import.meta.url),'utf8'));
const base=new URL(process.env.CITADEL_BASE_URL||'https://citadel-ai.init1.workers.dev');
if(base.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(base.hostname))throw Error('HTTPS required');
const token=process.env.CITADEL_ARCHITECT_TOKEN;
const output=process.env.CITADEL_TEST_REPORT||'/tmp/citadel-ten-live-results.json';
const results={checked_at:new Date().toISOString(),test:'ten-real-prompts',live:true,results:[]};
async function api(path,body){
 const response=await fetch(new URL(path,base),{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{accept:'application/json','content-type':'application/json',authorization:'Bearer '+token},...(body?{body:JSON.stringify(body)}:{})});
 if(!response.ok)throw Error('HTTP_'+response.status);
 const data=await response.json();if(data.ok===false)throw Error(String(data.error||'api_error'));return data;
}
async function save(){await writeFile(output,JSON.stringify(results,null,2)+'\n',{mode:0o600});}
if(!token){
 results.blocker='CITADEL_ARCHITECT_TOKEN_not_available';
 results.results=scenarios.map(s=>({id:s.id,mode:s.mode,status:'blocked',reason:results.blocker}));
 await save();console.log('Live suite BLOCKED: authenticated Hub access is not configured. No jobs submitted.');process.exitCode=2;
}else{
 try{
  const fleet=await api('/api/v1/architect/machines');
  results.fleet=fleet.nodes?.map(n=>({node_id:n.node_id,status:n.status,agent_version:n.agent_version}));
  for(const s of scenarios){
   const entry={id:s.id,title:s.title,mode:s.mode,prompt:s.prompt,status:'submitting'};results.results.push(entry);await save();
   try{
    const created=await api('/api/v1/architect/projects',{source_type:s.mode==='python'?'architect_python':'architect_manual',title:'Acceptance: '+s.title,task_text:s.prompt});
    entry.project_id=created.project_id||created.project?.project_id;if(!entry.project_id)throw Error('missing_project_id');
    entry.status='pending';const deadline=Date.now()+10*60*1000;
    do{
     const d=await api('/api/v1/architect/projects/'+encodeURIComponent(entry.project_id));const p=d.project;
     entry.execution=p.execution;
     entry.nodes=[...new Set((p.work_items||[]).map(w=>w.node_id).filter(Boolean))];
     entry.work_items=(p.work_items||[]).map(w=>({node_id:w.node_id,role:w.role_name,status:w.status,result:w.result}));
     entry.answer=p.final_report?.combined_text||null;
     entry.status=p.execution?.state||p.status;
     await save();
     if(p.final_report?.ready||['failed','cancelled','completed_with_failures'].includes(entry.status))break;
     if(p.execution?.ready_workers_now===0 && !(p.work_items||[]).some(w=>w.node_id)){entry.status='blocked_no_ready_nodes';break;}
     await new Promise(resolve=>setTimeout(resolve,60000));
    }while(Date.now()<deadline);
    if(['planned','assigned','running','pending'].includes(entry.status))entry.status='timeout_work_may_continue';
   }catch(error){entry.status='failed';entry.error=error.message;}
   await save();
  }
 }catch(error){results.blocker=error.message;await save();process.exitCode=2;}
 console.log(JSON.stringify({test:results.test,count:results.results.length,statuses:results.results.map(r=>r.status),blocker:results.blocker||null}));
 if(results.results.some(r=>r.status!=='completed'))process.exitCode=2;
}
