import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { buildSummary, sendHeartbeat } from '../src/heartbeat.js';
import { baseRawConfig, ENV } from './helpers.js';

const URL_ = 'https://hc-ping.com/0f3e4b2a-1111-2222-3333-444455556666';
const okResults = [
  { server: 'prod', db: 'Sales', ok: true, name: 'Sales_20261116T020000Z.bak.gz', bytes: 1536 },
  { server: 'prod', db: 'HR', ok: true, name: 'HR_20261116T020100Z.bak.gz', bytes: 10, retentionError: 'x' },
];

function recorder({ logs = [] } = {}) {
  const mk = (level) => (msg, fields) => logs.push({ level, msg, fields });
  return { logs, logger: { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') } };
}

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { ok: r >= 200 && r < 300, status: r };
  };
  fn.calls = calls;
  return fn;
}

test('disabled when no URL configured: nothing sent', async () => {
  const fetchImpl = fakeFetch([200]);
  const { logger } = recorder();
  assert.deepEqual(await sendHeartbeat({ url: undefined, results: okResults, failed: 0, logger, fetchImpl }), { sent: false, reason: 'disabled' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('pings once on full success with a plain-text summary', async () => {
  const fetchImpl = fakeFetch([200]);
  const { logger, logs } = recorder();
  assert.deepEqual(await sendHeartbeat({ url: URL_, results: okResults, failed: 0, logger, fetchImpl }), { sent: true });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, URL_);
  assert.equal(opts.method, 'POST');
  assert.match(opts.headers['Content-Type'], /^text\/plain/);
  assert.ok(opts.signal, 'request has a timeout signal');
  assert.match(opts.body, /^2\/2 OK\n/);
  assert.match(opts.body, /prod\/Sales {2}Sales_20261116T020000Z\.bak\.gz {2}1\.5 KiB/);
  assert.match(opts.body, /retention failed/);
  // the UUID (effectively a secret) is never logged
  assert.ok(!JSON.stringify(logs).includes('0f3e4b2a'));
});

test('no ping when any database failed', async () => {
  const fetchImpl = fakeFetch([200]);
  const { logger, logs } = recorder();
  const results = [...okResults, { server: 'prod', db: 'X', ok: false, error: 'boom' }];
  assert.deepEqual(await sendHeartbeat({ url: URL_, results, failed: 1, logger, fetchImpl }), { sent: false, reason: 'failures' });
  assert.equal(fetchImpl.calls.length, 0);
  assert.ok(logs.some((l) => l.level === 'warn'));
});

test('no ping when nothing ran', async () => {
  const fetchImpl = fakeFetch([200]);
  assert.deepEqual(await sendHeartbeat({ url: URL_, results: [], failed: 0, logger: recorder().logger, fetchImpl }), { sent: false, reason: 'empty' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('retries on network errors / 5xx / 429, then succeeds', async () => {
  const fetchImpl = fakeFetch([new TypeError('fetch failed'), 503, 200]);
  const r = await sendHeartbeat({ url: URL_, results: okResults, failed: 0, logger: recorder().logger, fetchImpl, retryDelayMs: 1 });
  assert.deepEqual(r, { sent: true });
  assert.equal(fetchImpl.calls.length, 3);
  const f429 = fakeFetch([429, 200]);
  assert.equal((await sendHeartbeat({ url: URL_, results: okResults, failed: 0, logger: recorder().logger, fetchImpl: f429, retryDelayMs: 1 })).sent, true);
});

test('gives up after N attempts without throwing', async () => {
  const fetchImpl = fakeFetch([new Error('ECONNRESET')]);
  const { logger, logs } = recorder();
  const r = await sendHeartbeat({ url: URL_, results: okResults, failed: 0, logger, fetchImpl, attempts: 3, retryDelayMs: 1 });
  assert.deepEqual(r, { sent: false, reason: 'unreachable' });
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(logs.at(-1).msg.includes('backups themselves are unaffected'));
});

test('timeouts are retried and reported as timeout', async () => {
  const fetchImpl = fakeFetch([Object.assign(new Error('t'), { name: 'TimeoutError' })]);
  const { logger, logs } = recorder();
  await sendHeartbeat({ url: URL_, results: okResults, failed: 0, logger, fetchImpl, attempts: 2, retryDelayMs: 1 });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(logs.find((l) => l.msg === 'heartbeat attempt failed').fields.error, 'timeout');
});

test('4xx (e.g. unknown check UUID) is not retried', async () => {
  const fetchImpl = fakeFetch([404]);
  const r = await sendHeartbeat({ url: URL_, results: okResults, failed: 0, logger: recorder().logger, fetchImpl, retryDelayMs: 1 });
  assert.deepEqual(r, { sent: false, reason: 'http 404' });
  assert.equal(fetchImpl.calls.length, 1);
});

test('summary is truncated for very large runs', () => {
  const many = Array.from({ length: 2000 }, (_, i) => ({ server: 's', db: `db${i}`, ok: true, name: `db${i}_x.bak.gz`, bytes: 1 }));
  const s = buildSummary(many);
  assert.ok(s.length <= 10_000);
  assert.match(s, /^2000\/2000 OK/);
  assert.match(s, /truncated\)$/);
});

test('config: monitoring is optional, validated, and supports env refs', () => {
  assert.equal(normalizeConfig(baseRawConfig(), { env: ENV }).monitoring.heartbeatUrl, undefined);
  const c = normalizeConfig(baseRawConfig({ monitoring: { heartbeatUrl: 'env:HC' } }), { env: { ...ENV, HC: URL_ } });
  assert.equal(c.monitoring.heartbeatUrl, URL_);
  assert.equal(normalizeConfig(baseRawConfig({ monitoring: { heartbeatUrl: '' } }), { env: ENV }).monitoring.heartbeatUrl, undefined);
  for (const bad of ['http://hc-ping.com/x', 'not a url', 42]) {
    assert.throws(() => normalizeConfig(baseRawConfig({ monitoring: { heartbeatUrl: bad } }), { env: ENV }), /https:\/\/ URL/);
  }
  assert.throws(() => normalizeConfig(baseRawConfig({ monitoring: 'x' }), { env: ENV }), /monitoring must be an object/);
  assert.throws(
    () => normalizeConfig(baseRawConfig({ monitoring: { heartbeatUrl: 'https://hc-ping.com/REPLACE-WITH-YOUR-CHECK-UUID' } }), { env: ENV }),
    /still the example placeholder/,
  );
});

test('config: env ref to an unset variable is a loud error, not silently disabled', () => {
  assert.throws(
    () => normalizeConfig(baseRawConfig({ monitoring: { heartbeatUrl: 'env:HC_MISSING' } }), { env: ENV }),
    /HC_MISSING is not set/,
  );
});

test('response body is released after a successful ping', async () => {
  let cancelled = false;
  const fetchImpl = async () => ({ ok: true, status: 200, body: { cancel: async () => { cancelled = true; } } });
  await sendHeartbeat({ url: URL_, results: okResults, failed: 0, logger: recorder().logger, fetchImpl });
  assert.ok(cancelled);
});
