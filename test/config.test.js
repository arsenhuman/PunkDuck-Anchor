import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, loadConfig, normalizeConfig, parseEncryptionKey, resolveEnvRefs } from '../src/config.js';
import { baseRawConfig, ENV, tmpDir } from './helpers.js';

test('applies defaults and resolves env refs', () => {
  const c = normalizeConfig(baseRawConfig(), { env: ENV });
  assert.equal(c.google.clientSecret, 's3cret');
  assert.equal(c.servers[0].password, 'pw');
  assert.equal(c.servers[0].port, 1433);
  assert.equal(c.servers[0].encrypt, true);
  assert.equal(c.servers[0].localBackupDir, path.resolve('/var/opt/mssql/backup'));
  assert.equal(c.drive.rootFolder, 'MSSQL Backups');
  assert.equal(c.compression, true);
  assert.equal(c.encryption.enabled, false);
  assert.equal('schedule' in c, false);
});

test('missing env var is a clear error', () => {
  assert.throws(() => normalizeConfig(baseRawConfig(), { env: { GSECRET: 'x' } }), /environment variable PW is not set/);
});

test('resolveEnvRefs leaves plain strings alone', () => {
  assert.deepEqual(resolveEnvRefs({ a: 'x', b: ['env:Y'] }, { Y: 'y' }), { a: 'x', b: ['y'] });
});

for (const [label, mutate, msg] of [
  ['no servers', (c) => { c.servers = []; }, /servers must be a non-empty array/],
  ['bad server name', (c) => { c.servers[0].name = 'a/b'; }, /name must match/],
  ['duplicate server', (c) => { c.servers.push({ ...c.servers[0] }); }, /duplicated/],
  ['db with bracket', (c) => { c.servers[0].databases = ['x]y']; }, /invalid database name/],
  ['duplicate db', (c) => { c.servers[0].databases = ['a', 'a']; }, /duplicates/],
  ['bad port', (c) => { c.servers[0].port = 70000; }, /valid TCP port/],
  ['bad keepLast', (c) => { c.retention = { keepLast: 0 }; }, /keepLast/],
  ['bad root folder', (c) => { c.drive = { rootFolder: 'a/b' }; }, /rootFolder/],
  ['no clientId', (c) => { delete c.google.clientId; }, /clientId/],
]) {
  test(`rejects: ${label}`, () => {
    const raw = baseRawConfig();
    mutate(raw);
    assert.throws(() => normalizeConfig(raw, { env: ENV }), (e) => e instanceof ConfigError && msg.test(e.message));
  });
}

test('encryption requires a 32-byte key', () => {
  const raw = baseRawConfig({ encryption: { enabled: true } });
  assert.throws(() => normalizeConfig(raw, { env: ENV }), /BACKUP_ENCRYPTION_KEY is not set/);
  const key = Buffer.alloc(32, 7);
  const c = normalizeConfig(raw, { env: { ...ENV, BACKUP_ENCRYPTION_KEY: key.toString('base64') } });
  assert.deepEqual(c.encryption.key, key);
  assert.deepEqual(parseEncryptionKey(key.toString('hex')), key);
  assert.throws(() => parseEncryptionKey('c2hvcnQ='), /32-byte/);
});

test('loadConfig reports unreadable and invalid files', async () => {
  const dir = await tmpDir();
  await assert.rejects(loadConfig(path.join(dir, 'missing.json')), /cannot read config file/);
  const bad = path.join(dir, 'bad.json');
  await fs.writeFile(bad, '{nope');
  await assert.rejects(loadConfig(bad), /not valid JSON/);
  const good = path.join(dir, 'good.json');
  await fs.writeFile(good, JSON.stringify(baseRawConfig()));
  const c = await loadConfig(good, { env: ENV });
  assert.equal(c.servers[0].name, 'prod');
});
