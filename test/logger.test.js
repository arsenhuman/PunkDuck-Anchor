import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redact } from '../src/logger.js';

test('redacts secret-looking keys recursively', () => {
  const r = redact({ password: 'x', nested: { clientSecret: 'y', refresh_token: 'z', host: 'h' }, list: [{ apiKey: 'k' }] });
  assert.deepEqual(r, { password: '[REDACTED]', nested: { clientSecret: '[REDACTED]', refresh_token: '[REDACTED]', host: 'h' }, list: [{ apiKey: '[REDACTED]' }] });
});

test('writes JSON lines and scrubs tokens from messages', () => {
  const lines = [];
  const log = createLogger({ level: 'info', stream: { write: (s) => lines.push(s) } });
  log.debug('hidden');
  log.error('fail Bearer abc.def', { error: new Error('refresh_token=SECRET&x=1'), password: 'p' });
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.level, 'error');
  assert.equal(e.msg, 'fail Bearer [REDACTED]');
  assert.equal(e.password, '[REDACTED]');
  assert.equal(e.error.message, 'refresh_token=[REDACTED]&x=1');
  assert.ok(!lines[0].includes('SECRET'));
});
