// Read a bounded private snapshot when quota exhaustion blocks operational SQL.
// No database restoration, command insertion or production authority change.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const config=fs.readFileSync('wrangler.jsonc','utf8');
const account=config.match(/"D1_ANALYTICS_ACCOUNT_ID"\s*:\s*"([^"]+)"/)?.[1];
const database=config.match(/"D1_ANALYTICS_DATABASE_ID"\s*:\s*"([^"]+)"/)?.[1];
const tables=['commands','nodes','node_logs','ssh_console_results','audit_events'];
async function main() {
  if(Date.now()>=Date.parse('2026-10-10T20:00:00Z')){console.log('{"status":"snapshot_lease_expired"}');return;}
  let bookmark,completed;
  const deadline=Date.now()+90000;
  do {
    const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/export`,{
      method:'POST',headers:{authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},
      body:JSON.stringify({output_format:'polling',dump_options:{tables},...(bookmark?{current_bookmark:bookmark}:{})}),
      redirect:'error',signal:AbortSignal.timeout(15000)});
    const body=await response.json();
    if(!response.ok||!body.success||body.result?.status==='error') {
      const message=JSON.stringify([body.errors,body.result?.error]);
      console.log(JSON.stringify({test:'physical-failure-snapshot',status:'export_unavailable',http_status:response.status,
        reason:/daily.{0,80}read|read.{0,80}daily/i.test(message)?'d1_daily_read_limit':
          /daily.{0,80}writ|writ.{0,80}daily/i.test(message)?'d1_daily_write_limit':'database_export_unavailable'}));
      process.exitCode=2;return;
    }
    if(body.result?.status==='complete'){completed=body.result.result?.signed_url;break;}
    bookmark=body.result?.at_bookmark;
    if(!bookmark)throw Error('export_bookmark_missing');
    await new Promise(resolve=>setTimeout(resolve,3000));
  }while(Date.now()<deadline);
  if(!completed)throw Error('export_deadline');
  const url=new URL(completed);
  if(url.protocol!=='https:'||url.username||url.password)throw Error('export_download_invalid');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('export_download_failed');
  const chunks=[];let length=0;
  for await(const chunk of response.body){length+=chunk.length;if(length>64*1024*1024)throw Error('snapshot_too_large');chunks.push(chunk);}
  const child=spawn('python3',['scripts/physical_failure_snapshot.py'],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH}});
  let output='';child.stdout.setEncoding('utf8').on('data',value=>{output+=value;if(output.length>16000)child.kill();});
  child.stderr.resume();const timer=setTimeout(()=>child.kill(),20000);
  const ended=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  child.stdin.on('error',()=>{});child.stdin.end(Buffer.concat(chunks));
  const code=await ended;clearTimeout(timer);
  if(code!==0)throw Error('snapshot_classification_failed');
  for(const line of output.trim().split('\n')){
    const parsed=JSON.parse(line);if(parsed.test!=='physical-failure-snapshot')throw Error('snapshot_output_invalid');
    console.log(JSON.stringify(parsed));
  }
}
main().catch(()=>{console.log('{"status":"snapshot_export_unavailable"}');process.exitCode=2;});
