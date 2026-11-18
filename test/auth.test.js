import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { browserCommand, getAuthorizedClient, logout, openBrowser, readToken, startLoopbackServer, writeToken } from '../src/auth.js';
import { tmpDir } from './helpers.js';

test('token file is written atomically with 0600 permissions', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'nested', 'token.json');
  await writeToken(file, { refresh_token: 'r', email: 'a@gmail.com' });
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600); // Windows: ACLs set by install.ps1
  assert.deepEqual(await readToken(file), { refresh_token: 'r', email: 'a@gmail.com' });
  assert.equal(await readToken(path.join(dir, 'none.json')), null);
});

test('getAuthorizedClient requires login', async () => {
  const dir = await tmpDir();
  await assert.rejects(getAuthorizedClient({ clientId: 'c', clientSecret: 's', tokenFile: path.join(dir, 't.json') }), /auth login/);
});

test('logout removes the token even if revoke fails', async () => {
  const dir = await tmpDir();
  const tokenFile = path.join(dir, 't.json');
  await writeToken(tokenFile, { refresh_token: 'r' });
  const google = { clientId: 'c', clientSecret: 's', tokenFile };
  // revoke will fail (fake token / possibly no network) — must still remove locally
  const r = await logout(google);
  assert.equal(r.removed, true);
  assert.equal(await readToken(tokenFile), null);
  assert.deepEqual(await logout(google), { removed: false });
});

test('loopback server returns the code on matching state', async () => {
  const { redirectUri, code } = await startLoopbackServer({ expectedState: 'abc' });
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+$/);
  const res = await fetch(`${redirectUri}/?state=abc&code=the-code`);
  assert.equal(res.status, 200);
  assert.equal(await code, 'the-code');
});

test('loopback server rejects a wrong state (CSRF)', async () => {
  const { redirectUri, code } = await startLoopbackServer({ expectedState: 'abc' });
  const rejected = assert.rejects(code, /state mismatch/);
  const res = await fetch(`${redirectUri}/?state=evil&code=x`);
  assert.equal(res.status, 400);
  await rejected;
});

test('loopback server reports user denial and timeout', async () => {
  let s = await startLoopbackServer({ expectedState: 'abc' });
  const denied = assert.rejects(s.code, /access_denied/);
  await fetch(`${s.redirectUri}/?state=abc&error=access_denied`);
  await denied;
  s = await startLoopbackServer({ expectedState: 'abc', timeoutMs: 20 });
  await assert.rejects(s.code, /timed out/);
});

test('pasted redirect URL: state is verified, code extracted', async () => {
  const { parsePastedRedirect } = await import('../src/auth.js');
  assert.equal(parsePastedRedirect('http://127.0.0.1:51234/?state=abc&code=4%2F0AXyz&scope=x', 'abc'), '4/0AXyz');
  assert.equal(parsePastedRedirect('  "http://127.0.0.1:1/?code=c1&state=abc"  ', 'abc'), 'c1');
  assert.equal(parsePastedRedirect('?state=abc&code=c2', 'abc'), 'c2');
  assert.throws(() => parsePastedRedirect('http://127.0.0.1:1/?state=evil&code=c', 'abc'), /state mismatch/);
  assert.throws(() => parsePastedRedirect('http://127.0.0.1:1/?code=c', 'abc'), /state mismatch/);
  assert.throws(() => parsePastedRedirect('http://127.0.0.1:1/?state=abc&error=access_denied', 'abc'), /access_denied/);
  assert.throws(() => parsePastedRedirect('http://127.0.0.1:1/?state=abc', 'abc'), /no code/);
});

test('pasted bare code is accepted (PKCE still binds it to this login)', async () => {
  const { parsePastedRedirect } = await import('../src/auth.js');
  assert.equal(parsePastedRedirect('4/0AXyz-_.~', 'abc'), '4/0AXyz-_.~');
  assert.equal(parsePastedRedirect('4%2F0AX', 'abc'), '4/0AX');
  assert.throws(() => parsePastedRedirect('', 'abc'), /nothing was pasted/);
  assert.throws(() => parsePastedRedirect('not a code', 'abc'), /neither a URL nor/);
});

test('waitForPastedCode retries on junk, aborts on state mismatch', async () => {
  const { PassThrough } = await import('node:stream');
  const { waitForPastedCode } = await import('../src/auth.js');
  let input = new PassThrough();
  const invalid = [];
  let w = waitForPastedCode({ input, expectedState: 'abc', onInvalid: (e) => invalid.push(e.message) });
  input.write('hello world\n\nhttp://127.0.0.1:9/?state=abc&code=good\n');
  assert.equal(await w.code, 'good');
  assert.equal(invalid.length, 1);
  input = new PassThrough();
  w = waitForPastedCode({ input, expectedState: 'abc' });
  input.write('http://127.0.0.1:9/?state=zzz&code=bad\n');
  await assert.rejects(w.code, /state mismatch/);
});

test('loopback server can be closed early', async () => {
  const s = await startLoopbackServer({ expectedState: 'abc' });
  s.close();
  await assert.rejects(fetch(`${s.redirectUri}/?state=abc&code=x`));
});

test('browserCommand opens the URL without a shell on every platform', () => {
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?a=1&b=2';
  assert.deepEqual(browserCommand(url, 'win32'), { cmd: 'explorer.exe', args: [url] });
  assert.deepEqual(browserCommand(url, 'darwin'), { cmd: 'open', args: [url] });
  assert.deepEqual(browserCommand(url, 'linux'), { cmd: 'xdg-open', args: [url] });
});

test('openBrowser spawns detached and never throws', () => {
  const calls = [];
  const child = { on: (ev, fn) => calls.push(['on', ev, typeof fn]), unref: () => calls.push(['unref']) };
  const ok = openBrowser('https://x/?a=1&b=2', { platform: 'win32', spawnFn: (cmd, args, o) => { calls.push([cmd, args, o.detached, o.stdio]); return child; } });
  assert.equal(ok, true);
  assert.deepEqual(calls, [['explorer.exe', ['https://x/?a=1&b=2'], true, 'ignore'], ['on', 'error', 'function'], ['unref']]);
  assert.equal(openBrowser('https://x', { spawnFn: () => { throw new Error('ENOENT'); } }), false);
});
