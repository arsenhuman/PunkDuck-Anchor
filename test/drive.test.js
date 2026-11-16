import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DriveStore, escapeQuery } from '../src/drive.js';
import { createFakeDriveApi } from './fake-drive.js';
import { tmpDir } from './helpers.js';

const CHUNK = 256 * 1024;

test('escapeQuery escapes quotes and backslashes', () => {
  assert.equal(escapeQuery("it's a \\ test"), "it\\'s a \\\\ test");
});

test('rejects chunk sizes that are not multiples of 256 KiB', () => {
  assert.throws(() => new DriveStore({ request() {}, chunkSize: 1000 }), /256 KiB/);
});

test('ensurePath creates folders once and reuses existing ones', async () => {
  const api = createFakeDriveApi();
  const d1 = new DriveStore({ request: api.request });
  const id = await d1.ensurePath(['Root', "O'Brien", 'db']);
  const d2 = new DriveStore({ request: api.request }); // fresh cache: must find, not create
  assert.equal(await d2.ensurePath(['Root', "O'Brien", 'db']), id);
  assert.equal([...api.files.values()].length, 3);
  assert.equal(await d2.resolvePath(['Root', 'missing']), null);
});

test('chunked resumable upload, list, download, delete', async () => {
  const api = createFakeDriveApi();
  const drive = new DriveStore({ request: api.request, chunkSize: CHUNK });
  const dir = await tmpDir();
  const src = path.join(dir, 'f');
  const data = crypto.randomBytes(CHUNK * 2 + 123);
  await fs.writeFile(src, data);
  const folder = await drive.ensurePath(['R']);
  const f = await drive.uploadResumable({ filePath: src, name: 'f.bak', parentId: folder, appProperties: { sha256: 'x' } });
  assert.equal(Number(f.size), data.length);
  assert.equal(f.appProperties.bmApp, 'backup-manager');
  const puts = api.calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 3);
  assert.equal(puts[0].headers['Content-Range'], `bytes 0-${CHUNK - 1}/${data.length}`);

  // a file without our tag is ignored by listBackups
  api.add({ name: 'other', mimeType: 'text/plain', parents: [folder] }, Buffer.from('x'));
  const listed = await drive.listBackups(folder);
  assert.deepEqual(listed.map((x) => x.id), [f.id]);

  const out = path.join(dir, 'dl');
  await drive.download(f.id, out);
  assert.ok(data.equals(await fs.readFile(out)));

  await drive.deleteFile(f.id);
  assert.deepEqual(await drive.listBackups(folder), []);
});

test('upload resumes from server offset after transient failures', async () => {
  const api = createFakeDriveApi({ failChunkTimes: 2 });
  const drive = new DriveStore({ request: api.request, chunkSize: CHUNK, retryDelayMs: 1 });
  const dir = await tmpDir();
  const src = path.join(dir, 'f');
  const data = crypto.randomBytes(CHUNK * 3);
  await fs.writeFile(src, data);
  const f = await drive.uploadResumable({ filePath: src, name: 'f', parentId: 'root' });
  const stored = api.files.get(f.id).data;
  assert.ok(data.equals(stored));
  assert.ok(api.calls.some((c) => c.headers?.['Content-Range'] === `bytes */${data.length}`), 'status query was made');
});

test('upload gives up after maxRetries', async () => {
  const api = createFakeDriveApi({ failChunkTimes: 100 });
  const drive = new DriveStore({ request: api.request, chunkSize: CHUNK, retryDelayMs: 1, maxRetries: 2 });
  const dir = await tmpDir();
  const src = path.join(dir, 'f');
  await fs.writeFile(src, Buffer.alloc(10));
  await assert.rejects(drive.uploadResumable({ filePath: src, name: 'f', parentId: 'root' }), /HTTP 503/);
});

test('non-retryable errors are not retried', async () => {
  let n = 0;
  const drive = new DriveStore({
    retryDelayMs: 1,
    request: async () => {
      n++;
      throw Object.assign(new Error('forbidden'), { response: { status: 403 } });
    },
  });
  await assert.rejects(drive.deleteFile('x'), /forbidden/);
  assert.equal(n, 1);
});
