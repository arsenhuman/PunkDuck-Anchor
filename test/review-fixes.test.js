// Regression tests for issues found in code review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logout, readToken, startLoopbackServer } from '../src/auth.js';
import { downloadBackup, runBackups } from '../src/backup.js';
import { normalizeConfig } from '../src/config.js';
import { DriveStore, isRetryable } from '../src/drive.js';
import { silentLogger } from '../src/logger.js';
import { createDecryptStream, createEncryptStream } from '../src/transform.js';
import { createFakeDriveApi } from './fake-drive.js';
import { baseRawConfig, ENV, tmpDir } from './helpers.js';

// ---- config booleans
test('booleans accept true/false strings (env refs) and reject anything else', () => {
  const key = crypto.randomBytes(32).toString('base64');
  const env = { ...ENV, ENC: 'true', BACKUP_ENCRYPTION_KEY: key };
  let c = normalizeConfig(baseRawConfig({ encryption: { enabled: 'env:ENC' }, compression: 'false' }), { env });
  assert.equal(c.encryption.enabled, true);
  assert.equal(c.compression, false);
  for (const bad of ['yes', 1, 'TRUE ', null]) {
    assert.throws(() => normalizeConfig(baseRawConfig({ encryption: { enabled: bad } }), { env }), /encryption.enabled must be true or false/);
  }
  assert.throws(() => normalizeConfig(baseRawConfig({ compression: 'no' }), { env }), /compression must be true or false/);
});

// ---- segmented encryption
const SEG = 64;
async function enc(key, data) {
  const parts = [];
  await pipeline(Readable.from(chunks(data)), createEncryptStream(key, { segmentSize: SEG }), async function* (src) {
    for await (const c of src) parts.push(c);
  });
  return Buffer.concat(parts);
}
async function dec(key, data) {
  const parts = [];
  await pipeline(Readable.from(chunks(data)), createDecryptStream(key, { segmentSize: SEG }), async function* (src) {
    for await (const c of src) parts.push(c);
  });
  return Buffer.concat(parts);
}
function* chunks(buf) {
  // irregular chunk sizes to exercise buffering
  let i = 0;
  let n = 1;
  while (i < buf.length) {
    yield buf.subarray(i, i + n);
    i += n;
    n = (n * 7) % 97 + 1;
  }
}

test('segmented encryption round-trips at and around segment boundaries', async () => {
  const key = crypto.randomBytes(32);
  for (const len of [0, 1, SEG - 1, SEG, SEG + 1, 3 * SEG, 3 * SEG + 5]) {
    const data = crypto.randomBytes(len);
    const ct = await enc(key, data);
    const segments = Math.max(1, Math.ceil(len / SEG));
    assert.equal(ct.length, 13 + segments * 16 + len, `len=${len}`);
    assert.ok(data.equals(await dec(key, ct)), `len=${len}`);
  }
});

test('dropping, reordering or truncating segments is detected', async () => {
  const key = crypto.randomBytes(32);
  const data = crypto.randomBytes(3 * SEG + 10);
  const ct = await enc(key, data);
  const H = 13;
  const S = SEG + 16;
  const seg = (i) => ct.subarray(H + i * S, Math.min(H + (i + 1) * S, ct.length));
  const head = ct.subarray(0, H);
  // truncation exactly at a segment boundary (drop final segment)
  await assert.rejects(dec(key, Buffer.concat([head, seg(0), seg(1), seg(2)])), /wrong key or corrupted/);
  // drop a middle segment
  await assert.rejects(dec(key, Buffer.concat([head, seg(0), seg(2), seg(3)])), /wrong key or corrupted/);
  // swap two segments
  await assert.rejects(dec(key, Buffer.concat([head, seg(1), seg(0), seg(2), seg(3)])), /wrong key or corrupted/);
  // header-only file
  await assert.rejects(dec(key, head), /truncated/);
});

// ---- retention failure does not fail the backup
async function backupSetup() {
  const dir = await tmpDir();
  const backupDir = path.join(dir, 'b');
  await fs.mkdir(backupDir);
  const config = normalizeConfig({
    google: { clientId: 'c', clientSecret: 's' },
    workDir: path.join(dir, 'w'),
    retention: { keepLast: 1 },
    servers: [{ name: 'p', host: 'h', user: 'u', password: 'p', databases: ['Sales'], backupDir }],
  }, { env: {} });
  const api = createFakeDriveApi();
  const drive = new DriveStore({ request: api.request, retryDelayMs: 1 });
  const data = crypto.randomBytes(1000);
  const createSqlClient = () => ({
    async connect() {}, async close() {}, async assertDatabaseOnline() {}, async verify() {},
    async backup(_db, p) { await fs.writeFile(p, data); },
  });
  return { dir, config, api, drive, createSqlClient, data };
}

test('retention errors are reported as warnings, backup stays OK', async () => {
  const s = await backupSetup();
  s.drive.listBackups = async () => { throw new Error('drive list exploded'); };
  const { results, failed } = await runBackups({ ...s, logger: silentLogger });
  assert.equal(failed, 0);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].retentionError, 'drive list exploded');
});

test('download refuses to overwrite without force, and rejects unsafe names', async () => {
  const s = await backupSetup();
  const { results } = await runBackups({ ...s, logger: silentLogger });
  const out = path.join(s.dir, 'out');
  const args = { config: s.config, drive: s.drive, logger: silentLogger, fileId: results[0].fileId, outDir: out };
  await downloadBackup(args);
  await assert.rejects(downloadBackup(args), /already exists \(use --force/);
  const r = await downloadBackup({ ...args, force: true });
  assert.ok(s.data.equals(await fs.readFile(r.dest)));

  // (path components are stripped by basename, so '../x.bak.gz' safely becomes 'x.bak')
  for (const name of ['..', '.bak.gz', 'x y.bak.gz', 'sub/..']) {
    s.api.files.get(results[0].fileId).name = name;
    await assert.rejects(downloadBackup({ ...args, force: true }), /unsafe backup file name/, name);
  }
});

// ---- OAuth loopback with multibyte state must not crash
test('loopback server rejects multibyte state of equal char length without crashing', async () => {
  const expected = 'a'.repeat(32);
  const { redirectUri, code } = await startLoopbackServer({ expectedState: expected });
  const rejected = assert.rejects(code, /state mismatch/);
  const res = await fetch(`${redirectUri}/?state=${encodeURIComponent('é'.repeat(32))}&code=x`);
  assert.equal(res.status, 400);
  await rejected;
});

test('logout removes a corrupt token file', async () => {
  const dir = await tmpDir();
  const tokenFile = path.join(dir, 't.json');
  await fs.writeFile(tokenFile, '{corrupt');
  assert.deepEqual(await logout({ clientId: 'c', clientSecret: 's', tokenFile }), { removed: true, revoked: false });
  assert.equal(await readToken(tokenFile), null);
});

// ---- retry classification
test('isRetryable: rate-limit 403 and network errors yes; other 4xx and bugs no', () => {
  const http = (status, reason) => ({ response: { status, data: reason ? { error: { errors: [{ reason }] } } : undefined } });
  assert.equal(isRetryable(http(429)), true);
  assert.equal(isRetryable(http(503)), true);
  assert.equal(isRetryable(http(403, 'userRateLimitExceeded')), true);
  assert.equal(isRetryable(http(403, 'rateLimitExceeded')), true);
  assert.equal(isRetryable(http(403, 'insufficientPermissions')), false);
  assert.equal(isRetryable(http(403)), false);
  assert.equal(isRetryable(http(400)), false);
  assert.equal(isRetryable(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
  assert.equal(isRetryable(new TypeError('cannot read property')), false);
});

test('upload aborts when the server keeps making no progress', async () => {
  const dir = await tmpDir();
  const src = path.join(dir, 'f');
  await fs.writeFile(src, Buffer.alloc(300 * 1024));
  let puts = 0;
  const drive = new DriveStore({
    chunkSize: 256 * 1024,
    maxRetries: 3,
    retryDelayMs: 1,
    request: async (o) => {
      if (o.method === 'POST') return { status: 200, data: {}, headers: { location: 'https://upload.example/s' } };
      puts++;
      return { status: 308, data: undefined, headers: {} }; // never stores anything
    },
  });
  await assert.rejects(drive.uploadResumable({ filePath: src, name: 'f', parentId: 'root' }), /no progress/);
  assert.ok(puts <= 5, `stopped after ${puts} PUTs`);
});
