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

test('appends to a daily log file in logDir and to the stream', async () => {
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const { tmpDir } = await import('./helpers.js');
  const { logFileFor } = await import('../src/logger.js');
  const dir = path.join(await tmpDir(), 'logs');
  const lines = [];
  const when = new Date(2026, 10, 17, 2, 0, 0);
  const log = createLogger({ level: 'info', stream: { write: (s) => lines.push(s) }, logDir: dir, now: () => when });
  log.info('one', { password: 'p' });
  log.warn('two');
  const file = logFileFor(dir, when);
  assert.equal(path.basename(file), 'backup-2026-11-17.log');
  const content = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(content.map((e) => e.msg), ['one', 'two']);
  assert.equal(content[0].password, '[REDACTED]');
  assert.equal(lines.length, 2);
});

test('falls back to the stream when the log folder is unusable', async () => {
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const { tmpDir } = await import('./helpers.js');
  const blocker = path.join(await tmpDir(), 'file');
  fs.writeFileSync(blocker, 'x');
  const lines = [];
  const log = createLogger({ stream: { write: (s) => lines.push(s) }, logDir: path.join(blocker, 'logs') });
  log.info('still logged');
  assert.match(lines[0], /cannot create log folder/);
  assert.match(lines[1], /still logged/);
});

test('cleanupLogs deletes only backup logs older than 30 days', async () => {
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const { tmpDir } = await import('./helpers.js');
  const { cleanupLogs } = await import('../src/logger.js');
  const dir = await tmpDir();
  for (const n of ['backup-2026-10-17.log', 'backup-2026-10-18.log', 'backup-2026-11-17.log', 'backup-2025-01-01.log', 'other.log', 'backup-2020-01-01.txt']) {
    fs.writeFileSync(path.join(dir, n), '');
  }
  const deleted = cleanupLogs(dir, { keepDays: 30, now: new Date(2026, 10, 17, 2, 0) });
  assert.deepEqual(deleted.sort(), ['backup-2025-01-01.log', 'backup-2026-10-17.log']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['backup-2020-01-01.txt', 'backup-2026-10-18.log', 'backup-2026-11-17.log', 'other.log']);
  assert.deepEqual(cleanupLogs(path.join(dir, 'missing')), []);
});

test('logged SQL errors include the preceding server messages, still redacted', () => {
  const lines = [];
  const log = createLogger({ stream: { write: (l) => lines.push(l) } });
  const e262 = Object.assign(new Error("CREATE DATABASE permission denied in database 'master'. Bearer abc.def"), { number: 262 });
  const err = Object.assign(new Error('VERIFY DATABASE is terminating abnormally.'), { number: 3013, precedingErrors: [e262] });
  log.error('backup failed', { error: err });
  const { error } = JSON.parse(lines[0]);
  assert.match(error.message, /^Msg 262: CREATE DATABASE permission denied .* \| Msg 3013: VERIFY DATABASE/);
  assert.match(error.message, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(error.message, /abc\.def/);
});
