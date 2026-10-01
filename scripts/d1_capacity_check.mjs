import fs from 'node:fs';
import {spawn} from 'node:child_process';
const config = fs.readFileSync('wrangler.jsonc', 'utf8');
const account = config.match(/"D1_ANALYTICS_ACCOUNT_ID"\s*:\s*"([a-f0-9]+)"/i)?.[1];
const worker = config.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
const report = {scheduled_events: 0, guardian_errors: [], tail_status: 'starting'};
fs.writeFileSync('/tmp/d1-guardian-tail.json', JSON.stringify({name: worker, account_id: account, compatibility_date: '2026-09-05'}));
await new Promise(resolve => {
  const child = spawn('./node_modules/.bin/wrangler', ['tail', worker, '--config', '/tmp/d1-guardian-tail.json', '--format', 'json', '--search', 'D1 Guardian'],
    {env: {...process.env, CLOUDFLARE_ACCOUNT_ID: account, WRANGLER_SEND_METRICS: 'false'}, stdio: ['ignore', 'pipe', 'pipe']});
  let buffer = '';
  let stopping = false;
  const timer = setTimeout(stop, 300000 - Date.now() % 300000 + 60000);
  function stop() { if (stopping) return; stopping = true; clearTimeout(timer); child.kill('SIGINT'); }
  function read(chunk) {
    // Never forward raw trace output: it can contain HTTP headers and metadata.
    buffer = (buffer + chunk.toString()).slice(-100000);
    if (/Connected to/.test(buffer)) report.tail_status = 'connected';
    const apiCode = buffer.match(/\[code:\s*(\d+)\]/);
    if (apiCode) report.api_error_code = Number(apiCode[1]);
    if (/"cron"\s*:\s*"\*\/5 \* \* \* \*"/.test(buffer)) report.scheduled_events = 1;
    for (const [pattern, code] of [
      [/writ(?:e|ten).*?(?:quota|limit|exceed)/is, 'd1_write_quota_exceeded'],
      [/read.*?(?:quota|limit|exceed)/is, 'd1_read_quota_exceeded'],
      [/no such (?:table|column)/i, 'missing_database_schema'],
      [/D1 Guardian scheduled maintenance failed/i, 'guardian_runtime_error']
    ]) {
      if (pattern.test(buffer) && !report.guardian_errors.includes(code)) report.guardian_errors.push(code);
    }
    if (report.scheduled_events || report.guardian_errors.includes('d1_write_quota_exceeded')) setTimeout(stop, 1000);
  }
  child.stdout.on('data', read); child.stderr.on('data', read);
  child.on('error', () => { report.tail_status = 'tail_unavailable'; clearTimeout(timer); resolve(); });
  child.on('close', code => { report.exit_code = code; clearTimeout(timer); resolve(); });
});
try {
  const r = await fetch('https://citadel-ai.init1.workers.dev/api/v1/status/d1-retention', {signal: AbortSignal.timeout(15000)});
  report.retention = r.ok ? await r.json() : {status:'unavailable'};
} catch { report.retention = {status:'unavailable'}; }
console.log(JSON.stringify(report));
const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/check-runs`, {
  method:'POST', headers:{authorization:'Bearer '+process.env.GITHUB_TOKEN,'content-type':'application/json',accept:'application/vnd.github+json'},
  body:JSON.stringify({name:'D1 Guardian inspection',head_sha:process.env.GITHUB_SHA,status:'completed',conclusion:'neutral',
    output:{title:'Guardian runtime inspection',summary:'```json\n'+JSON.stringify(report,null,2)+'\n```'}}),signal:AbortSignal.timeout(15000)
});
if (!r.ok) throw Error('inspection_publish_http_'+r.status);
