import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeDistVersion, oauthClientJson, sha256, shaLine, verifyShasum, zipName } from '../scripts/build-package.js';

test('verifyShasum checks the listed hash', () => {
  const buf = Buffer.from('node zip');
  const text = `aaaa  node-v22.1.0-x64.msi\n${sha256(buf)}  node-v22.1.0-win-x64.zip\n`;
  assert.equal(verifyShasum(text, 'node-v22.1.0-win-x64.zip', buf), sha256(buf));
  assert.throws(() => verifyShasum(text, 'node-v22.1.0-win-x64.zip', Buffer.from('tampered')), /SHA-256 mismatch/);
  assert.throws(() => verifyShasum(text, 'node-v22.1.0-win-arm64.zip', buf), /not listed/);
});

test('oauth-client.json is built from the secrets, in Google desktop format', () => {
  const json = JSON.parse(oauthClientJson({ GOOGLE_OAUTH_CLIENT_ID: ' id.apps ', GOOGLE_OAUTH_CLIENT_SECRET: 'sec' }));
  assert.deepEqual(json, { installed: { client_id: 'id.apps', client_secret: 'sec' } });
  assert.throws(() => oauthClientJson({ GOOGLE_OAUTH_CLIENT_ID: 'x' }), /must be set/);
});

test('bundled Node must be 22.x', () => {
  assert.equal(nodeDistVersion({}, 'v22.23.5'), 'v22.23.5');
  assert.equal(nodeDistVersion({ NODE_DIST_VERSION: '22.12.0' }, 'v24.0.0'), 'v22.12.0');
  assert.throws(() => nodeDistVersion({}, 'v24.1.0'), /must be 22\.x/);
});

test('release file names', () => {
  assert.equal(zipName('1.2.0'), 'backup-manager-1.2.0-win-x64.zip');
  assert.equal(shaLine('ab', 'f.zip'), 'ab  f.zip\n');
});

test('Windows text files get CRLF line endings', async () => {
  const { toCrlf } = await import('../scripts/build-package.js');
  assert.equal(toCrlf('a\nb\r\nc\n'), 'a\r\nb\r\nc\r\n');
});
