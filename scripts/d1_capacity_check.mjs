import fs from 'node:fs';
const config = fs.readFileSync('wrangler.jsonc', 'utf8');
const account = config.match(/"D1_ANALYTICS_ACCOUNT_ID"\s*:\s*"([a-f0-9]+)"/i)?.[1];
const worker = config.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/tails`;
const report = { scheduled_events: 0, guardian_errors: [], tail_status: 'starting' };
async function cf(method, url, body) {
  const r = await fetch(url, {method, headers: {authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN,
    'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(15000)});
  if (!r.ok) throw Error('tail_http_' + r.status);
  const value = await r.json();
  if (!value.success) throw Error('tail_api_error');
  return value.result;
}
let tail;
try {
  tail = await cf('POST', base, {sampling_rate: 1});
  report.tail_status = 'connected';
  await new Promise((resolve) => {
    const ws = new WebSocket(tail.url, 'trace-v1');
    let timer;
    function done() { clearTimeout(timer); ws.close(); resolve(); }
    timer = setTimeout(done, 300000 - Date.now() % 300000 + 60000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({debug: false})));
    ws.addEventListener('error', () => { report.tail_status = 'connection_failed'; done(); });
    ws.addEventListener('close', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('message', async (event) => {
      try {
        const raw = event.data instanceof Blob ? await event.data.text() : String(event.data);
        const value = JSON.parse(raw);
        if (!value.event?.cron) return;
        report.scheduled_events += 1;
        report.cron = value.event.cron;
        const messages = [...(value.logs || []).map(log => JSON.stringify(log.message)),
          ...(value.exceptions || []).map(error => String(error.message))];
        for (const message of messages) {
          if (!/D1|Guardian/i.test(message)) continue;
          const code = /write.*(?:quota|limit|exceed)/i.test(message) ? 'd1_write_quota_exceeded'
            : /read.*(?:quota|limit|exceed)/i.test(message) ? 'd1_read_quota_exceeded'
            : /no such (?:table|column)/i.test(message) ? 'missing_database_schema'
            : /failed|error/i.test(message) ? 'guardian_runtime_error' : null;
          if (code && !report.guardian_errors.includes(code)) report.guardian_errors.push(code);
        }
        if (value.event.cron === '*/5 * * * *') done();
      } catch { report.tail_status = 'invalid_tail_event'; }
    });
  });
} catch (error) { report.tail_status = /^tail_(?:http_\d+|api_error)$/.test(error.message) ? error.message : 'tail_unavailable'; }
finally { if (tail?.id) { try { await cf('DELETE', base + '/' + tail.id); } catch { report.tail_cleanup_failed = true; } } }
try {
  const r = await fetch('https://citadel-ai.init1.workers.dev/api/v1/status/d1-retention', {signal: AbortSignal.timeout(15000)});
  report.retention = r.ok ? await r.json() : {status: 'unavailable'};
} catch { report.retention = {status: 'unavailable'}; }
console.log(JSON.stringify(report));
const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/check-runs`, {
  method: 'POST', headers: {authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
    'content-type': 'application/json', accept: 'application/vnd.github+json'},
  body: JSON.stringify({name: 'D1 Guardian inspection', head_sha: process.env.GITHUB_SHA,
    status: 'completed', conclusion: 'neutral', output: {title: 'Guardian runtime inspection',
      summary: '```json\n' + JSON.stringify(report, null, 2) + '\n```'}}), signal: AbortSignal.timeout(15000)
});
if (!r.ok) throw Error('inspection_publish_http_' + r.status);
