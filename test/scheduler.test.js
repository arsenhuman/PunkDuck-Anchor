import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nonOverlapping, startScheduler } from '../src/scheduler.js';
import { silentLogger } from '../src/logger.js';

test('nonOverlapping skips while a run is in progress', async () => {
  let release;
  let runs = 0;
  const job = nonOverlapping(() => new Promise((r) => { runs++; release = r; }));
  const first = job();
  assert.deepEqual(await job(), { skipped: true });
  release('done');
  assert.equal(await first, 'done');
  const again = job();
  release('x');
  await again;
  assert.equal(runs, 2);
});

test('startScheduler validates cron, survives job errors, and stops cleanly', async () => {
  let tick;
  let stopped = false;
  const cronLib = {
    validate: (e) => e === '0 2 * * *',
    schedule: (expr, fn, opts) => { tick = fn; assert.equal(opts.timezone, 'UTC'); return { stop: () => { stopped = true; } }; },
  };
  assert.throws(() => startScheduler({ schedule: { cron: 'bad' }, job() {}, logger: silentLogger, cronLib }), /invalid cron/);
  const errors = [];
  const logger = { ...silentLogger, error: (m) => errors.push(m) };
  const s = startScheduler({ schedule: { cron: '0 2 * * *', timezone: 'UTC' }, job: async () => { throw new Error('boom'); }, logger, cronLib });
  await tick();
  assert.deepEqual(errors, ['scheduled run crashed']);
  await s.stop();
  assert.ok(stopped);
});
