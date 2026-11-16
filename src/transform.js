// Streaming gzip + segmented AES-256-GCM encryption, and the reverse.
//
// Encrypted file layout (STREAM construction, no size limit in practice):
//   MAGIC(6) | NONCE_PREFIX(7) | segment_0 | segment_1 | ... | segment_last
// Each segment is AES-256-GCM(plaintext[SEGMENT_SIZE]) || TAG(16); the last one may be shorter
// (even empty). The 12-byte IV of segment i is NONCE_PREFIX | uint32be(i) | lastFlag, and the
// file header is authenticated as AAD. Reordering, truncation and tampering are all detected.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

export const MAGIC = Buffer.from('BMENC2');
export const SEGMENT_SIZE = 1024 * 1024;
const PREFIX_LEN = 7;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + PREFIX_LEN;
const MAX_SEGMENTS = 2 ** 32 - 1;

function segmentIv(prefix, index, last) {
  if (index > MAX_SEGMENTS) throw new Error('backup too large for encryption format');
  const iv = Buffer.alloc(12);
  prefix.copy(iv, 0);
  iv.writeUInt32BE(index, PREFIX_LEN);
  iv[11] = last ? 1 : 0;
  return iv;
}

export function createEncryptStream(key, { segmentSize = SEGMENT_SIZE } = {}) {
  const prefix = crypto.randomBytes(PREFIX_LEN);
  const header = Buffer.concat([MAGIC, prefix]);
  let pending = Buffer.alloc(0);
  let index = 0;
  let headerSent = false;

  const seal = (plain, last) => {
    const c = crypto.createCipheriv('aes-256-gcm', key, segmentIv(prefix, index++, last));
    c.setAAD(header);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        if (!headerSent) {
          this.push(header);
          headerSent = true;
        }
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        // Emit a non-final segment only when more data is known to follow it.
        let off = 0;
        while (pending.length - off > segmentSize) {
          this.push(seal(pending.subarray(off, off + segmentSize), false));
          off += segmentSize;
        }
        pending = pending.subarray(off);
        cb();
      } catch (err) {
        cb(err);
      }
    },
    flush(cb) {
      try {
        if (!headerSent) this.push(header);
        this.push(seal(pending, true));
        cb();
      } catch (err) {
        cb(err);
      }
    },
  });
}

export function createDecryptStream(key, { segmentSize = SEGMENT_SIZE } = {}) {
  const sealedSize = segmentSize + TAG_LEN;
  let header = null;
  let prefix;
  let pending = Buffer.alloc(0);
  let index = 0;

  const open = (sealed, last) => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, segmentIv(prefix, index++, last));
    d.setAAD(header);
    d.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
    try {
      return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_LEN)), d.final()]);
    } catch {
      throw new Error('decryption failed: wrong key or corrupted file');
    }
  };

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        if (!header) {
          if (pending.length < HEADER_LEN) return cb();
          if (!pending.subarray(0, MAGIC.length).equals(MAGIC)) {
            return cb(new Error('not an encrypted backup (bad header)'));
          }
          header = Buffer.from(pending.subarray(0, HEADER_LEN));
          prefix = header.subarray(MAGIC.length);
          pending = pending.subarray(HEADER_LEN);
        }
        // Keep at least one segment buffered: we only know it is the last one at flush.
        let off = 0;
        while (pending.length - off > sealedSize) {
          this.push(open(pending.subarray(off, off + sealedSize), false));
          off += sealedSize;
        }
        pending = pending.subarray(off);
        cb();
      } catch (err) {
        cb(err);
      }
    },
    flush(cb) {
      try {
        if (!header || pending.length < TAG_LEN) throw new Error('encrypted backup is truncated');
        this.push(open(pending, true));
        cb();
      } catch (err) {
        cb(err);
      }
    },
  });
}

/** Pass-through that computes SHA-256 and MD5 of everything flowing through it. */
export function createHashStream() {
  const sha = crypto.createHash('sha256');
  const md5 = crypto.createHash('md5');
  let result;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      sha.update(chunk);
      md5.update(chunk);
      cb(null, chunk);
    },
  });
  t.digests = () => (result ??= { sha256: sha.digest('hex'), md5: md5.digest('hex') });
  return t;
}

/** src (.bak) -> [gzip] -> [encrypt] -> dest. Returns sha256, md5 and size of dest. */
export async function packFile(src, dest, { compress, key }) {
  const stages = [fs.createReadStream(src)];
  if (compress) stages.push(zlib.createGzip({ level: 6 }));
  if (key) stages.push(createEncryptStream(key));
  const hasher = createHashStream();
  stages.push(hasher, fs.createWriteStream(dest, { mode: 0o600 }));
  await pipeline(stages);
  const { size } = await fs.promises.stat(dest);
  return { ...hasher.digests(), size };
}

/** Reverse of packFile. */
export async function unpackFile(src, dest, { compressed, encrypted, key }) {
  if (encrypted && !key) throw new Error('backup is encrypted: set the encryption key to download it');
  const stages = [fs.createReadStream(src)];
  if (encrypted) stages.push(createDecryptStream(key));
  if (compressed) stages.push(zlib.createGunzip());
  stages.push(fs.createWriteStream(dest, { mode: 0o600 }));
  await pipeline(stages);
}

/** Returns { sha256, md5, size } of a file. */
export async function hashFile(file) {
  const sha = crypto.createHash('sha256');
  const md5 = crypto.createHash('md5');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    sha.update(chunk);
    md5.update(chunk);
    size += chunk.length;
  }
  return { sha256: sha.digest('hex'), md5: md5.digest('hex'), size };
}
