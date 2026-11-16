import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.js';
import { silentLogger } from '../src/logger.js';

function capture() {
  let text = '';
  return { stdout: { write: (s) => { text += s; } }, get text() { return text; } };
}

test('help and unknown command', async () => {
  let c = capture();
  assert.equal(await main(['--help'], { stdout: c.stdout, logger: silentLogger }), 0);
  assert.match(c.text, /Usage: backup-manager/);
  c = capture();
  assert.equal(await main([], { stdout: c.stdout, logger: silentLogger }), 2);
  c = capture();
  assert.equal(await main(['--bogus'], { stdout: c.stdout, logger: silentLogger }), 2);
});

test('keygen prints a 32-byte base64 key', async () => {
  const c = capture();
  assert.equal(await main(['keygen'], { stdout: c.stdout, logger: silentLogger }), 0);
  assert.equal(Buffer.from(c.text.trim(), 'base64').length, 32);
});

test('missing config file is an error', async () => {
  await assert.rejects(main(['list', '-c', '/nonexistent/x.json'], { stdout: capture().stdout, logger: silentLogger }), /cannot read config/);
});
