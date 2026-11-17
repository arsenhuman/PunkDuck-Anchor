import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadBackup, listBackups, runBackups, selectTargets } from '../src/backup.js';
import { normalizeConfig } from '../src/config.js';
import { DriveStore } from '../src/drive.js';
import { silentLogger } from '../src/logger.js';
import { createFakeDriveApi } from './fake-drive.js';
import { ENV, tmpDir } from './helpers.js';

const KEY = crypto.randomBytes(32);

async function setup({ encryption = false, compression = true, retention, servers } = {}) {
  const dir = await tmpDir();
  const backupDir = path.join(dir, 'sqlbackup');
  await fs.mkdir(backupDir);
  const raw = {
    google: { clientId: 'c', clientSecret: 's' },
    workDir: path.join(dir, 'work'),
    compression,
    encryption: { enabled: encryption },
    retention,
    servers: servers ?? [
      { name: 'prod', host: 'h', user: 'u', password: 'p', databases: ['Sales', 'HR', 'Broken'], backupDir },
      { name: 'down', host: 'h2', user: 'u', password: 'p', databases: ['X'], backupDir },
    ],
  };
  const config = normalizeConfig(raw, { env: { ...ENV, BACKUP_ENCRYPTION_KEY: KEY.toString('base64') } });
  const api = createFakeDriveApi();
  const drive = new DriveStore({ request: api.request, retryDelayMs: 1 });
  const contents = new Map();
  const sqlCalls = [];
  const createSqlClient = (server) => ({
    async connect() {
      if (server.name === 'down') throw new Error('ECONNREFUSED');
    },
    async close() { sqlCalls.push(['close', server.name]); },
    async assertDatabaseOnline(db) {
      sqlCalls.push(['online', db]);
      if (db === 'Broken') throw new Error('database "Broken" is OFFLINE, not ONLINE');
    },
    async backup(db, serverPath) {
      sqlCalls.push(['backup', db, serverPath]);
      const data = crypto.randomBytes(5000);
      contents.set(db, data);
      await fs.writeFile(serverPath, data); // "SQL Server" writes to the shared dir
    },
    async verify(serverPath) { sqlCalls.push(['verify', serverPath]); },
  });
  return { dir, config, api, drive, createSqlClient, contents, sqlCalls, backupDir };
}

test('selectTargets filters and errors on no match', async () => {
  const { config } = await setup();
  assert.equal(selectTargets(config).length, 4);
  assert.deepEqual(selectTargets(config, { db: 'HR' }).map((t) => t.server.name), ['prod']);
  assert.throws(() => selectTargets(config, { db: 'nope' }), /no configured database matches database "nope"/);
});

test('partial failure: other databases still back up; local files cleaned', async () => {
  const s = await setup({ encryption: true });
  const { results, failed } = await runBackups({ ...s, logger: silentLogger });
  assert.equal(failed, 2);
  const byDb = Object.fromEntries(results.map((r) => [r.db, r]));
  assert.equal(byDb.Sales.ok, true);
  assert.equal(byDb.HR.ok, true);
  assert.match(byDb.Broken.error, /OFFLINE/);
  assert.match(byDb.X.error, /connect failed: ECONNREFUSED/);
  assert.match(byDb.Sales.name, /^Sales_\d{8}T\d{6}Z\.bak\.gz\.enc$/);

  // backup -> verify order, and connection closed
  const salesOps = s.sqlCalls.filter((c) => c[1] === 'Sales' || (c[0] === 'verify' && c[1].includes('Sales')));
  assert.deepEqual(salesOps.map((c) => c[0]), ['online', 'backup', 'verify']);
  assert.ok(s.sqlCalls.some((c) => c[0] === 'close' && c[1] === 'prod'));

  assert.deepEqual(await fs.readdir(s.backupDir), [], '.bak files removed');
  assert.deepEqual(await fs.readdir(s.config.workDir), [], 'packed artifacts removed');

  // stored in Root/server/db with checksum metadata
  const listed = await listBackups({ config: s.config, drive: s.drive });
  assert.deepEqual(listed.map((b) => `${b.server}/${b.db}`).sort(), ['prod/HR', 'prod/Sales']);
  const f = s.api.files.get(byDb.Sales.fileId);
  assert.equal(f.appProperties.encrypted, '1');
  assert.equal(f.appProperties.sha256, crypto.createHash('sha256').update(f.data).digest('hex'));
});

test('round trip: backup then download restores identical .bak', async () => {
  for (const [compression, encryption] of [[true, true], [false, false], [true, false]]) {
    const s = await setup({ compression, encryption });
    await runBackups({ ...s, logger: silentLogger, filter: { db: 'Sales' } });
    const out = path.join(s.dir, 'restore');
    const r = await downloadBackup({ config: s.config, drive: s.drive, logger: silentLogger, latest: true, filter: { db: 'Sales' }, outDir: out });
    assert.ok(s.contents.get('Sales').equals(await fs.readFile(r.dest)), `compression=${compression} encryption=${encryption}`);
    assert.match(path.basename(r.dest), /^Sales_.*\.bak$/);
    assert.deepEqual((await fs.readdir(out)).length, 1, 'no temp files left');
  }
});

test('download detects checksum mismatch and refuses foreign files', async () => {
  const s = await setup();
  const { results } = await runBackups({ ...s, logger: silentLogger, filter: { db: 'HR' } });
  const f = s.api.files.get(results[0].fileId);
  f.data = Buffer.concat([f.data, Buffer.from('x')]);
  await assert.rejects(downloadBackup({ config: s.config, drive: s.drive, logger: silentLogger, fileId: f.id, outDir: s.dir }), /checksum mismatch/);
  const other = s.api.add({ name: 'x', mimeType: 'text/plain', parents: ['root'] }, Buffer.from('x'));
  await assert.rejects(downloadBackup({ config: s.config, drive: s.drive, logger: silentLogger, fileId: other.id }), /not a backup-manager backup/);
});

test('download of encrypted backup without key fails clearly', async () => {
  const s = await setup({ encryption: true });
  const { results } = await runBackups({ ...s, logger: silentLogger, filter: { db: 'HR' } });
  const noKey = { ...s.config, encryption: { enabled: false, keyEnv: 'BACKUP_ENCRYPTION_KEY' } };
  await assert.rejects(downloadBackup({ config: noKey, drive: s.drive, logger: silentLogger, fileId: results[0].fileId }), /set BACKUP_ENCRYPTION_KEY/);
});

test('latest requires --db and disambiguation across servers', async () => {
  const s = await setup();
  await assert.rejects(downloadBackup({ config: s.config, drive: s.drive, logger: silentLogger, latest: true }), /--db is required/);
  await assert.rejects(downloadBackup({ config: s.config, drive: s.drive, logger: silentLogger, latest: true, filter: { db: 'Sales' } }), /no backups found/);
});

test('retention runs after upload and keeps the newest N', async () => {
  const s = await setup({ retention: { keepLast: 2 } });
  let t = Date.parse('2026-11-16T00:00:00Z');
  const now = () => new Date((t += 60_000));
  for (let i = 0; i < 4; i++) await runBackups({ ...s, logger: silentLogger, filter: { db: 'Sales' }, now });
  const listed = await listBackups({ config: s.config, drive: s.drive, filter: { db: 'Sales' } });
  assert.equal(listed.length, 2);
});

test('missing local .bak gives an actionable error', async () => {
  const s = await setup();
  const srv = { ...s.config.servers[0], localBackupDir: path.join(s.dir, 'wrong') };
  const cfg = { ...s.config, servers: [srv] };
  const { results } = await runBackups({ ...s, config: cfg, logger: silentLogger, filter: { db: 'Sales' } });
  assert.match(results[0].error, /localBackupDir/);
});

test('corrupt upload (md5 mismatch) is deleted and reported', async () => {
  const s = await setup();
  const realUpload = s.drive.uploadResumable.bind(s.drive);
  s.drive.uploadResumable = async (o) => ({ ...(await realUpload(o)), md5Checksum: 'deadbeef' });
  const { results } = await runBackups({ ...s, logger: silentLogger, filter: { db: 'Sales' } });
  assert.match(results[0].error, /checksum mismatch/);
  assert.deepEqual(await listBackups({ config: s.config, drive: s.drive }), []);
});

test('a failed verify reports every SQL message (262 behind 3013) in the result', async () => {
  const s = await setup({ servers: [{ name: 'prod', host: 'h', user: 'u', password: 'p', databases: ['Sales'], backupDir: (await tmpDir()) }] });
  const createSqlClient = (server) => ({
    ...s.createSqlClient(server),
    async backup(db, serverPath) { await fs.writeFile(serverPath, 'x'); },
    async verify() {
      const e262 = Object.assign(new Error("CREATE DATABASE permission denied in database 'master'."), { number: 262 });
      throw Object.assign(new Error('VERIFY DATABASE is terminating abnormally.'), { number: 3013, precedingErrors: [e262] });
    },
  });
  const { results, failed } = await runBackups({ ...s, createSqlClient, logger: silentLogger });
  assert.equal(failed, 1);
  assert.equal(results[0].error,
    "Msg 262: CREATE DATABASE permission denied in database 'master'. | Msg 3013: VERIFY DATABASE is terminating abnormally.");
});
