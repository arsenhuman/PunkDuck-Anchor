import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashFile, MAGIC, packFile, unpackFile } from '../src/transform.js';
import { tmpDir } from './helpers.js';

const key = crypto.randomBytes(32);

async function setup(size = 3 * 1024 * 1024 + 17) {
  const dir = await tmpDir();
  const src = path.join(dir, 'db.bak');
  // compressible but not trivial content
  const data = Buffer.concat([crypto.randomBytes(size / 2 | 0), Buffer.alloc(size - (size / 2 | 0), 'A')]);
  await fs.writeFile(src, data);
  return { dir, src, data };
}

for (const [compress, useKey] of [[true, true], [true, false], [false, true]]) {
  test(`pack/unpack round-trip compress=${compress} encrypt=${useKey}`, async () => {
    const { dir, src, data } = await setup();
    const packed = path.join(dir, 'p');
    const info = await packFile(src, packed, { compress, key: useKey ? key : undefined });
    const h = await hashFile(packed);
    assert.equal(info.sha256, h.sha256);
    assert.equal(info.md5, h.md5);
    assert.equal(info.size, h.size);
    if (useKey) assert.ok((await fs.readFile(packed)).subarray(0, MAGIC.length).equals(MAGIC));
    const out = path.join(dir, 'out.bak');
    await unpackFile(packed, out, { compressed: compress, encrypted: useKey, key: useKey ? key : undefined });
    assert.ok(data.equals(await fs.readFile(out)));
    const st = await fs.stat(packed);
    if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600); // Windows: ACLs set by install.ps1
  });
}

test('empty input round-trips through encryption', async () => {
  const { dir, src } = await setup(0);
  await packFile(src, path.join(dir, 'p'), { compress: false, key });
  await unpackFile(path.join(dir, 'p'), path.join(dir, 'o'), { compressed: false, encrypted: true, key });
  assert.equal((await fs.readFile(path.join(dir, 'o'))).length, 0);
});

test('wrong key, tampering and truncation are detected', async () => {
  const { dir, src } = await setup(100_000);
  const packed = path.join(dir, 'p');
  await packFile(src, packed, { compress: true, key });
  const out = path.join(dir, 'o');
  await assert.rejects(unpackFile(packed, out, { compressed: true, encrypted: true, key: crypto.randomBytes(32) }), /wrong key or corrupted/);

  const buf = await fs.readFile(packed);
  const tampered = Buffer.from(buf);
  tampered[40] ^= 1;
  await fs.writeFile(packed, tampered);
  await assert.rejects(unpackFile(packed, out, { compressed: false, encrypted: true, key }), /wrong key or corrupted/);

  await fs.writeFile(packed, buf.subarray(0, 10));
  await assert.rejects(unpackFile(packed, out, { compressed: false, encrypted: true, key }), /truncated/);

  await fs.writeFile(packed, Buffer.alloc(64));
  await assert.rejects(unpackFile(packed, out, { compressed: false, encrypted: true, key }), /bad header/);
});

test('unpack of encrypted file without key fails fast', async () => {
  await assert.rejects(unpackFile('x', 'y', { encrypted: true }), /encryption key/);
});
