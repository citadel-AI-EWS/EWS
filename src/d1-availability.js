// Quota state is an optimization local to a Worker isolate. Durable task and
// result data stays in D1; no request is acknowledged from an in-memory queue.
const databases = new WeakMap();

export function dailyQuotaKind(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('daily row read limit')) return 'read';
  if (message.includes('daily row write limit')) return 'write';
  return null;
}

function resetAt(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function quotaFailure(kind, until, now = Date.now()) {
  return {
    ok: false,
    error: `controller_d1_daily_${kind}_limit_exceeded`,
    retry_after_seconds: Math.max(1, Math.ceil((until - now) / 1000)),
    retry_at: new Date(until).toISOString()
  };
}

export function d1QuotaResponse(error) {
  const kind = dailyQuotaKind(error);
  if (!kind) return null;
  const body = quotaFailure(kind, error.retryAt || resetAt(Date.now()));
  return Response.json(body, {status: 503, headers: {
    'cache-control': 'no-store',
    'retry-after': String(body.retry_after_seconds),
    'x-content-type-options': 'nosniff'
  }});
}

function quotaError(kind, until) {
  const error = new Error(`D1_ERROR: daily row ${kind} limit exceeded`);
  error.retryAt = until;
  return error;
}

export function withD1Availability(env, now = Date.now) {
  if (!env.DB) return env;
  let entry = databases.get(env.DB);
  if (!entry) {
    const original = env.DB;
    const statements = new WeakMap();
    entry = {readUntil: 0, writeUntil: 0, now};
    async function invoke(action, writes) {
      const current = now();
      if (entry.readUntil > current) throw quotaError('read', entry.readUntil);
      if (writes && entry.writeUntil > current) throw quotaError('write', entry.writeUntil);
      try {
        return await action();
      } catch (error) {
        const kind = dailyQuotaKind(error);
        if (kind) entry[kind + 'Until'] = resetAt(now());
        throw error;
      }
    }
    function wrapStatement(statement, writes) {
      const wrapped = new Proxy(statement, {get(target, key) {
        if (key === 'bind') return (...args) => wrapStatement(target.bind(...args), writes);
        if (['first', 'all', 'run', 'raw'].includes(key)) {
          return (...args) => invoke(() => target[key](...args), writes);
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
      statements.set(wrapped, {statement, writes});
      return wrapped;
    }
    entry.database = new Proxy(original, {get(target, key) {
      if (key === 'prepare') return sql => {
        // WITH/PRAGMA and unknown statements are treated conservatively as
        // writes. Ordinary SELECTs remain usable when only writes are blocked.
        const writes = !/^\s*(?:SELECT|EXPLAIN)\b/i.test(sql);
        return wrapStatement(target.prepare(sql), writes);
      };
      if (key === 'batch') return batch => {
        const metadata = batch.map(statement => statements.get(statement));
        return invoke(() => target.batch(batch.map((statement, i) =>
          metadata[i]?.statement || statement)), metadata.some(item => !item || item.writes));
      };
      if (key === 'exec') return (...args) => invoke(() => target.exec(...args), true);
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    databases.set(original, entry);
    databases.set(entry.database, entry);
  }
  return {...env, DB: entry.database};
}

export async function addD1RetryHint(response, env) {
  if (response.status !== 503) return response;
  const entry = databases.get(env.DB);
  if (!entry) return response;
  const now = entry.now();
  const kind = entry.readUntil > now ? 'read' : entry.writeUntil > now ? 'write' : null;
  if (!kind) return response;
  const hint = quotaFailure(kind, entry[kind + 'Until'], now);
  const headers = new Headers(response.headers);
  headers.set('retry-after', String(hint.retry_after_seconds));
  headers.set('cache-control', 'no-store');
  if (!headers.get('content-type')?.includes('application/json')) {
    return new Response(response.body, {status: response.status, headers});
  }
  const body = await response.clone().json();
  return Response.json({...body, retry_after_seconds: hint.retry_after_seconds,
    retry_at: hint.retry_at}, {status: response.status, headers});
}
