import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAuthorizedClient, logout, readToken, startLoopbackServer, writeToken } from '../src/auth.js';
import { tmpDir } from './helpers.js';

test('token file is written atomically with 0600 permissions', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'nested', 'token.json');
  await writeToken(file, { refresh_token: 'r', email: 'a@gmail.com' });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
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
