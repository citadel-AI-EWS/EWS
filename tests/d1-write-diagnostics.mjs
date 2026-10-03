import assert from 'node:assert/strict';
import {collectWriteDiagnostics, summarizeWriteSources} from '../scripts/d1_write_diagnostics.mjs';

const row = (query, rowsWritten = 100) => ({dimensions: {query}, count: 50,
  sum: {rowsRead: 20, rowsWritten}});
const rows = [row('UPDATE node_ssh_state SET observed_at = CURRENT_TIMESTAMP'),
  row('INSERT OR IGNORE INTO node_request_nonces VALUES (?, ?)', 300),
  row("UPDATE private_customer_secret SET password = 'never-publish-this'", 20),
  row('DELETE FROM node_logs WHERE created_at < ?', 10), row('SELECT * FROM nodes', 0)];
const result = summarizeWriteSources(rows);
assert.equal(result[0].source, 'node_request_nonces');
assert.equal(result[1].source, 'node_ssh_state');
assert.equal(result[2].source, 'other');
assert.equal(result[3].source, 'node_logs');
assert.equal(result.length, 4);
assert.doesNotMatch(JSON.stringify(result), /password|never-publish-this|private_customer|UPDATE|SELECT/);
assert.throws(() => summarizeWriteSources(undefined), /invalid_write_insights_response/);
assert.throws(() => summarizeWriteSources([{...rows[0], sum: {rowsWritten: -1}}]), /invalid_write_insights_response/);
const calls = [];
const report = await collectWriteDiagnostics(async (path, options) => {
  assert.equal(path, 'graphql');
  assert.equal(options.method, 'POST');
  const body = JSON.parse(options.body);
  assert.match(body.query, /orderBy: \[sum_rowsWritten_DESC\]/);
  calls.push(body.variables);
  return {data: {viewer: {accounts: [{writes: rows}]}}};
}, {account: 'account', database: 'database', now: new Date('2026-10-03T07:01:06Z')});
assert.equal(calls[0].start, '2026-10-03T00:00:00.000Z');
assert.equal(calls[1].start, '2026-10-03T06:00:00.000Z');
assert.equal(calls[1].end, '2026-10-03T06:59:59.999Z');
assert.equal(report.windows[0].returned_rows_written, 430);
const failed = await collectWriteDiagnostics(async () => {throw Error('Bearer secret-token');},
  {account: 'account', database: 'database', now: new Date('2026-10-03T00:01:00Z')});
assert.equal(failed.windows[1].start, '2026-10-02T23:00:00.000Z');
assert.ok(failed.windows.every(window => window.status === 'unavailable'));
assert.doesNotMatch(JSON.stringify(failed), /secret-token|Bearer/);
console.log('D1 write attribution: UTC windows, source classification, unavailable data and redaction PASS');
